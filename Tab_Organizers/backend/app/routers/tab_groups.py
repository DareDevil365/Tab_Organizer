import json
import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.tab_group import TabGroup
from app.schemas.tab_group import (
    TabGroupCreate,
    TabGroupUpdate,
    TabGroupResponse,
    TabItem
)
from app.schemas.export import ExportResponse
from app.services.html_exporter import generate_export_html

router = APIRouter(prefix="/api/groups", tags=["tab_groups"])


def _group_to_response(group: TabGroup) -> TabGroupResponse:
    tabs: List[TabItem] = []
    if group.tabs_data:
        try:
            raw_tabs = json.loads(group.tabs_data)
            if isinstance(raw_tabs, list):
                for t in raw_tabs:
                    tabs.append(TabItem(
                        url=t.get("url", "") or t.get("url_original", ""),
                        title=t.get("title", ""),
                        favicon_url=t.get("favicon_url", ""),
                        domain=t.get("domain", ""),
                        og_image_url=t.get("og_image_url", ""),
                        description=t.get("description", "")
                    ))
        except Exception:
            tabs = []

    return TabGroupResponse(
        id=group.id,
        name=group.name,
        color=group.color,
        chrome_group_id=group.chrome_group_id,
        tab_count=group.tab_count or len(tabs),
        tabs=tabs,
        saved_html_export_path=group.saved_html_export_path,
        created_at=group.created_at,
        updated_at=group.updated_at
    )


@router.get("", response_model=List[TabGroupResponse])
async def list_groups(db: AsyncSession = Depends(get_db)):
    """Lists all saved tab groups in descending order of creation."""
    stmt = select(TabGroup).order_by(TabGroup.created_at.desc())
    res = await db.execute(stmt)
    groups = res.scalars().all()
    return [_group_to_response(g) for g in groups]


@router.post("", response_model=TabGroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(group_in: TabGroupCreate, db: AsyncSession = Depends(get_db)):
    """
    Saves a tab group without polluting the main library pages database.
    Stores all contained tab URLs, titles, and icons cleanly within the group record.
    """
    # The marker and group commit together, so a lost HTTP acknowledgement can
    # be retried without creating another collection. Row locking serializes
    # retries arriving from the popup and worker at the same time.
    marker = None
    if group_in.client_id:
        from app.models.cloud_state import AppDocument
        if db.bind.dialect.name == 'postgresql':
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        key='client-group:'+group_in.client_id
        await db.execute(insert(AppDocument).values(key=key,payload='null').on_conflict_do_nothing(index_elements=['key']))
        marker=(await db.execute(select(AppDocument).where(AppDocument.key==key).with_for_update())).scalar_one()
        previous=json.loads(marker.payload)
        if previous:
            existing=await db.get(TabGroup,previous['id'])
            if not existing: raise HTTPException(409,'This collection was removed. Save a new collection instead.')
            return _group_to_response(existing)
    tabs_list = [t.model_dump() for t in group_in.tabs]
    tabs_json = json.dumps(tabs_list)
    count = len(tabs_list)

    new_group = TabGroup(
        name=group_in.name.strip() or "Saved Tab Group",
        color=group_in.color or "blue",
        chrome_group_id=group_in.chrome_group_id,
        tab_count=count,
        tabs_data=tabs_json,
        saved_html_export_path=group_in.saved_html_export_path
    )
    db.add(new_group)
    await db.flush()
    if marker is not None: marker.payload=json.dumps({'id':new_group.id})
    await db.commit()
    await db.refresh(new_group)
    return _group_to_response(new_group)


@router.get("/{group_id}", response_model=TabGroupResponse)
async def get_group(group_id: int, db: AsyncSession = Depends(get_db)):
    """Retrieves a specific saved tab group with its tab items."""
    stmt = select(TabGroup).where(TabGroup.id == group_id)
    res = await db.execute(stmt)
    group = res.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=404, detail="Tab group not found")
    return _group_to_response(group)


@router.put("/{group_id}", response_model=TabGroupResponse)
async def update_group(group_id: int, group_in: TabGroupUpdate, db: AsyncSession = Depends(get_db)):
    """Updates group title, color, or tab contents."""
    stmt = select(TabGroup).where(TabGroup.id == group_id)
    res = await db.execute(stmt)
    group = res.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=404, detail="Tab group not found")

    if group_in.name is not None:
        group.name = group_in.name.strip() or group.name
    if group_in.color is not None:
        group.color = group_in.color
    if group_in.tabs is not None:
        tabs_list = [t.model_dump() for t in group_in.tabs]
        group.tabs_data = json.dumps(tabs_list)
        group.tab_count = len(tabs_list)
    if group_in.saved_html_export_path is not None:
        group.saved_html_export_path = group_in.saved_html_export_path

    group.updated_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    await db.refresh(group)
    return _group_to_response(group)


@router.delete("/{group_id}", status_code=status.HTTP_200_OK)
async def delete_group(group_id: int, db: AsyncSession = Depends(get_db)):
    """Deletes a saved tab group."""
    stmt = select(TabGroup).where(TabGroup.id == group_id)
    res = await db.execute(stmt)
    group = res.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=404, detail="Tab group not found")

    await db.delete(group)
    await db.commit()
    return {"status": "deleted", "id": group_id, "name": group.name}


@router.post("/{group_id}/export", response_model=ExportResponse)
async def export_saved_group(group_id: int, db: AsyncSession = Depends(get_db)):
    """
    Generates a standalone, beautiful HTML export of a saved group
    WITHOUT touching the primary library database.
    """
    stmt = select(TabGroup).where(TabGroup.id == group_id)
    res = await db.execute(stmt)
    group = res.scalar_one_or_none()
    if not group:
        raise HTTPException(status_code=404, detail="Tab group not found")

    resp = _group_to_response(group)
    processed_pages = []
    for t in resp.tabs:
        processed_pages.append({
            "url_original": t.url,
            "url_normalized": t.url,
            "title": t.title or t.domain or "Untitled Tab",
            "description": t.description or "",
            "favicon_url": t.favicon_url or "",
            "og_image_url": t.og_image_url or "",
            "domain": t.domain or "",
            "group_name": group.name,
            "group_color": group.color
        })

    html_content = generate_export_html(processed_pages, export_title=f"Group: {group.name}")
    return ExportResponse(
        html_content=html_content,
        item_count=len(processed_pages),
        title=f"Group: {group.name}"
    )
