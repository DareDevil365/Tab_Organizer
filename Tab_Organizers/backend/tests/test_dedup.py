import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select

from app.database import Base
from app.models.page import Page
from app.services.url_normalizer import normalize_url


@pytest.mark.asyncio
async def test_database_deduplication():
    # Setup test in-memory SQLite database
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    test_session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with test_session() as session:
        # First save
        raw_url1 = "https://example.com/article?utm_source=twitter&ref=123"
        norm1 = normalize_url(raw_url1)
        
        p1 = Page(
            url_original=raw_url1,
            url_normalized=norm1,
            title="Initial Title",
            domain="example.com"
        )
        session.add(p1)
        await session.commit()

        # Second save with different tracking parameters
        raw_url2 = "https://example.com/article?utm_medium=email"
        norm2 = normalize_url(raw_url2)
        assert norm1 == norm2  # Must normalize to exact same key

        # Upsert logic simulation
        stmt = select(Page).where(Page.url_normalized == norm2)
        res = await session.execute(stmt)
        existing = res.scalar_one_or_none()
        assert existing is not None
        assert existing.title == "Initial Title"

        # Update metadata in place
        existing.title = "Updated Title"
        await session.commit()

        # Verify only 1 row exists in table
        count_stmt = select(Page)
        count_res = await session.execute(count_stmt)
        all_pages = count_res.scalars().all()
        assert len(all_pages) == 1
        assert all_pages[0].title == "Updated Title"

    await test_engine.dispose()
