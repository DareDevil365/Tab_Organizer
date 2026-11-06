from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, or_, func

from app.database import get_db
from app.models.companion import CompanionNote
from app.schemas.companion import CompanionNoteCreate, CompanionNoteResponse
from app.models.page import Page
from app.services.note_library import ensure_note_page
from app.services.url_normalizer import normalize_url
from app.models.recycle import RecycleItem
from app.services.recycle_bin import utcnow
import json

router = APIRouter(prefix="/api/companion", tags=["companion"])

async def confirmed_note(db,note):
    count=(await db.execute(select(func.count(CompanionNote.id)).where(CompanionNote.page_id==note.page_id))).scalar_one()
    return CompanionNoteResponse.model_validate(note).model_copy(update={'page_note_count':count})

@router.get("", response_model=List[CompanionNoteResponse])
async def list_notes(
    video_url: Optional[str] = Query(None, description="Filter by video or page URL"),
    page_id: Optional[int] = Query(None, description="Filter by page ID"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db)
):
    query = select(CompanionNote)
    if video_url:
        page = (await db.execute(select(Page).where(Page.url_normalized == normalize_url(video_url)))).scalar_one_or_none()
        if page is not None and page_id is None:
            page_id = page.id
    if page_id is not None and video_url:
        query = query.where(or_(CompanionNote.page_id == page_id, CompanionNote.video_url == video_url))
    elif page_id is not None:
        query = query.where(CompanionNote.page_id == page_id)
    elif video_url:
        query = query.where(CompanionNote.video_url == video_url)

    query = query.order_by(desc(CompanionNote.created_at), CompanionNote.id).limit(limit).offset(offset)
    
    result = await db.execute(query)
    notes = result.scalars().all()
    return list(notes)

@router.post("", response_model=CompanionNoteResponse, status_code=status.HTTP_201_CREATED)
async def create_note(
    note_in: CompanionNoteCreate,
    db: AsyncSession = Depends(get_db)
):
    # A stale/offline client must not recreate a note intentionally moved to trash.
    archived = (await db.execute(select(RecycleItem.payload).where(
        RecycleItem.expires_at > utcnow(), RecycleItem.payload.contains(note_in.id, autoescape=True)))).scalars().all()
    for raw in archived:
        payload = json.loads(raw)
        notes = payload.get('notes', [payload['note']] if 'note' in payload else [])
        if any(note['id'] == note_in.id for note in notes):
            raise HTTPException(409, 'This note is in the recycle bin. Restore it there instead.')
    try:
        page = await ensure_note_page(db, note_in.video_url, note_in.video_title)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    if note_in.page_id is not None and note_in.page_id != page.id:
        raise HTTPException(status_code=409, detail='The note URL does not match the selected page')
    existing = await db.get(CompanionNote, note_in.id)
    if existing:
        existing.comment = note_in.comment
        existing.timestamp_seconds = note_in.timestamp_seconds
        existing.timestamp_formatted = note_in.timestamp_formatted
        existing.timestamped_url = note_in.timestamped_url
        existing.video_title = note_in.video_title
        existing.thumbnail_url = note_in.thumbnail_url
        existing.attachments = note_in.attachments
        existing.page_id = page.id
        await db.commit()
        await db.refresh(existing)
        return await confirmed_note(db,existing)

    note = CompanionNote(
        created_at=note_in.created_at or utcnow(),
        id=note_in.id,
        video_url=note_in.video_url,
        timestamped_url=note_in.timestamped_url,
        video_title=note_in.video_title,
        timestamp_seconds=note_in.timestamp_seconds,
        timestamp_formatted=note_in.timestamp_formatted,
        comment=note_in.comment,
        thumbnail_url=note_in.thumbnail_url,
        attachments=note_in.attachments,
        page_id=page.id,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return await confirmed_note(db,note)

@router.delete("/{note_id}", status_code=status.HTTP_200_OK)
async def delete_note(
    note_id: str,
    db: AsyncSession = Depends(get_db)
):
    note = await db.get(CompanionNote, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    from app.services.recycle_bin import archive_note
    await archive_note(db, note)
    await db.delete(note)
    await db.commit()
    return {"status": "ok", "deleted_id": note_id}
