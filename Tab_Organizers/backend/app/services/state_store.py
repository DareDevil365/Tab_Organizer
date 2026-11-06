"""Durable cloud documents; atomic local JSON remains the local-mode format."""
import datetime as dt
import json
import uuid
from functools import lru_cache
from pathlib import Path
from sqlalchemy import create_engine, select, delete
from sqlalchemy.pool import NullPool
from app.config import settings
from app.database import database_url
from app.models.cloud_state import AppDocument, EmbeddingCache, EmbeddingBudget


def now():
    return dt.datetime.now(dt.timezone.utc)


@lru_cache(maxsize=2)
def state_engine(url):
    url=database_url(url).replace('sqlite+aiosqlite:', 'sqlite:')
    options={'connect_args':{'prepare_threshold':None,'connect_timeout':10,'sslmode':'require'}} if url.startswith('postgresql+') else {}
    return create_engine(url, poolclass=NullPool, hide_parameters=True, **options)


def dialect_insert(connection, table):
    if connection.dialect.name=='postgresql':
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    return insert(table)


def read_json(path: Path, default):
    if not settings.cloud:
        try:return json.loads(path.read_text(encoding='utf-8'))
        except (OSError,ValueError):return default
    with state_engine(settings.DATABASE_URL).connect() as connection:
        raw=connection.execute(select(AppDocument.payload).where(AppDocument.key==path.name,
            (AppDocument.expires_at.is_(None)) | (AppDocument.expires_at>now()))).scalar_one_or_none()
        return json.loads(raw) if raw is not None else default


def write_json(path: Path, value, *, cache=False):
    if not settings.cloud:
        path.parent.mkdir(parents=True,exist_ok=True)
        temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
        temporary.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8');temporary.replace(path)
        return
    with state_engine(settings.DATABASE_URL).begin() as connection:
        insert=dialect_insert(connection,AppDocument).values(key=path.name,payload=json.dumps(value,ensure_ascii=False),expires_at=now()+dt.timedelta(days=5) if cache else None)
        connection.execute(insert.on_conflict_do_update(index_elements=['key'],set_={'payload':insert.excluded.payload,'expires_at':insert.excluded.expires_at}))


def mutate_json(path: Path, default, transform):
    """Serialize recovery mutations across separate serverless instances."""
    if not settings.cloud:
        value=transform(read_json(path,default));write_json(path,value);return value
    with state_engine(settings.DATABASE_URL).begin() as connection:
        connection.execute(dialect_insert(connection,AppDocument).values(key=path.name,payload=json.dumps(default)).on_conflict_do_nothing(index_elements=['key']))
        raw=connection.execute(select(AppDocument.payload).where(AppDocument.key==path.name).with_for_update()).scalar_one()
        value=transform(json.loads(raw))
        connection.execute(AppDocument.__table__.update().where(AppDocument.key==path.name).values(payload=json.dumps(value,ensure_ascii=False)))
        return value


class VectorStore:
    def load(self, keys):
        result={}
        with state_engine(settings.DATABASE_URL).connect() as connection:
            for start in range(0,len(keys),500):
                rows=connection.execute(select(EmbeddingCache.key,EmbeddingCache.vector).where(EmbeddingCache.key.in_(keys[start:start+500]),EmbeddingCache.expires_at>now()))
                result.update({key:vector for key,vector in rows})
        return result

    def reserve(self, size):
        day=now().date().isoformat()
        with state_engine(settings.DATABASE_URL).begin() as connection:
            connection.execute(dialect_insert(connection,EmbeddingBudget).values(day=day,used_bytes=0).on_conflict_do_nothing(index_elements=['day']))
            updated=connection.execute(EmbeddingBudget.__table__.update().where(EmbeddingBudget.day==day,
                EmbeddingBudget.used_bytes<=max(0,settings.EMBEDDING_DAILY_BYTES)-size).values(used_bytes=EmbeddingBudget.used_bytes+size))
            if updated.rowcount!=1:raise RuntimeError('Daily embedding budget reached; try again tomorrow')

    def save(self, entries):
        if not entries:return
        with state_engine(settings.DATABASE_URL).begin() as connection:
            expiry=now()+dt.timedelta(days=5)
            insert=dialect_insert(connection,EmbeddingCache).values([{'key':key,'vector':vector,'expires_at':expiry} for key,vector in entries.items()])
            connection.execute(insert.on_conflict_do_update(index_elements=['key'],set_={'vector':insert.excluded.vector,'expires_at':insert.excluded.expires_at}))
