import datetime as dt
import json
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from app.main import app
from app import database
from app.models.page import Page
from app.models.companion import CompanionNote
from app.models.recycle import RecycleItem
from app.services.recycle_bin import purge_expired, utcnow
from app.services.note_library import link_existing_notes


def note(id, url='https://www.youtube.com/watch?v=abcdefghijk'):
    return {'id':id,'video_url':url,'timestamped_url':url,'video_title':'Learning something useful',
            'comment':'Keep this thought','timestamp_seconds':90,'timestamp_formatted':'01:30'}


@pytest.mark.asyncio
async def test_unsave_archives_notes_and_resave_starts_clean_then_restore_merges_without_overwrite():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        first=(await client.post('/api/companion',json=note('old'))).json()
        async with database.async_session_maker() as db:
            saved=await db.get(Page,first['page_id']); saved.og_image_data=b'original image'; saved.is_important=True
            await db.commit()
        assert (await client.delete('/api/pages/by-url',params={'url':note('old')['video_url']})).status_code==200
        assert (await client.get('/api/companion')).json()==[]
        assert (await client.get('/api/pages')).json()==[]
        assert (await client.get('/api/graph')).json()['resource_count']==0
        assert (await client.post('/api/companion',json=note('old'))).status_code==409
        assert (await client.get('/api/pages')).json()==[]
        async with database.async_session_maker() as db:
            assert await link_existing_notes(db)==0
        bins=(await client.get('/api/recycle-bin')).json()
        assert len(bins)==1 and bins[0]['note_count']==1
        assert dt.datetime.fromisoformat(bins[0]['expires_at'])-dt.datetime.fromisoformat(bins[0]['deleted_at'])==dt.timedelta(days=5)
        second=(await client.post('/api/companion',json=note('new'))).json()
        assert [n['id'] for n in (await client.get('/api/companion')).json()]==['new']
        restored=await client.post(f"/api/recycle-bin/{bins[0]['id']}/restore")
        assert restored.status_code==200 and restored.json()['page_id']==second['page_id']
        assert {n['id'] for n in (await client.get('/api/companion')).json()}=={'old','new'}
        assert (await client.get('/api/recycle-bin')).json()==[]
        assert len((await client.get('/api/pages')).json())==1


@pytest.mark.asyncio
async def test_restoring_resource_preserves_binary_metadata_and_avoids_reused_primary_key():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        first=(await client.post('/api/companion',json=note('old'))).json()
        async with database.async_session_maker() as db:
            page=await db.get(Page,first['page_id']);page.og_image_data=b'\x00\xff';page.is_important=True
            await db.commit()
        await client.delete(f"/api/pages/{first['page_id']}")
        other=(await client.post('/api/companion',json=note('other','https://other.test'))).json()
        item=(await client.get('/api/recycle-bin')).json()[0]
        restored=(await client.post(f"/api/recycle-bin/{item['id']}/restore")).json()
        assert restored['page_id']!=other['page_id']
        async with database.async_session_maker() as db:
            page=await db.get(Page,restored['page_id']);assert page.og_image_data==b'\x00\xff' and page.is_important
            assert (await db.get(CompanionNote,'old')).page_id==page.id


@pytest.mark.asyncio
async def test_individual_note_delete_restore_and_expiry_cannot_revive_deleted_data():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        first=(await client.post('/api/companion',json=note('old'))).json()
        await client.delete('/api/companion/old')
        assert (await client.get(f"/api/pages/{first['page_id']}")).json()['note_count']==0
        item=(await client.get('/api/recycle-bin')).json()[0]
        assert item['kind']=='note'
        assert (await client.post(f"/api/recycle-bin/{item['id']}/restore")).status_code==200
        await client.delete('/api/companion/old')
        item=(await client.get('/api/recycle-bin')).json()[0]
        async with database.async_session_maker() as db:
            entry=await db.get(RecycleItem,item['id']);entry.expires_at=utcnow()-dt.timedelta(seconds=1);await db.commit()
        assert (await client.post(f"/api/recycle-bin/{item['id']}/restore")).status_code==410
        assert (await client.get('/api/recycle-bin')).json()==[]
        assert (await client.get('/api/companion')).json()==[]


@pytest.mark.asyncio
async def test_purge_only_removes_expired_archive_records_and_preserves_live_data():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        await client.post('/api/companion',json=note('old'))
        await client.delete('/api/companion/old')
        await client.post('/api/companion',json=note('keep','https://keep.test'))
        async with database.async_session_maker() as db:
            item=(await db.execute(select(RecycleItem))).scalar_one()
            expiry=item.expires_at.replace(tzinfo=dt.timezone.utc)
            await purge_expired(db,expiry-dt.timedelta(microseconds=1))
            assert len((await db.execute(select(RecycleItem))).scalars().all())==1
            await purge_expired(db,expiry)
            assert (await db.execute(select(RecycleItem))).scalars().all()==[]
        assert [n['id'] for n in (await client.get('/api/companion')).json()]==['keep']
