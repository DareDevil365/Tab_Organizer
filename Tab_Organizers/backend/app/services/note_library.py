"""A note and its saved resource are persisted together in one transaction."""
from urllib.parse import urlparse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.page import Page
from app.models.companion import CompanionNote
from app.services.url_normalizer import normalize_url
from app.services.content_subjects import subject_path


async def ensure_note_page(db: AsyncSession, url: str, title: str) -> Page:
    if db.get_bind().dialect.name=='postgresql':
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise ValueError('A note requires a valid web page URL')
    normalized = normalize_url(url)
    topic = subject_path({'title': title, 'domain': parsed.hostname})[-1]
    # Conflict-safe when a normal save and note save happen at the same time.
    await db.execute(insert(Page).values(
        url_original=normalized, url_normalized=normalized, title=title or parsed.hostname,
        domain=parsed.hostname.removeprefix('www.'),
        topic=None if topic == 'Needs a Topic' else topic,
    ).on_conflict_do_nothing(index_elements=['url_normalized']))
    page=(await db.execute(select(Page).where(Page.url_normalized == normalized))).scalar_one()
    from app.services.video_metadata import generic_title
    if generic_title(page.title,page.url_original) and title and not generic_title(title,url): page.title=title
    return page


async def link_existing_notes(db: AsyncSession) -> int:
    """Idempotently link legacy notes on startup, preserving all note content."""
    notes = (await db.execute(select(CompanionNote))).scalars().all()
    linked = 0
    for note in notes:
        if note.page_id is not None and await db.get(Page, note.page_id) is not None:
            continue
        try:
            page = await ensure_note_page(db, note.video_url, note.video_title)
        except ValueError:
            continue
        note.page_id = page.id
        linked += 1
    if linked:
        await db.commit()
    return linked
