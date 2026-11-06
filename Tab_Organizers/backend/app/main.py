import os
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import engine, Base
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
    tab_groups
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    from app.services.classifier import DATA_DIR, load_taxonomy_rules, run_background_classification

    # Create data directory if it doesn't exist
    os.makedirs(str(DATA_DIR), exist_ok=True)
    
    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

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

    # Schedule non-blocking background classification for pending pages
    asyncio.create_task(run_background_classification(batch_size=15, limit=100))

    yield

app = FastAPI(
    title="Tab Organizer Backend",
    description="Backend API for Tab Organizer Extension + Brain",
    version="0.1.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True)
