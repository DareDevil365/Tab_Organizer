from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.config import settings

def database_url(value):
    if value.startswith(('postgres://', 'postgresql://')):
        return 'postgresql+psycopg://' + value.split('://', 1)[1]
    return value

url = database_url(settings.DATABASE_URL)
postgres = url.startswith('postgresql+')
engine = create_async_engine(url, echo=False, hide_parameters=True, **({'poolclass': NullPool, 'connect_args': {'prepare_threshold': None, 'connect_timeout': 10, 'sslmode': 'require'}} if postgres else {}))
async_session_maker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

class Base(DeclarativeBase):
    pass

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
