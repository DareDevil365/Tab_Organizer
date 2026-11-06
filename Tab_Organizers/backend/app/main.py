import os
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import engine, Base
from app.auth import require_owner, validate_cloud_settings, router as auth_router
from app.routers import (
    health,
    export,
    pages,
    classify,
    activity,
    library,
    brain,
    reminders,
    graph,
    backup,
    windows,
    terminator,
    tab_groups,
    companion,
    search,
    recycle
)
from app.routers import setup

@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    if settings.cloud:
        # Schema creation/data import is an explicit setup command. A serverless
        # cold start must not migrate data or launch unbounded background loops.
        validate_cloud_settings()
        yield
        return
    from app.services.classifier import DATA_DIR, load_taxonomy_rules, run_background_classification

    # Create data directory if it doesn't exist
    os.makedirs(str(DATA_DIR), exist_ok=True)
    
    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        from app.services.completion import migrate_completion_column
        await conn.run_sync(migrate_completion_column)

        def _migrate_tab_groups(sync_conn):
            import sqlite3
            try:
                cursor = sync_conn.connection.cursor()
                cursor.execute("PRAGMA table_info(tab_groups)")
                cols = [r[1] for r in cursor.fetchall()]
                for col, ctype in [
                    ("tab_count", "INTEGER DEFAULT 0"),
                    ("tabs_data", "TEXT"),
                    ("created_at", "TIMESTAMP"),
                    ("updated_at", "TIMESTAMP"),
                ]:
                    if col not in cols:
                        cursor.execute(f"ALTER TABLE tab_groups ADD COLUMN {col} {ctype}")
            except Exception:
                pass

        await conn.run_sync(_migrate_tab_groups)
        
    # Ensure default taxonomy rules are initialized and merged
    load_taxonomy_rules()

    from app.database import async_session_maker
    from app.services.note_library import link_existing_notes
    async with async_session_maker() as session:
        await link_existing_notes(session)

    # Schedule non-blocking background classification for pending pages
    if settings.CLASSIFY_ON_STARTUP:
        asyncio.create_task(run_background_classification(batch_size=15, limit=100))

    from app.services.recycle_bin import purge_expired
    async def sweep_recycle_bin():
        while True:
            try:
                async with async_session_maker() as session:
                    await purge_expired(session)
            except Exception:
                import logging
                logging.getLogger(__name__).exception('Recycle-bin cleanup failed; will retry')
            await asyncio.sleep(60)
    # Purge expired records at startup, then every minute while the backend runs.
    async with async_session_maker() as session:
        await purge_expired(session)
    recycler = asyncio.create_task(sweep_recycle_bin())
    try:
        yield
    finally:
        recycler.cancel()
        import contextlib
        with contextlib.suppress(asyncio.CancelledError):
            await recycler

app = FastAPI(
    title="Tab Organizer Backend",
    description="Backend API for Tab Organizer Extension + Brain",
    version="0.1.0",
    lifespan=lifespan,
    dependencies=[Depends(require_owner)],
    docs_url=None if settings.cloud else '/docs',
    redoc_url=None if settings.cloud else '/redoc',
    openapi_url=None if settings.cloud else '/openapi.json',
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=['X-Recycle-Id'],
)

app.include_router(health.router)
app.include_router(export.router)
app.include_router(pages.router)
app.include_router(classify.router)
app.include_router(activity.router)
app.include_router(library.router)
app.include_router(brain.router)
app.include_router(reminders.router)
app.include_router(graph.router)
app.include_router(backup.router)
app.include_router(windows.router)
app.include_router(terminator.router)
app.include_router(tab_groups.router)
app.include_router(companion.router)
app.include_router(search.router)
app.include_router(recycle.router)
app.include_router(auth_router)
app.include_router(setup.router)


@app.get('/api/maintenance')
async def maintenance():
    from app.database import async_session_maker
    from app.services.recycle_bin import purge_expired
    async with async_session_maker() as session:
        await purge_expired(session)
    return {'status':'ok'}


if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True)
