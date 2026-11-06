from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_

from app.database import get_db
from app.models.page import Page
from app.schemas.page import PageResponse
from app.services.brain_service import search_relevant_pages

router = APIRouter(prefix="/api/library", tags=["library"])


class FolderInfo(BaseModel):
    name: str
    count: int
    latest_title: Optional[str] = None


class CategoryUpdate(BaseModel):
    category: str


class TagsUpdate(BaseModel):
    tags: str  # Comma-separated or JSON string


@router.get("/folders", response_model=List[FolderInfo])
async def get_folders(db: AsyncSession = Depends(get_db)):
    """Returns all folders/categories with item counts."""
    stmt = (
        select(Page.category, func.count(Page.id))
        .where(Page.category.is_not(None))
        .group_by(Page.category)
        .order_by(func.count(Page.id).desc())
    )
    res = await db.execute(stmt)
    folders = []
    for cat, cnt in res.all():
        if cat:
            folders.append(FolderInfo(name=cat, count=cnt))

    # Also count uncategorized
    uncat_stmt = select(func.count(Page.id)).where(or_(Page.category.is_(None), Page.category == ""))
    uncat_res = await db.execute(uncat_stmt)
    uncat_cnt = uncat_res.scalar_one()
    if uncat_cnt > 0:
        folders.append(FolderInfo(name="Uncategorized", count=uncat_cnt))

    return folders


@router.get("/folder/{name}", response_model=List[PageResponse])
async def get_folder_pages(name: str, db: AsyncSession = Depends(get_db)):
    """Retrieves all pages belonging to a specific folder."""
    if name.lower() == "uncategorized":
        stmt = select(Page).where(or_(Page.category.is_(None), Page.category == "")).order_by(Page.created_at.desc())
    else:
        stmt = select(Page).where(Page.category == name).order_by(Page.created_at.desc())

    res = await db.execute(stmt)
    return res.scalars().all()


@router.get("/search")
async def search_library(
    q: str = Query(..., min_length=1),
    semantic: bool = Query(default=True),
    db: AsyncSession = Depends(get_db)
):
    """Hybrid search across title, description, URL, tags, and local semantic embeddings."""
    results = []

    # 1. Semantic search if enabled
    if semantic:
        semantic_matches = await search_relevant_pages(q, db, top_k=15, min_similarity=0.15)
        results.extend(semantic_matches)

    # 2. Keyword search fallback / union
    pattern = f"%{q.strip()}%"
    kw_stmt = select(Page).where(
        or_(
            Page.title.ilike(pattern),
            Page.description.ilike(pattern),
            Page.domain.ilike(pattern),
            Page.tags.ilike(pattern),
            Page.topic.ilike(pattern)
        )
    ).limit(20)

    kw_res = await db.execute(kw_stmt)
    existing_ids = {r["id"] for r in results}

    for p in kw_res.scalars().all():
        if p.id not in existing_ids:
            results.append({
                "id": p.id,
                "title": p.title,
                "url": p.url_original,
                "url_normalized": p.url_normalized,
                "domain": p.domain,
                "description": p.description,
                "topic": p.topic,
                "category": p.category,
                "similarity_score": 1.0  # Exact keyword hit
            })

    return {"query": q, "results": results, "total": len(results)}


@router.put("/page/{page_id}/category", response_model=PageResponse)
async def update_page_category(
    page_id: int,
    payload: CategoryUpdate,
    db: AsyncSession = Depends(get_db)
):
    """Moves a page to a named category/folder."""
    stmt = select(Page).where(Page.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    page.category = payload.category.strip()
    await db.commit()
    await db.refresh(page)
    return page


@router.put("/page/{page_id}/tags", response_model=PageResponse)
async def update_page_tags(
    page_id: int,
    payload: TagsUpdate,
    db: AsyncSession = Depends(get_db)
):
    """Updates user tags on a page."""
    stmt = select(Page).where(Page.id == page_id)
    res = await db.execute(stmt)
    page = res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    page.tags = payload.tags.strip()
    await db.commit()
    await db.refresh(page)
    return page
