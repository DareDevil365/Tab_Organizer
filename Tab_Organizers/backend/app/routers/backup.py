import datetime
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.database import get_db
from app.models.page import Page
from app.models.tab_group import TabGroup
from app.models.activity import ActivityLog
from app.models.reminder import Reminder

router = APIRouter(prefix="/api/backup", tags=["backup"])


class BackupData(BaseModel):
    version: str = "1.0"
    exported_at: datetime.datetime
    pages: List[Dict[str, Any]]
    tab_groups: List[Dict[str, Any]]
    reminders: List[Dict[str, Any]]
    activities: Optional[List[Dict[str, Any]]] = None


@router.get("/export")
async def export_database(
    include_activity: bool = True,
    db: AsyncSession = Depends(get_db)
):
    """
    Exports the complete local database content as a portable JSON object
    for backup, migration, and full user data ownership.
    """
    # 1. Pages
    p_stmt = select(Page)
    p_res = await db.execute(p_stmt)
    pages = [
        {
            "id": p.id,
            "url_original": p.url_original,
            "url_normalized": p.url_normalized,
            "title": p.title,
            "description": p.description,
            "favicon_url": p.favicon_url,
            "og_image_mime": p.og_image_mime,
            "domain": p.domain,
            "category": p.category,
            "topic": p.topic,
            "content_summary": p.content_summary,
            "tags": p.tags,
            "is_important": p.is_important,
            "is_urgent": p.is_urgent,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in p_res.scalars().all()
    ]

    # 2. Tab Groups
    g_stmt = select(TabGroup)
    g_res = await db.execute(g_stmt)
    groups = [
        {
            "id": g.id,
            "chrome_group_id": g.chrome_group_id,
            "name": g.name,
            "color": g.color,
            "saved_html_export_path": g.saved_html_export_path,
            "created_at": g.created_at.isoformat() if g.created_at else None,
        }
        for g in g_res.scalars().all()
    ]

    # 3. Reminders
    r_stmt = select(Reminder)
    r_res = await db.execute(r_stmt)
    reminders = [
        {
            "id": r.id,
            "page_id": r.page_id,
            "note": r.note,
            "remind_on_next_open": r.remind_on_next_open,
            "remind_at": r.remind_at.isoformat() if r.remind_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "fired_at": r.fired_at.isoformat() if r.fired_at else None,
        }
        for r in r_res.scalars().all()
    ]

    # 4. Activity Logs (optional)
    activities = []
    if include_activity:
        a_stmt = select(ActivityLog)
        a_res = await db.execute(a_stmt)
        activities = [
            {
                "id": a.id,
                "page_id": a.page_id,
                "url": a.url,
                "domain": a.domain,
                "topic": a.topic,
                "started_at": a.started_at.isoformat() if a.started_at else None,
                "ended_at": a.ended_at.isoformat() if a.ended_at else None,
                "duration_seconds": a.duration_seconds,
            }
            for a in a_res.scalars().all()
        ]

    return {
        "version": "1.0",
        "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "total_pages": len(pages),
        "total_groups": len(groups),
        "total_reminders": len(reminders),
        "pages": pages,
        "tab_groups": groups,
        "reminders": reminders,
        "activities": activities,
    }


@router.post("/import", status_code=status.HTTP_200_OK)
async def import_database(
    payload: BackupData,
    merge: bool = True,
    db: AsyncSession = Depends(get_db)
):
    """
    Imports pages, categories, and tab data from a backup JSON payload.
    Supports merging (upsert) or clean overwrite.
    """
    if not merge:
        # Clear existing data
        await db.execute(delete(Reminder))
        await db.execute(delete(ActivityLog))
        await db.execute(delete(TabGroup))
        await db.execute(delete(Page))
        await db.flush()

    imported_pages = 0
    page_id_mapping = {}  # old_id -> new_id

    for p in payload.pages:
        norm_url = p.get("url_normalized") or p.get("url_original")
        if not norm_url:
            continue

        stmt = select(Page).where(Page.url_normalized == norm_url)
        res = await db.execute(stmt)
        existing = res.scalar_one_or_none()

        if existing:
            # Update fields
            existing.title = p.get("title") or existing.title
            existing.description = p.get("description") or existing.description
            existing.category = p.get("category") or existing.category
            existing.topic = p.get("topic") or existing.topic
            page_id_mapping[p.get("id")] = existing.id
        else:
            new_page = Page(
                url_original=p.get("url_original", norm_url),
                url_normalized=norm_url,
                title=p.get("title", "Untitled"),
                description=p.get("description"),
                favicon_url=p.get("favicon_url"),
                domain=p.get("domain", "unknown"),
                category=p.get("category", "General"),
                topic=p.get("topic"),
                content_summary=p.get("content_summary"),
                tags=p.get("tags"),
                is_important=p.get("is_important", False),
                is_urgent=p.get("is_urgent", False),
            )
            db.add(new_page)
            await db.flush()
            page_id_mapping[p.get("id")] = new_page.id
            imported_pages += 1

    await db.commit()

    return {
        "status": "success",
        "imported_pages": imported_pages,
        "total_processed": len(payload.pages),
        "mode": "merge" if merge else "overwrite"
    }
