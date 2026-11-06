"""Key-protected first import over HTTPS for networks blocking PostgreSQL ports."""
import asyncio
import io
import tempfile
import zipfile
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import inspect, select, func
from sqlalchemy.exc import SQLAlchemyError
from app.config import settings
from app.database import Base, engine, database_url
from app.services.cloud_migration import migrate

router=APIRouter(prefix='/api/setup',tags=['setup'])
MAX_UPLOAD=4*1024*1024
MAX_EXPANDED=32*1024*1024
DOCUMENTS={'closed_windows.json','browser_sessions.json','terminator_rules.json','taxonomy_rules.json','taxonomy.json','generated_topic_paths.json','topic_heading_aliases.json'}


@router.get('/status')
async def setup_status():
    if not settings.cloud:raise HTTPException(404)
    try:
        async with engine.connect() as connection:
            existing=set(await connection.run_sync(lambda sync:set(inspect(sync).get_table_names())))
            counts={}
            for table in Base.metadata.sorted_tables:
                if table.name in existing:counts[table.name]=(await connection.execute(select(func.count()).select_from(table))).scalar_one()
        return {'database_connected':True,'initialized':set(Base.metadata.tables).issubset(existing),'empty':not any(counts.values()),'rows':counts}
    except SQLAlchemyError as error:
        code=getattr(getattr(error,'orig',None),'sqlstate',None)
        detail='Database credentials were rejected' if code in ('28P01','28000') else 'The deployed backend cannot reach the database'
        raise HTTPException(503,detail) from None


@router.post('/import')
async def import_snapshot(request:Request):
    if not settings.cloud:raise HTTPException(404)
    payload=bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload)>MAX_UPLOAD:raise HTTPException(413,'The migration archive exceeds 4 MiB')
    try:
        archive=zipfile.ZipFile(io.BytesIO(payload))
        names=archive.namelist()
        if len(names)!=len(set(names)) or 'database.sqlite3' not in names or any(name not in DOCUMENTS|{'database.sqlite3'} for name in names):raise ValueError()
        if sum(item.file_size for item in archive.infolist())>MAX_EXPANDED:raise HTTPException(413,'The expanded snapshot exceeds 32 MiB')
        with tempfile.TemporaryDirectory(prefix='tab-organizer-import-') as directory:
            folder=Path(directory)
            for name in names:
                content=archive.read(name)
                if name=='database.sqlite3' and not content.startswith(b'SQLite format 3\x00'):raise ValueError()
                (folder/name).write_bytes(content)
            return await asyncio.to_thread(migrate,folder/'database.sqlite3',database_url(settings.DATABASE_URL),True)
    except HTTPException:raise
    except (ValueError,zipfile.BadZipFile,RuntimeError) as error:
        if isinstance(error,ValueError) and 'target already contains' in str(error).lower():raise HTTPException(409,'The cloud library already contains data. Nothing was overwritten.') from None
        raise HTTPException(400,'The migration snapshot was not accepted. Nothing was overwritten.') from None
    except Exception:raise HTTPException(503,'Migration did not complete. The source database is unchanged.') from None
