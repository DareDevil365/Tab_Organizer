import json
import hashlib
import sqlite3
from pathlib import Path
import numpy as np
import httpx
import pytest
from sqlalchemy import create_engine, select
from app.main import app
from app.config import settings
from app.database import Base
from app.models.cloud_state import EmbeddingCache, EmbeddingBudget, AppDocument
from app.services.cloud_embeddings import CloudflareEmbedder, EmbeddingUnavailable


@pytest.mark.asyncio
async def test_private_key_protects_data_and_maintenance_without_login(monkeypatch):
    monkeypatch.setattr(settings,'APP_MODE','cloud');monkeypatch.setattr(settings,'BACKEND_API_KEY','k'*64);monkeypatch.setattr(settings,'CRON_SECRET','c'*64)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.get('/health')).status_code==200
        bootstrap=await client.get('/auth/config');assert bootstrap.json()['auth_method']=='connection-key'
        assert 'k'*64 not in bootstrap.text and 'c'*64 not in bootstrap.text
        for method,path in [('GET','/api/pages'),('DELETE','/api/pages/1'),('GET','/auth/session')]:
            assert (await client.request(method,path)).status_code==401
        assert (await client.get('/auth/session',headers={'Authorization':'Bearer '+'k'*64})).status_code==200
        assert (await client.get('/api/maintenance',headers={'Authorization':'Bearer '+'k'*64})).status_code==401
        assert (await client.get('/api/maintenance',headers={'Authorization':'Bearer '+'c'*64})).status_code==200


class MemoryVectors:
    def __init__(self):self.data={};self.reserved=0;self.blocked=False
    def load(self,keys):return {key:self.data[key] for key in keys if key in self.data}
    def reserve(self,size):
        if self.blocked:raise RuntimeError('Budget exhausted')
        self.reserved+=size
    def save(self,entries):self.data.update(entries)


def test_cloud_embeddings_cache_batch_normalize_and_reject_quota(monkeypatch):
    monkeypatch.setattr(settings,'CLOUDFLARE_ACCOUNT_ID','a'*32);monkeypatch.setattr(settings,'CLOUDFLARE_API_TOKEN','test-token')
    store=MemoryVectors();calls=[]
    def respond(request):
        assert request.headers['authorization']=='Bearer test-token';assert 'test-token' not in str(request.url)
        inputs=json.loads(request.content)['text'];calls.append(inputs)
        return httpx.Response(200,json={'success':True,'result':{'data':[[1]*1024 for _ in inputs]}})
    model=CloudflareEmbedder(store,httpx.MockTransport(respond))
    vectors=model.encode([f'Document {i}' for i in range(40)])
    assert vectors.shape==(40,1024);assert len(calls)==2
    assert np.allclose(np.linalg.norm(vectors,axis=1),1)
    assert np.array_equal(model.encode('Document 0'),vectors[0]);assert len(calls)==2
    model.encode('   ');assert calls[-1]==['Saved resource']
    store.blocked=True
    with pytest.raises(EmbeddingUnavailable):model.encode('New uncached document')
    assert len(calls)==3


def test_provider_quota_or_bad_shapes_never_return_fake_semantic_vectors(monkeypatch):
    monkeypatch.setattr(settings,'CLOUDFLARE_ACCOUNT_ID','a'*32);monkeypatch.setattr(settings,'CLOUDFLARE_API_TOKEN','test-token')
    for response in [httpx.Response(429,json={}),httpx.Response(200,json={'success':True,'result':{'data':[[0]*384]}})]:
        model=CloudflareEmbedder(MemoryVectors(),httpx.MockTransport(lambda request:response))
        with pytest.raises(EmbeddingUnavailable):model.encode('Question')


def test_missing_legacy_alias_cannot_break_library_rows_or_search():
    from app.services.content_subjects import subject_paths,semantic_content,library_subjects
    for title in ['New AI releases and news','AI video generation update']:
        page={'title':title}
        assert all(isinstance(path,tuple) for path in subject_paths(page))
        assert isinstance(semantic_content(page),str)
        assert isinstance(library_subjects(page),list)


@pytest.mark.asyncio
async def test_paginated_imports_with_equal_dates_have_unique_stable_order():
    import datetime as dt
    from app import database
    from app.models.page import Page
    stamp=dt.datetime(2026,1,1,tzinfo=dt.timezone.utc)
    async with database.async_session_maker() as db:
        db.add_all([Page(url_original=f'https://example.com/{i}',url_normalized=f'https://example.com/{i}',title=f'Saved reference {i}',created_at=stamp) for i in range(11)])
        await db.commit()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        ids=[]
        for offset in (0,4,8):
            response=await client.get(f'/api/pages?limit=4&offset={offset}');assert response.status_code==200
            ids.extend(page['id'] for page in response.json())
    assert ids==list(range(11,0,-1))


def test_persistent_cloud_documents_and_atomic_budget(tmp_path,monkeypatch):
    from app.services.state_store import read_json,write_json,mutate_json,VectorStore,state_engine
    url='sqlite:///'+str(tmp_path/'state.db');engine=create_engine(url);Base.metadata.create_all(engine)
    monkeypatch.setattr(settings,'DATABASE_URL',url);monkeypatch.setattr(settings,'APP_MODE','cloud');monkeypatch.setattr(settings,'EMBEDDING_DAILY_BYTES',10)
    path=tmp_path/'browser_sessions.json'
    write_json(path,[{'session_id':'first'}]);assert not path.exists()
    mutate_json(path,[],lambda rows:[{'session_id':'second'},*rows])
    assert len(read_json(path,[]))==2
    store=VectorStore();store.reserve(7)
    with pytest.raises(RuntimeError):store.reserve(4)
    with engine.connect() as connection:assert connection.execute(select(EmbeddingBudget.used_bytes)).scalar_one()==7
    store.save({'a'*64:np.ones(1024,dtype=np.float32).tobytes()});assert len(store.load(['a'*64])['a'*64])==4096
    state_engine.cache_clear();engine.dispose()


def test_migration_dry_run_is_read_only_and_apply_preserves_notes(tmp_path,monkeypatch):
    from importlib.util import spec_from_file_location,module_from_spec
    path=Path(__file__).parents[1]/'scripts/migrate_to_cloud.py';spec=spec_from_file_location('migration_test',path);module=module_from_spec(spec);spec.loader.exec_module(module)
    source=tmp_path/'source.db';engine=create_engine('sqlite:///'+str(source));Base.metadata.create_all(engine)
    from app.models.page import Page
    from app.models.companion import CompanionNote
    with engine.begin() as connection:
        connection.execute(Page.__table__.insert().values(id=42,url_original='https://example.com',url_normalized='https://example.com',title='A saved page'))
        connection.execute(CompanionNote.__table__.insert().values(id='note',page_id=42,video_url='https://example.com',timestamped_url='https://example.com',video_title='A saved page',timestamp_seconds=0,timestamp_formatted='00:00',comment='Keep this note'))
    target=tmp_path/'target.db';target_url='sqlite:///'+str(target);create_engine(target_url).dispose()
    before=hashlib.sha256(source.read_bytes()).hexdigest()
    plan=module.migrate(source,target_url)
    assert not plan['applied'];assert sqlite3.connect(target).execute("select count(*) from sqlite_master where type='table'").fetchone()[0]==0
    result=module.migrate(source,target_url,True,tmp_path/'backups');assert result['verified']
    assert hashlib.sha256(source.read_bytes()).hexdigest()==before
    c=sqlite3.connect(target);assert c.execute('select page_id,comment from companion_notes').fetchone()==(42,'Keep this note');c.close()
    with pytest.raises(ValueError):module.migrate(source,target_url,True)


@pytest.mark.asyncio
async def test_https_import_is_key_protected_and_rejects_unsafe_archives(monkeypatch):
    import io,zipfile
    from app.routers import setup
    monkeypatch.setattr(settings,'APP_MODE','cloud');monkeypatch.setattr(settings,'BACKEND_API_KEY','k'*64)
    headers={'Authorization':'Bearer '+'k'*64}
    def packed(name,content):
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w') as archive:archive.writestr(name,content)
        return output.getvalue()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.post('/api/setup/import',content=b'bad')).status_code==401
        assert (await client.post('/api/setup/import',content=packed('../database.sqlite3',b'bad'),headers=headers)).status_code==400
        assert (await client.post('/api/setup/import',content=packed('database.sqlite3',b'not sqlite'),headers=headers)).status_code==400
        monkeypatch.setattr(setup,'migrate',lambda *args:{'verified':True,'local_data_unchanged':True})
        result=await client.post('/api/setup/import',content=packed('database.sqlite3',b'SQLite format 3\x00'+b'fixture'),headers=headers)
        assert result.status_code==200 and result.json()['verified']
