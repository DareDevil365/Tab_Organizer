"""Archive deletions separately from active tables, with an absolute five-day TTL."""
import base64
import datetime as dt
import json
import uuid
from sqlalchemy import select, delete
from app.models.page import Page
from app.models.companion import CompanionNote
from app.models.recycle import RecycleItem
from app.models.tab_group import PageGroupLink, TabGroup
from app.models.reminder import Reminder
from app.services.url_normalizer import normalize_url


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def snapshot(record):
    return {column.name: getattr(record, column.name) for column in record.__table__.columns}


def encode(value):
    if isinstance(value, dt.datetime): return {'$datetime': value.isoformat()}
    if isinstance(value, bytes): return {'$bytes': base64.b64encode(value).decode('ascii')}
    raise TypeError(type(value).__name__)


def decode(value):
    if set(value) == {'$datetime'}: return dt.datetime.fromisoformat(value['$datetime'])
    if set(value) == {'$bytes'}: return base64.b64decode(value['$bytes'])
    return value


async def archive(db, kind, title, payload):
    now = utcnow()
    item = RecycleItem(id=str(uuid.uuid4()), kind=kind, title=title or 'Saved resource',
                       payload=json.dumps(payload, default=encode), deleted_at=now, expires_at=now + dt.timedelta(days=5))
    db.add(item)
    return item


async def archive_page(db, page):
    notes = (await db.execute(select(CompanionNote).where(CompanionNote.page_id == page.id))).scalars().all()
    # Legacy notes without an assigned page ID still belong to the same resource.
    legacy = (await db.execute(select(CompanionNote).where(CompanionNote.page_id.is_(None)))).scalars().all()
    notes += [note for note in legacy if normalize_url(note.video_url) == page.url_normalized]
    links = (await db.execute(select(PageGroupLink).where(PageGroupLink.page_id == page.id))).scalars().all()
    reminders = (await db.execute(select(Reminder).where(Reminder.page_id == page.id))).scalars().all()
    item=await archive(db, 'page', page.title, {'page': snapshot(page), 'notes': [snapshot(n) for n in notes],
                  'groups': [link.group_id for link in links], 'reminders': [snapshot(r) for r in reminders]})
    return [n.id for n in notes],item.id


async def archive_note(db, note):
    page = await db.get(Page, note.page_id) if note.page_id is not None else None
    await archive(db, 'note', note.video_title, {'note': snapshot(note), 'page': snapshot(page) if page else None})


async def purge_expired(db, now=None):
    cutoff=now or utcnow()
    from app.models.cloud_state import AppDocument, EmbeddingCache, EmbeddingBudget
    await db.execute(delete(RecycleItem).where(RecycleItem.expires_at <= cutoff).execution_options(synchronize_session=False))
    await db.execute(delete(AppDocument).where(AppDocument.expires_at <= cutoff).execution_options(synchronize_session=False))
    await db.execute(delete(EmbeddingCache).where(EmbeddingCache.expires_at <= cutoff).execution_options(synchronize_session=False))
    await db.execute(delete(EmbeddingBudget).where(EmbeddingBudget.day < (cutoff-dt.timedelta(days=7)).date().isoformat()).execution_options(synchronize_session=False))
    await db.commit()


async def restore_item(db, item):
    payload = json.loads(item.payload, object_hook=decode)
    data = payload.get('page')
    if data:
        page = (await db.execute(select(Page).where(Page.url_normalized == data['url_normalized']))).scalar_one_or_none()
        if page is None:
            # A newly saved page may have reused the old SQLite ID. Never overwrite it.
            page = Page(**{key: value for key, value in data.items() if key != 'id'})
            db.add(page)
            await db.flush()
    else:
        note = payload['note']
        from app.services.note_library import ensure_note_page
        page = await ensure_note_page(db, note['video_url'], note['video_title'])
    for data in payload.get('notes', [payload['note']] if 'note' in payload else []):
        if await db.get(CompanionNote, data['id']) is None:
            db.add(CompanionNote(**{**data, 'page_id': page.id}))
    for group_id in payload.get('groups', []):
        if await db.get(TabGroup, group_id) is not None and await db.get(PageGroupLink, (page.id, group_id)) is None:
            db.add(PageGroupLink(page_id=page.id, group_id=group_id))
    for reminder in payload.get('reminders', []):
        db.add(Reminder(**{**{key: value for key, value in reminder.items() if key != 'id'}, 'page_id': page.id}))
    await db.delete(item)
    await db.commit()
    return page.id
