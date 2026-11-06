from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.services.library_search import search_library

router = APIRouter(prefix='/api/search', tags=['search'])


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)

    @field_validator('query')
    @classmethod
    def meaningful_query(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Enter a search query')
        return value


@router.post('')
async def rank_saved_library(payload: SearchRequest, db: AsyncSession = Depends(get_db)):
    return await search_library(db, payload.query.strip())
