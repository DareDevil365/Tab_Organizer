import datetime
import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from app.database import get_db
from app.models.recycle import RecycleItem
from app.services.recycle_bin import purge_expired, restore_item, utcnow

router = APIRouter(prefix='/api/recycle-bin', tags=['recycle-bin'])


@router.get('')
async def list_deleted(db=Depends(get_db)):
    await purge_expired(db)
    items = (await db.execute(select(RecycleItem).order_by(RecycleItem.deleted_at.desc()))).scalars().all()
    return [{'id': item.id, 'kind': item.kind, 'title': item.title,
             'deleted_at': item.deleted_at.replace(tzinfo=datetime.timezone.utc),
             'expires_at': item.expires_at.replace(tzinfo=datetime.timezone.utc),
             'note_count': len(json.loads(item.payload).get('notes', [])) if item.kind == 'page' else 1} for item in items]


@router.post('/{item_id}/restore')
async def restore_deleted(item_id: str, db=Depends(get_db)):
    item = await db.get(RecycleItem, item_id)
    if item is None: raise HTTPException(404, 'This item is no longer in the recycle bin')
    if item.expires_at.replace(tzinfo=datetime.timezone.utc) <= utcnow():
        await purge_expired(db)
        raise HTTPException(410, 'The five-day recovery period has expired')
    return {'page_id': await restore_item(db, item)}
