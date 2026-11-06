import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select

from app.database import Base
from app.models.page import Page
from app.models.tab_group import TabGroup
from app.schemas.tab_group import TabGroupCreate, TabGroupUpdate, TabItem
from app.schemas.export import ExportRequest, ExportTabItem
from app.routers.tab_groups import (
    create_group,
    list_groups,
    get_group,
    update_group,
    delete_group,
    export_saved_group
)
from app.routers.export import export_tabs


async def get_test_session():
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    test_session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return test_engine, test_session


@pytest.mark.asyncio
async def test_create_and_list_tab_group():
    engine, session_maker = await get_test_session()
    async with session_maker() as session:
        group_in = TabGroupCreate(
            name="Casual YouTube Videos",
            color="red",
            tabs=[
                TabItem(url="https://youtube.com/watch?v=vid1", title="Funny Video 1", domain="youtube.com"),
                TabItem(url="https://youtube.com/watch?v=vid2", title="Funny Video 2", domain="youtube.com")
            ]
        )

        created = await create_group(group_in=group_in, db=session)
        assert created.id is not None
        assert created.name == "Casual YouTube Videos"
        assert created.color == "red"
        assert created.tab_count == 2
        assert len(created.tabs) == 2
        assert created.tabs[0].url == "https://youtube.com/watch?v=vid1"
        assert created.tabs[1].title == "Funny Video 2"

        # CRUCIAL: Verify that Page table is completely empty!
        p_stmt = select(Page)
        p_res = await session.execute(p_stmt)
        pages = p_res.scalars().all()
        assert len(pages) == 0, "Saving a tab group must NOT pollute the Page library database!"

        # List groups
        groups = await list_groups(db=session)
        assert len(groups) == 1
        assert groups[0].id == created.id
        assert groups[0].tab_count == 2

    await engine.dispose()


@pytest.mark.asyncio
async def test_update_and_delete_tab_group():
    engine, session_maker = await get_test_session()
    async with session_maker() as session:
        group_in = TabGroupCreate(
            name="Temp Research",
            color="blue",
            tabs=[
                TabItem(url="https://example.com/item1", title="Item 1")
            ]
        )
        created = await create_group(group_in=group_in, db=session)

        # Update
        update_in = TabGroupUpdate(
            name="Updated Research",
            color="green",
            tabs=[
                TabItem(url="https://example.com/item1", title="Item 1"),
                TabItem(url="https://example.com/item2", title="Item 2")
            ]
        )
        updated = await update_group(group_id=created.id, group_in=update_in, db=session)
        assert updated.name == "Updated Research"
        assert updated.color == "green"
        assert updated.tab_count == 2

        # Get single
        fetched = await get_group(group_id=created.id, db=session)
        assert fetched.name == "Updated Research"

        # Export
        export_resp = await export_saved_group(group_id=created.id, db=session)
        assert export_resp.item_count == 2
        assert "<!DOCTYPE html>" in export_resp.html_content
        assert "Updated Research" in export_resp.title

        # Delete
        del_resp = await delete_group(group_id=created.id, db=session)
        assert del_resp["status"] == "deleted"

        groups = await list_groups(db=session)
        assert len(groups) == 0

    await engine.dispose()


@pytest.mark.asyncio
async def test_export_tabs_isolation():
    engine, session_maker = await get_test_session()
    async with session_maker() as session:
        # Test 1: save_to_library=False (Default)
        req_no_save = ExportRequest(
            title="Quick Export",
            tabs=[
                ExportTabItem(url_original="https://youtube.com/watch?v=isolated", title="Isolated Video")
            ],
            save_to_library=False
        )
        resp1 = await export_tabs(request=req_no_save, db=session)
        assert resp1.item_count == 1
        assert "<!DOCTYPE html>" in resp1.html_content

        # Verify Page table is empty
        p_res1 = await session.execute(select(Page))
        assert len(p_res1.scalars().all()) == 0

        # Test 2: save_to_library=True
        req_save = ExportRequest(
            title="Saved Export",
            tabs=[
                ExportTabItem(url_original="https://youtube.com/watch?v=important", title="Important Video")
            ],
            save_to_library=True
        )
        resp2 = await export_tabs(request=req_save, db=session)
        assert resp2.item_count == 1

        # Verify Page table now contains the page
        p_res2 = await session.execute(select(Page))
        pages = p_res2.scalars().all()
        assert len(pages) == 1
        assert pages[0].title == "Important Video"

    await engine.dispose()
