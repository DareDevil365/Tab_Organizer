from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.brain_service import ask_brain, generate_learning_plan, ensure_page_embeddings

router = APIRouter(prefix="/api/brain", tags=["brain"])


class AskBrainRequest(BaseModel):
    question: str


class PlanRequest(BaseModel):
    topic: str


@router.post("/ask")
async def ask_brain_endpoint(payload: AskBrainRequest, db: AsyncSession = Depends(get_db)):
    """Conversational RAG assistant endpoint answering questions based on saved knowledge."""
    if not payload.question or not payload.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")
    return await ask_brain(payload.question.strip(), db)


@router.post("/plan")
async def generate_plan_endpoint(payload: PlanRequest, db: AsyncSession = Depends(get_db)):
    """Generates a structured learning plan/syllabus from saved library resources."""
    if not payload.topic or not payload.topic.strip():
        raise HTTPException(status_code=400, detail="Topic cannot be empty")
    return await generate_learning_plan(payload.topic.strip(), db)


@router.post("/embed-all")
async def embed_all_pages(db: AsyncSession = Depends(get_db)):
    """Generates local embeddings for any pages lacking them."""
    count = await ensure_page_embeddings(db)
    return {"embedded_count": count, "status": "completed"}
