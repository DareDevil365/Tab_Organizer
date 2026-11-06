import pytest
import datetime
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select

from app.database import Base
from app.models.page import Page
from app.models.activity import ActivityLog
from app.models.reminder import Reminder
from app.routers.activity import get_weekly_digest
from app.routers.reminders import snooze_tab, SnoozeRequest
from app.routers.backup import export_database, import_database, BackupData


@pytest.mark.asyncio
async def test_weekly_digest_logic():
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    test_session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with test_session() as session:
        now = datetime.datetime.now(datetime.timezone.utc)
        log1 = ActivityLog(
            url="https://youtube.com/watch?v=123",
            domain="youtube.com",
            topic="programming",
            started_at=now - datetime.timedelta(hours=2),
            ended_at=now - datetime.timedelta(hours=1),
            duration_seconds=3600
        )
        log2 = ActivityLog(
            url="https://github.com/fastapi",
            domain="github.com",
            topic="programming",
            started_at=now - datetime.timedelta(hours=1),
            ended_at=now,
            duration_seconds=1800
        )
        session.add_all([log1, log2])
        await session.commit()

        digest = await get_weekly_digest(db=session)
        assert digest["total_seconds"] == 5400
        assert digest["total_hours"] == 1.5
        assert digest["top_domain"] == "youtube.com"
        assert digest["top_topic"] == "programming"
        assert "headline" in digest
        assert "youtube.com" in digest["headline"]

    await test_engine.dispose()


@pytest.mark.asyncio
async def test_snooze_tab_logic():
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    test_session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with test_session() as session:
        payload = SnoozeRequest(
            url="https://example.com/snooze-test",
            title="Snooze Test Page",
            snooze_minutes=30,
            note="Read this later"
        )
        reminder_resp = await snooze_tab(payload=payload, db=session)
        assert reminder_resp.url == "https://example.com/snooze-test"
        assert reminder_resp.remind_at is not None
        assert reminder_resp.remind_on_next_open is False
        assert "Read this later" in reminder_resp.note

        # Verify page was created in DB
        p_stmt = select(Page).where(Page.url_normalized == "https://example.com/snooze-test")
        p_res = await session.execute(p_stmt)
        page = p_res.scalar_one_or_none()
        assert page is not None
        assert page.title == "Snooze Test Page"

    await test_engine.dispose()


@pytest.mark.asyncio
async def test_backup_export_and_import_logic():
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    test_session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with test_session() as session:
        # 1. Add page
        p = Page(
            url_original="https://example.com/backup-page",
            url_normalized="https://example.com/backup-page",
            title="Backup Page Test",
            domain="example.com",
            category="AI 101",
            topic="artificial-intelligence"
        )
        session.add(p)
        await session.commit()

        # 2. Export
        export_data = await export_database(include_activity=True, db=session)
        assert export_data["total_pages"] == 1
        assert export_data["pages"][0]["url_original"] == "https://example.com/backup-page"

        # 3. Import new page
        backup_payload = BackupData(
            version="1.0",
            exported_at=datetime.datetime.now(datetime.timezone.utc),
            pages=[
                {
                    "url_original": "https://example.com/imported-page",
                    "url_normalized": "https://example.com/imported-page",
                    "title": "Imported Page",
                    "domain": "example.com",
                    "category": "Imported"
                }
            ],
            tab_groups=[],
            reminders=[]
        )
        import_res = await import_database(payload=backup_payload, merge=True, db=session)
        assert import_res["status"] == "success"
        assert import_res["imported_pages"] == 1

        # Check total pages is now 2
        count_stmt = select(Page)
        count_res = await session.execute(count_stmt)
        assert len(count_res.scalars().all()) == 2

    await test_engine.dispose()
