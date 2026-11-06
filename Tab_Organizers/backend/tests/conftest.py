"""Keep API tests away from the user's database and recovery/configuration files."""
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import database
from app.database import Base, get_db
from app.main import app
from app.routers import windows, terminator


@pytest_asyncio.fixture(autouse=True)
async def isolated_app_data(tmp_path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async def test_db():
        async with sessions() as session:
            yield session

    monkeypatch.setattr(database, "async_session_maker", sessions)
    app.dependency_overrides[get_db] = test_db
    monkeypatch.setattr(windows, "DATA_DIR", tmp_path)
    monkeypatch.setattr(windows, "CLOSED_WINDOWS_FILE", tmp_path / "closed_windows.json")
    monkeypatch.setattr(windows, "BROWSER_SESSIONS_FILE", tmp_path / "browser_sessions.json")
    monkeypatch.setattr(terminator, "DATA_DIR", tmp_path)
    monkeypatch.setattr(terminator, "TERMINATOR_RULES_FILE", tmp_path / "terminator_rules.json")
    from app.services import topic_discovery
    monkeypatch.setattr(topic_discovery, 'CACHE_FILE', tmp_path / 'discovered_topics.json')
    monkeypatch.setattr(topic_discovery, '_cached', None)
    monkeypatch.setattr(topic_discovery, 'encode_documents', lambda texts: (topic_discovery.encode_text_documents(texts), 'text-similarity'))
    async def no_cloud(documents): return {}
    monkeypatch.setattr(topic_discovery, 'infer_resource_paths', no_cloud)
    async def no_consolidation(paths, documents): return paths
    monkeypatch.setattr(topic_discovery, 'consolidate_headings', no_consolidation)
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()
