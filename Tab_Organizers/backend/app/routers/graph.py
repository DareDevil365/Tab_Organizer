from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.services.graph_service import build_knowledge_graph

router = APIRouter(prefix="/api/graph", tags=["graph"])


@router.get("")
async def get_graph(limit: int = Query(default=150, ge=10, le=500), db: AsyncSession = Depends(get_db)):
    """Returns the full knowledge graph nodes and edges for network visualization."""
    return await build_knowledge_graph(db, limit=limit)
