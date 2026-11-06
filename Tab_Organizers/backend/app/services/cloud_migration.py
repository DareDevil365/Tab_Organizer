"""Transactional import of a consistent personal-library SQLite snapshot."""
import datetime as dt
import json
import sqlite3
from pathlib import Path
from urllib.parse import quote

def migrate(source_path, destination, apply=False, backup_dir=None):
    from sqlalchemy import create_engine, inspect, select, func, Integer, text
    from sqlalchemy.pool import NullPool
    from app.database import Base, database_url
    from app import models
    from app.services.state_store import dialect_insert
    if not source_path.is_file():raise ValueError('The source SQLite database does not exist')
    # Read a SQLite backup so an active browser cannot change rows midway through
    # the copy. --apply retains this backup; a dry run uses an in-memory snapshot.
    original=sqlite3.connect('file:'+quote(str(source_path.resolve()).replace('\\','/'),safe='/:')+'?mode=ro',uri=True)
    memory=sqlite3.connect(':memory:');original.backup(memory);original.close()
    source=create_engine('sqlite://',creator=lambda:memory)
    tables=set(inspect(source).get_table_names())
    rows={}
    with source.connect() as connection:
        for table in Base.metadata.sorted_tables:
            if table.name not in tables or table.name in {'embeddings','embedding_cache','embedding_budgets','app_documents'}:continue
            records=[]
            # Reflect the source table because old local schemas may omit newer columns.
            from sqlalchemy import MetaData, Table
            local=Table(table.name,MetaData(),autoload_with=connection)
            for record in connection.execute(select(local)).mappings():
                data={key:value for key,value in record.items() if key in table.c}
                for key,value in data.items():
                    if isinstance(value,dt.datetime) and value.tzinfo is None:data[key]=value.replace(tzinfo=dt.timezone.utc)
                records.append(data)
            rows[table.name]=records
    options={'connect_args':{'prepare_threshold':None,'connect_timeout':15,'sslmode':'require'}} if destination.startswith('postgresql+') else {}
    target=create_engine(destination,poolclass=NullPool,hide_parameters=True,**options)
    existing=set(inspect(target).get_table_names())
    with target.connect() as connection:
        for table in Base.metadata.sorted_tables:
            if table.name in existing and connection.execute(select(func.count()).select_from(table)).scalar_one():
                raise ValueError('The target already contains app data. No rows were copied; use a fresh project or review the existing migration.')
    plan={name:len(records) for name,records in rows.items()}
    if not apply:
        target.dispose();source.dispose();return {'applied':False,'source_rows':plan,'target_empty':True}
    if backup_dir:
        backup_dir.mkdir(parents=True,exist_ok=True)
        path=backup_dir/('before-cloud-'+dt.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite3')
        copy=sqlite3.connect(str(path));memory.backup(copy);copy.close()
    with target.begin() as connection:
        Base.metadata.create_all(connection)
        for table in Base.metadata.sorted_tables:
            if connection.dialect.name=='postgresql':
                # No public Data API policies: the backend is the sole database client.
                connection.exec_driver_sql(f'ALTER TABLE "{table.name}" ENABLE ROW LEVEL SECURITY')
            records=rows.get(table.name,[])
            for start in range(0,len(records),100):connection.execute(table.insert(),records[start:start+100])
            if connection.dialect.name=='postgresql' and 'id' in table.c and isinstance(table.c.id.type,Integer) and table.c.id.primary_key:
                maximum=max((record['id'] for record in rows.get(table.name,[])),default=0)
                connection.execute(text("SELECT setval(pg_get_serial_sequence(:table, 'id'), :maximum, :used)"),{'table':table.name,'maximum':max(1,maximum),'used':maximum>0})
        # Keep recovery and generated content paths across deployments. No local
        # vectors are copied: BGE-M3 and MiniLM occupy different vector spaces.
        for name in ('closed_windows.json','browser_sessions.json','terminator_rules.json','taxonomy_rules.json','taxonomy.json','generated_topic_paths.json','topic_heading_aliases.json'):
            path=source_path.parent/name
            if not path.is_file():continue
            try:payload=json.loads(path.read_text(encoding='utf-8'))
            except (OSError,ValueError):continue
            expiry=dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=5) if name.startswith(('generated_','topic_heading_')) else None
            connection.execute(models.AppDocument.__table__.insert().values(key=name,payload=json.dumps(payload,ensure_ascii=False),expires_at=expiry))
        for name,records in rows.items():
            if connection.execute(select(func.count()).select_from(Base.metadata.tables[name])).scalar_one()!=len(records):raise RuntimeError('Verification failed; migration rolled back')
    target.dispose();source.dispose()
    return {'applied':True,'source_rows':plan,'verified':True,'local_data_unchanged':True}

