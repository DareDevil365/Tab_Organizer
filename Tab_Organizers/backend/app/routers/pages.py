import base64
import datetime
from typing import List, Optional
from urllib.parse import urlparse
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, func, delete, update
from sqlalchemy.orm import defer

from app.database import get_db
from app.config import settings
from app.models.page import Page
from app.models.companion import CompanionNote
from app.models.embedding import PageEmbedding
from app.models.tab_group import PageGroupLink
from app.models.activity import ActivityLog
from app.models.reminder import Reminder
from app.schemas.page import PageCreate, PageUpdate, PageResponse, BulkSaveRequest, BulkSaveResponse, CompletionUpdate, BulkCompletionUpdate
from app.services.completion import completion_kind
from app.services.content_subjects import subject_path, library_subjects
from app.services.video_metadata import resolve_video_title, generic_title
from app.services.url_normalizer import normalize_url, extract_youtube_thumbnail
from app.services.classifier import classify_single_page_rule, run_background_classification, suggest_page_tags

router = APIRouter(prefix="/api/pages", tags=["pages"])


async def _remove_page(db: AsyncSession, page: Page):
    # Remove owned records atomically. Otherwise startup's legacy-note repair
    # recreates a page that the user deliberately deleted.
    from app.services.recycle_bin import archive_page
    note_ids,recycle_id = await archive_page(db, page)
    await db.execute(delete(CompanionNote).where(CompanionNote.id.in_(note_ids)))
    await db.execute(delete(PageEmbedding).where(PageEmbedding.page_id == page.id))
    await db.execute(delete(PageGroupLink).where(PageGroupLink.page_id == page.id))
    await db.execute(delete(Reminder).where(Reminder.page_id == page.id))
    await db.execute(update(ActivityLog).where(ActivityLog.page_id == page.id).values(page_id=None))
    await db.delete(page)
    await db.commit()
    return recycle_id


def _format_page(page: Page, note_count: int = 0) -> PageResponse:
    domain = page.domain or (urlparse(page.url_original).netloc.replace('www.', '') if page.url_original else '')
    yt_thumb = extract_youtube_thumbnail(page.url_original)

    img_data_str = None
    if page.og_image_data:
        mime = page.og_image_mime or 'image/jpeg'
        img_data_str = f"data:{mime};base64,{base64.b64encode(page.og_image_data).decode('utf-8')}"

    fav_icon = page.favicon_url or (f"https://www.google.com/s2/favicons?domain={domain}&sz=64" if domain else None)

    return PageResponse(
        id=page.id,
        display_topic=subject_path(page)[-1] if subject_path(page) != ('Needs a Topic',) else None,
        subject_topics=library_subjects(page),
        note_count=note_count,
        completed_at=(page.completed_at.replace(tzinfo=datetime.timezone.utc) if page.completed_at and page.completed_at.tzinfo is None else page.completed_at),
        completion_kind=completion_kind(page),
        url_original=page.url_original,
        url_normalized=page.url_normalized,
        title=page.title or domain or "Untitled",
        description=page.description,
        favicon_url=fav_icon,
        og_image_url=yt_thumb,
        og_image_data=img_data_str,
        og_image_mime=page.og_image_mime,
        domain=domain,
        category=page.category,
        topic=page.topic,
        content_summary=page.content_summary,
        tags=page.tags,
        is_important=page.is_important,
        is_urgent=page.is_urgent,
        created_at=page.created_at,
        updated_at=page.updated_at,
        last_seen_open_at=page.last_seen_open_at,
    )


@router.post("", response_model=PageResponse, status_code=status.HTTP_200_OK)
async def upsert_page(
    page_in: PageCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    """
    Creates or updates a page using url_normalized as the strict deduplication key.
    If the page already exists, its metadata is updated in place.
    """
    norm_url = page_in.url_normalized or normalize_url(page_in.url_original)
    if not norm_url:
        raise HTTPException(status_code=400, detail="Invalid URL")

    domain = page_in.domain
    page_in.title = await resolve_video_title(page_in.url_original, page_in.title)
    if not domain and page_in.url_original:
        domain = urlparse(page_in.url_original).netloc

    now = datetime.datetime.now(datetime.timezone.utc)
    needs_bg_classification = False

    # Check for existing record
    stmt = select(Page).where(Page.url_normalized == norm_url)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()

    if page:
        # Update existing
        if page_in.title and (not generic_title(page_in.title,page_in.url_original) or generic_title(page.title,page.url_original)):
            page.title = page_in.title
        if page_in.description:
            page.description = page_in.description
        if page_in.favicon_url:
            page.favicon_url = page_in.favicon_url
        if page_in.category:
            page.category = page_in.category
        if page_in.topic:
            page.topic = page_in.topic
        if page_in.content_summary:
            page.content_summary = page_in.content_summary
        if page_in.full_text:
            page.full_text = page_in.full_text
        if page_in.tags:
            page.tags = page_in.tags
        page.is_important = page_in.is_important
        page.is_urgent = page_in.is_urgent
        page.updated_at = now
        page.last_seen_open_at = now
    else:
        # Create new
        page = Page(
            url_original=page_in.url_original,
            url_normalized=norm_url,
            title=page_in.title or domain or "Untitled",
            description=page_in.description,
            favicon_url=page_in.favicon_url,
            domain=domain,
            category=page_in.category,
            topic=page_in.topic,
            content_summary=page_in.content_summary,
            full_text=page_in.full_text,
            tags=page_in.tags,
            is_important=page_in.is_important,
            is_urgent=page_in.is_urgent,
            created_at=now,
            updated_at=now,
            last_seen_open_at=now,
        )
        db.add(page)

    # Auto-classify topic if not explicitly set
    if not page.topic or page.topic.lower() in ('other', 'none', 'unknown', 'uncategorized'):
        rule_topic = classify_single_page_rule({
            "title": page.title,
            "url": page.url_original or page.url_normalized,
            "description": page.description,
            "domain": page.domain,
            "tags": page.tags
        })
        if rule_topic:
            page.topic = rule_topic
        else:
            needs_bg_classification = True

    # Suggest keyword tags if not already populated
    if not page.tags:
        sug_tags = suggest_page_tags({
            "title": page.title,
            "url": page.url_original or page.url_normalized,
            "description": page.description,
            "domain": page.domain
        })
        if sug_tags:
            page.tags = ", ".join(sug_tags)

    await db.commit()
    await db.refresh(page)

    if needs_bg_classification and not settings.cloud:
        background_tasks.add_task(run_background_classification, batch_size=10, limit=20)

    return _format_page(page)


@router.post("/save-bulk", response_model=BulkSaveResponse)
async def bulk_save_pages(
    payload: BulkSaveRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db)
):
    """
    Saves multiple tabs in bulk.
    - If a tab is already saved, its metadata and timestamp are refreshed.
    - If an existing tab lacks a classified topic, rules are evaluated.
    - If a tab is new, it is inserted and automatically classified.
    - Triggers async background classification for any remaining unclassified tabs.
    - Returns exact counts of new tabs saved vs already existing tabs.
    """
    if not payload.tabs:
        raise HTTPException(status_code=400, detail="No tabs provided")

    now = datetime.datetime.now(datetime.timezone.utc)
    new_count = 0
    updated_count = 0
    needs_bg_classification = False

    # Bound optional title enrichment for the entire batch. Serial oEmbed
    # lookups used to make a large save exceed the device's upload timeout.
    import asyncio
    gate=asyncio.Semaphore(4)
    async def enrich_title(tab):
        async with gate: tab.title=await resolve_video_title(tab.url_original,tab.title)
    tasks=[asyncio.create_task(enrich_title(tab)) for tab in payload.tabs if generic_title(tab.title,tab.url_original)]
    if tasks:
        _,pending=await asyncio.wait(tasks,timeout=6)
        for task in pending: task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
    for tab_in in payload.tabs:
        if not tab_in.url_original or not tab_in.url_original.startswith("http"):
            continue

        norm_url = tab_in.url_normalized or normalize_url(tab_in.url_original)
        domain = tab_in.domain
        if not domain and tab_in.url_original:
            domain = urlparse(tab_in.url_original).netloc

        stmt = select(Page).where(Page.url_normalized == norm_url)
        res = await db.execute(stmt)
        existing = res.scalar_one_or_none()

        fav_icon = tab_in.favicon_url or (f"https://www.google.com/s2/favicons?domain={domain}&sz=64" if domain else None)

        if existing:
            # Already saved in library -> refresh metadata and timestamp
            if tab_in.title and generic_title(existing.title,existing.url_original):
                existing.title = tab_in.title
            if tab_in.description and not existing.description:
                existing.description = tab_in.description
            if fav_icon and not existing.favicon_url:
                existing.favicon_url = fav_icon

            # Re-evaluate topic for existing tab if it was unclassified or 'other'
            if not existing.topic or existing.topic.lower() in ('other', 'none', 'unknown', 'uncategorized'):
                rule_topic = classify_single_page_rule({
                    "title": existing.title or tab_in.title,
                    "url": existing.url_original,
                    "description": existing.description or tab_in.description,
                    "domain": existing.domain or domain,
                    "tags": existing.tags or tab_in.tags
                })
                if rule_topic:
                    existing.topic = rule_topic
                else:
                    needs_bg_classification = True

            # Populate tags if empty
            if not existing.tags:
                sug_tags = suggest_page_tags({
                    "title": existing.title or tab_in.title,
                    "url": existing.url_original,
                    "description": existing.description or tab_in.description,
                    "domain": existing.domain or domain
                })
                if sug_tags:
                    existing.tags = ", ".join(sug_tags)

            existing.last_seen_open_at = now
            existing.updated_at = now
            updated_count += 1
        else:
            # Brand new page -> insert into database
            new_page = Page(
                url_original=tab_in.url_original,
                url_normalized=norm_url,
                title=tab_in.title or domain or "Untitled",
                description=tab_in.description,
                favicon_url=fav_icon,
                domain=domain,
                category=tab_in.category,
                topic=tab_in.topic,
                content_summary=tab_in.content_summary,
                tags=tab_in.tags,
                is_important=tab_in.is_important,
                is_urgent=tab_in.is_urgent,
                created_at=now,
                updated_at=now,
                last_seen_open_at=now,
            )

            # Auto-classify topic with rule engine
            rule_topic = classify_single_page_rule({
                "title": new_page.title,
                "url": new_page.url_original,
                "description": new_page.description,
                "domain": new_page.domain,
                "tags": new_page.tags
            })
            if rule_topic:
                new_page.topic = rule_topic
            else:
                needs_bg_classification = True

            # Populate tags if empty
            if not new_page.tags:
                sug_tags = suggest_page_tags({
                    "title": new_page.title,
                    "url": new_page.url_original,
                    "description": new_page.description,
                    "domain": new_page.domain
                })
                if sug_tags:
                    new_page.tags = ", ".join(sug_tags)

            db.add(new_page)
            new_count += 1

    await db.commit()

    if needs_bg_classification and not settings.cloud:
        background_tasks.add_task(run_background_classification, batch_size=15, limit=50)

    if new_count > 0:
        msg = f"✓ Saved {new_count} new tabs to your library! ({updated_count} already saved tabs up to date)"
    elif updated_count > 0:
        msg = f"All {updated_count} tabs are already saved in your library and up to date!"
    else:
        msg = "No new tabs to save."

    saved=(await db.execute(select(Page).where(Page.url_normalized.in_([
        tab.url_normalized or normalize_url(tab.url_original) for tab in payload.tabs if tab.url_original.startswith('http')
    ])))).scalars().all()
    return BulkSaveResponse(
        saved_pages=[{'id':page.id,'url_original':page.url_original,'url_normalized':page.url_normalized,
                      'title':page.title,'description':page.description or '', 'favicon_url':page.favicon_url or '',
                      'domain':page.domain,'created_at':page.created_at} for page in saved],
        total_submitted=len(payload.tabs),
        new_saved_count=new_count,
        updated_count=updated_count,
        message=msg
    )


@router.get('/saved-status')
async def saved_status(db: AsyncSession = Depends(get_db)):
    """Small uncapped URL/topic index for live tabs; no images or model work."""
    pages = (await db.execute(select(Page).options(defer(Page.og_image_data)))).scalars().all()
    from app.services.graph_service import cached_topic_metadata
    topics = await cached_topic_metadata(pages)
    return [{'url_original': page.url_original, 'url_normalized': page.url_normalized,
             'display_topic': topics.get(page.id, {}).get('display_topic') or
                (subject_path(page)[-1] if subject_path(page) != ('Needs a Topic',) else None)} for page in pages]


@router.get("", response_model=List[PageResponse])
async def list_pages(
    domain: Optional[str] = None,
    category: Optional[str] = None,
    topic: Optional[str] = None,
    search: Optional[str] = None,
    is_important: Optional[bool] = None,
    is_urgent: Optional[bool] = None,
    has_notes: Optional[bool] = None,
    completed: Optional[bool] = None,
    limit: int = Query(default=100, le=5000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db)
):
    """Lists saved pages with optional filtering, search, and pagination."""
    counts = select(CompanionNote.page_id.label('page_id'), func.count(CompanionNote.id).label('note_count')).group_by(CompanionNote.page_id).subquery()
    # Bulk imports share timestamps. A unique tie-breaker keeps LIMIT/OFFSET
    # pages disjoint on PostgreSQL, where equal timestamps have no stable order.
    query = select(Page, func.coalesce(counts.c.note_count, 0)).outerjoin(counts, counts.c.page_id == Page.id).order_by(Page.created_at.desc(),Page.id.desc())
    if completed is not None:
        query = query.where(Page.completed_at.is_not(None) if completed else Page.completed_at.is_(None))
    if has_notes is True:
        query = query.where(counts.c.note_count > 0)
    elif has_notes is False:
        query = query.where(func.coalesce(counts.c.note_count, 0) == 0)

    if domain:
        query = query.where(Page.domain == domain)
    if category:
        query = query.where(Page.category == category)
    if topic:
        query = query.where(Page.topic == topic)
    if is_important is not None:
        query = query.where(Page.is_important == is_important)
    if is_urgent is not None:
        query = query.where(Page.is_urgent == is_urgent)
    if search:
        search_pattern = f"%{search.strip()}%"
        query = query.where(
            or_(
                Page.title.ilike(search_pattern),
                Page.description.ilike(search_pattern),
                Page.domain.ilike(search_pattern),
                Page.url_normalized.ilike(search_pattern),
                Page.tags.ilike(search_pattern),
            )
        )

    query = query.limit(limit).offset(offset)
    res = await db.execute(query)
    rows=res.all()
    from app.services.graph_service import cached_topic_metadata
    topics=await cached_topic_metadata([page for page, _ in rows])
    return [_format_page(page,count).model_copy(update=topics.get(page.id,{})) for page,count in rows]


@router.put('/completion', response_model=List[PageResponse])
async def set_completion_bulk(payload: BulkCompletionUpdate, db: AsyncSession = Depends(get_db)):
    ids = list(dict.fromkeys(payload.page_ids))
    found = (await db.execute(select(Page.id).where(Page.id.in_(ids)))).scalars().all()
    if len(found) != len(ids):
        raise HTTPException(status_code=404, detail='One or more selected resources no longer exist')
    now = datetime.datetime.now(datetime.timezone.utc)
    query = update(Page).where(Page.id.in_(ids))
    if payload.completed:
        # Idempotent: retries cannot advance completion dates or inflate counts.
        query = query.where(Page.completed_at.is_(None))
    await db.execute(query.values(completed_at=now if payload.completed else None))
    await db.commit()
    pages = (await db.execute(select(Page).where(Page.id.in_(ids)).execution_options(populate_existing=True))).scalars().all()
    counts = dict((await db.execute(select(CompanionNote.page_id, func.count(CompanionNote.id)).where(CompanionNote.page_id.in_(ids)).group_by(CompanionNote.page_id))).all())
    return [_format_page(page, counts.get(page.id, 0)) for page in pages]


@router.put('/{page_id}/completion', response_model=PageResponse)
async def set_completion(page_id: int, payload: CompletionUpdate, db: AsyncSession = Depends(get_db)):
    pages = await set_completion_bulk(BulkCompletionUpdate(page_ids=[page_id], completed=payload.completed), db)
    return pages[0]


@router.get("/{page_id}", response_model=PageResponse)
async def get_page(page_id: int, db: AsyncSession = Depends(get_db)):
    """Retrieves a single page by its ID."""
    stmt = select(Page).where(Page.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    note_count = (await db.execute(select(func.count(CompanionNote.id)).where(CompanionNote.page_id == page.id))).scalar_one()
    from app.services.graph_service import cached_topic_metadata
    topics=await cached_topic_metadata([page])
    return _format_page(page,note_count).model_copy(update=topics.get(page.id,{}))


@router.put("/{page_id}", response_model=PageResponse)
async def update_page(page_id: int, page_in: PageUpdate, db: AsyncSession = Depends(get_db)):
    """Updates an existing page's metadata."""
    stmt = select(Page).where(Page.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    update_data = page_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(page, key, value)

    page.updated_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    await db.refresh(page)
    return _format_page(page)


@router.delete("/by-url", status_code=status.HTTP_200_OK)
async def delete_page_by_url(url: str = Query(...), db: AsyncSession = Depends(get_db)):
    """Deletes a page from the library using its original or normalized URL."""
    norm_url = normalize_url(url)
    stmt = select(Page).where(or_(Page.url_normalized == norm_url, Page.url_original == url))
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        return {"status": "not_found", "message": "Page was not in library"}

    recycle_id=await _remove_page(db, page)
    return {"status": "deleted", "message": "Page removed from library", "recycle_id":recycle_id}


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_page(page_id: int, db: AsyncSession = Depends(get_db)):
    """Deletes a page from the database."""
    stmt = select(Page).where(Page.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    recycle_id=await _remove_page(db, page)
    return Response(status_code=204,headers={'X-Recycle-Id':recycle_id})
