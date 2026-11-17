import datetime as dt
import uuid

import httpx
import pytest
from app.main import app
from app.routers.activity import attention_kind

def test_attention_labels_exclude_ambiguous_and_mixed_educational_content():
    assert attention_kind('Movies and Television') == 'leisure'
    assert attention_kind('Game Design and Programming') == 'other'
    assert attention_kind('YouTube') == 'uncertain'
    assert attention_kind(None) == 'uncertain'

@pytest.mark.asyncio
async def test_reminder_storage_is_idempotent_and_stale_retries_do_not_undo_completion():
    id=str(uuid.uuid4())
    data={'id':id,'url':'https://example.org/lectures','title':'Review','note':'Chapter 2','at':1900000000000,
          'updatedAt':1899999900000,'repeat':{'everyDays':2,'times':['07:00','19:00'],'startDate':'2030-03-17','timezone':'Asia/Kolkata'}}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        path='/api/reminders/scheduled/'+id
        first=await client.put(path,json=data)
        assert first.status_code==200,first.text
        assert (await client.put(path,json=data)).status_code==200
        done={**data,'updatedAt':1900000000000,'completedAt':1900000000000}
        assert (await client.put(path,json=done)).status_code==200
        await client.put(path,json=data)
        rows=(await client.get('/api/reminders/scheduled')).json()
        assert len(rows)==1 and rows[0]['completedAt']==done['completedAt']

@pytest.mark.asyncio
async def test_interpret_stages_confirmation_without_creating_a_reminder(monkeypatch):
    class Provider:
        async def generate_response(self,*args,**kwargs):
            return '{"first":"2026-11-18T19:00:00+05:30","everyDays":2,"times":["07:00","19:00"],"startDate":"2026-11-18","confirmation":"7 AM and 7 PM every other day","needsClarification":false}'
    async def provider():return Provider()
    monkeypatch.setattr('app.services.ai_provider.get_ai_provider',provider)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        result=await client.post('/api/reminders/interpret',json={'text':'alternate days morning and evening','timezone':'Asia/Kolkata','now':dt.datetime(2026,11,18,8,tzinfo=dt.timezone.utc).isoformat()})
        assert result.status_code==200,result.text
        assert result.json()['repeat']['times']==['07:00','19:00']
        assert (await client.get('/api/reminders/scheduled')).json()==[]


@pytest.mark.asyncio
async def test_attention_clips_intervals_and_applies_page_specific_correction():
    import json
    from app import database
    from app.models.activity import ActivityLog
    from app.models.cloud_state import AppDocument
    from app.services.activity_subjects import content_key
    now=dt.datetime.now(dt.timezone.utc)
    url='https://www.youtube.com/watch?v=fixture'
    unknown='https://www.youtube.com/watch?v=unknown'
    async with database.async_session_maker() as db:
        db.add(AppDocument(key=content_key(url),payload=json.dumps({'subject':'Movies and television'})))
        for address in (url,unknown):
            db.add(ActivityLog(url=address,domain='youtube.com',started_at=now-dt.timedelta(minutes=10),
                               ended_at=now-dt.timedelta(minutes=5),duration_seconds=300))
        await db.commit()
    params={'today':(now-dt.timedelta(minutes=8)).isoformat(),'session':(now-dt.timedelta(minutes=7)).isoformat(),
            'week':(now-dt.timedelta(days=1)).isoformat()}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        first=await client.get('/api/activity/attention',params=params)
        assert first.status_code==200,first.text
        assert first.json()['today']=={'leisure':180,'other':0,'uncertain':180}
        assert first.json()['session']['leisure']==120
        assert first.json()['week']['leisure']==300
        assert (await client.put('/api/activity/attention',json={'url':url,'choice':'other'})).status_code==200
        result=(await client.get('/api/activity/attention',params=params)).json()
        assert result['today']=={'leisure':0,'other':180,'uncertain':180}
