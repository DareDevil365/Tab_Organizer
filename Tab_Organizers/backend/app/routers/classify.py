from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.database import get_db
from app.models.page import Page
from app.services.classifier import (
    run_batch_classification,
    load_taxonomy,
    save_taxonomy,
    load_taxonomy_rules,
    save_taxonomy_rules,
    reset_taxonomy_rules_to_default
)

router = APIRouter(prefix="/api/classify", tags=["classification"])


class TaxonomyUpdate(BaseModel):
    taxonomy: List[str]


class RuleItem(BaseModel):
    name: str
    slug: Optional[str] = None
    keywords: List[str]
    description: Optional[str] = ""


class RulesUpdate(BaseModel):
    rules: List[RuleItem]


class ClassifyRunRequest(BaseModel):
    batch_size: Optional[int] = 15
    limit: Optional[int] = 100


@router.post("/run")
async def trigger_classification(
    req: Optional[ClassifyRunRequest] = None,
    db: AsyncSession = Depends(get_db)
):
    """Triggers batch classification of unclassified pages."""
    batch_size = req.batch_size if req else 15
    limit = req.limit if req else 100
    result = await run_batch_classification(db, batch_size=batch_size, limit=limit, reclassify_all=False)
    return result


@router.post("/reclassify-all")
async def trigger_reclassify_all(
    req: Optional[ClassifyRunRequest] = None,
    db: AsyncSession = Depends(get_db)
):
    """Reclassifies all pages in the library according to the latest custom rules & AI."""
    batch_size = req.batch_size if req else 20
    limit = req.limit if req else 500
    result = await run_batch_classification(db, batch_size=batch_size, limit=limit, reclassify_all=True)
    return result


@router.get("/status")
async def get_classification_status(db: AsyncSession = Depends(get_db)):
    """Returns total pages, classified pages, and pending pages count."""
    total_res = await db.execute(select(func.count(Page.id)))
    total_pages = total_res.scalar_one()

    pending_res = await db.execute(select(func.count(Page.id)).where(Page.topic.is_(None)))
    pending_pages = pending_res.scalar_one()

    classified_pages = total_pages - pending_pages

    return {
        "total_pages": total_pages,
        "classified_pages": classified_pages,
        "pending_pages": pending_pages,
        "percentage_classified": round((classified_pages / total_pages * 100) if total_pages > 0 else 100.0, 1)
    }


@router.get("/taxonomy")
async def get_taxonomy():
    """Returns the current list of classification topic names."""
    return {"taxonomy": load_taxonomy()}


@router.put("/taxonomy")
async def update_taxonomy(payload: TaxonomyUpdate):
    """Updates the classification taxonomy names."""
    if not payload.taxonomy:
        raise HTTPException(status_code=400, detail="Taxonomy cannot be empty")
    save_taxonomy(payload.taxonomy)
    return {"taxonomy": load_taxonomy(), "status": "updated"}


@router.get("/rules")
async def get_classification_rules():
    """Returns the detailed rules (names, keywords, descriptions)."""
    return {"rules": load_taxonomy_rules()}


@router.put("/rules")
async def update_classification_rules(payload: RulesUpdate):
    """Updates custom classification rules with trigger words and descriptions."""
    if not payload.rules:
        raise HTTPException(status_code=400, detail="Rules cannot be empty")
    
    rules_dicts = [
        {
            "name": r.name.strip(),
            "slug": r.slug or r.name.strip().lower().replace(" ", "_"),
            "keywords": [k.strip() for k in r.keywords if k and k.strip()],
            "description": r.description or ""
        }
        for r in payload.rules
        if r.name and r.name.strip()
    ]
    save_taxonomy_rules(rules_dicts)
    return {"rules": load_taxonomy_rules(), "status": "updated"}


@router.post("/rules/reset")
async def reset_classification_rules():
    """Resets classification rules to all default topic categories and keywords."""
    rules = reset_taxonomy_rules_to_default()
    return {"rules": rules, "status": "reset_to_default"}

