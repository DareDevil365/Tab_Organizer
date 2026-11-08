import datetime as dt
import json
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from app import database
from app.main import app
from app.models.cloud_state import AppDocument
from app.models.activity import ActivityLog
from app.models.page import Page
from app.services import activity_subjects as subjects
from app.routers.activity import summarize_activity


def activity(title=None, channel=None, url='https://www.youtube.com/watch?v=ABCDEFGHIJK', seconds=60):
    end=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=5)
    return dict(url=url,domain='youtube.com',title=title,channel=channel,started_at=(end-dt.timedelta(seconds=seconds)).isoformat(),ended_at=end.isoformat(),duration_seconds=seconds)


@pytest.mark.asyncio
async def test_unsaved_video_gets_subject_without_creating_library_pages_or_rewriting_time(monkeypatch):
    calls=[]
    async def infer(items, headings):
        calls.extend(items)
        return {item['id']:'Entertainment' for item in items}
    async def no_fetch(url):return {}
    monkeypatch.setattr(subjects,'infer_subjects',infer)
    monkeypatch.setattr(subjects,'public_video_metadata',no_fetch)
    item=activity('I made a ridiculous robot for a challenge','A maker comedy channel')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        saved=await client.post('/api/activity',json={'activities':[item]})
        assert saved.status_code==201 and saved.json()['classification_pending']
        assert calls==[]  # Recording a time interval cannot wait on AI.
        result=await client.post('/api/activity/classify',json={'limit':20})
        assert result.status_code==200 and result.json()['classified']==1
        summary=(await client.get('/api/activity/summary?days=1')).json()
        assert summary['total_seconds']==60
        assert summary['topic_breakdown'][0]['topic']=='Entertainment'
        assert (await client.get('/api/pages')).json()==[]
        again=await client.post('/api/activity/classify',json={'limit':20})
        assert again.json()['classified']==0
    assert len(calls)==1 and calls[0]['channel']=='A maker comedy channel'
    assert set(calls[0])=={'id','title','channel','description'}


@pytest.mark.asyncio
async def test_old_other_video_recovers_public_title_and_channel_then_uses_new_generated_subject(monkeypatch):
    async def metadata(url):return {'title':'A transistor amplifier experiment','channel':'Electronics lab'}
    async def infer(items, headings):return {item['id']:'Electronics' for item in items}
    monkeypatch.setattr(subjects,'public_video_metadata',metadata)
    monkeypatch.setattr(subjects,'infer_subjects',infer)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        await client.post('/api/activity',json={'activities':[activity()]})
        assert (await client.post('/api/activity/classify',json={})).json()['classified']==1
        result=(await client.get('/api/activity/summary?days=1')).json()
        assert result['topic_breakdown'][0]['topic']=='Electronics'
        assert result['total_seconds']==60


@pytest.mark.asyncio
async def test_provider_failure_and_ambiguous_metadata_keep_unknown_and_back_off(monkeypatch):
    async def fail(items, headings):raise RuntimeError('Provider exhausted')
    async def metadata(url):return {}
    monkeypatch.setattr(subjects,'infer_subjects',fail)
    monkeypatch.setattr(subjects,'public_video_metadata',metadata)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        await client.post('/api/activity',json={'activities':[activity('A real title','Some channel')]})
        result=(await client.post('/api/activity/classify',json={})).json()
        assert result['provider_unavailable'] and result['classified']==0
        assert (await client.post('/api/activity/classify',json={})).json()['provider_unavailable']
        summary=(await client.get('/api/activity/summary?days=1')).json()
        assert summary['total_seconds']==60 and summary['top_topic']=='other'


@pytest.mark.asyncio
async def test_saved_topic_still_resolves_historical_unspecified_intervals_without_ai():
    item=activity(url='https://example.org/calculus')
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        await client.post('/api/activity',json={'activities':[item]})
        async with database.async_session_maker() as db:
            db.add(Page(url_original=item['url'],url_normalized=item['url'],title='Calculus',topic='Mathematics'))
            await db.commit()
        result=(await client.get('/api/activity/summary?days=1')).json()
        assert result['top_topic']=='Mathematics' and result['total_seconds']==60


def test_small_recent_interests_fold_away_while_new_frequent_subjects_gain_headings():
    now=dt.datetime.now(dt.timezone.utc)
    seconds={'Entertainment':20000,'Mathematics':10000,'Electronics':5000,'Artificial Intelligence':2000,'Design':10}
    logs=[ActivityLog(url=f'https://example.org/{index}',domain='example.org',topic=topic,started_at=now-dt.timedelta(seconds=duration),ended_at=now,duration_seconds=duration) for index,(topic,duration) in enumerate(seconds.items())]
    result=summarize_activity(logs,1,now)
    headings={item.topic for item in result.topic_breakdown}
    assert {'Entertainment','Mathematics','Electronics'}.issubset(headings)
    assert 'Design' not in headings and 'Other subjects' in headings
    assert sum(item.duration_seconds for item in result.topic_breakdown)==sum(seconds.values())


def test_more_than_ten_subjects_preserve_all_seconds_and_only_recent_subjects_appear():
    now=dt.datetime.now(dt.timezone.utc)
    logs=[ActivityLog(url=f'https://example.org/{index}',domain='example.org',topic=f'Subject {index}',started_at=now-dt.timedelta(seconds=60),ended_at=now,duration_seconds=60) for index in range(15)]
    logs.append(ActivityLog(url='https://example.org/old',domain='example.org',topic='Old design interest',started_at=now-dt.timedelta(days=20,seconds=60),ended_at=now-dt.timedelta(days=20),duration_seconds=60))
    result=summarize_activity(logs,1,now)
    assert result.total_seconds==900
    assert sum(item.duration_seconds for item in result.topic_breakdown)==900
    assert 'Old design interest' not in [item.topic for item in result.topic_breakdown]
    assert result.topic_breakdown[-1].topic=='Other subjects'


@pytest.mark.asyncio
async def test_a_second_job_cannot_classify_the_same_content_concurrently():
    async with database.async_session_maker() as db:
        db.add(AppDocument(key='activity-subject-job-v1',payload='another-job',expires_at=dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=60)))
        await db.commit()
        assert (await subjects.classify_activity_subjects(db))['busy'] is True


@pytest.mark.asyncio
async def test_classifier_prompt_uses_metadata_not_urls_notes_or_a_fixed_taxonomy(monkeypatch):
    captured=[]
    class Provider:
        async def generate_response(self,prompt,**kwargs):
            captured.append(prompt)
            return '[{"id":1,"subject":"Mathematics","confidence":0.92},{"id":2,"subject":"youtube.com","confidence":0.99},{"id":3,"subject":"Guess","confidence":0.2}]'
    async def provider():return Provider()
    from app.services import ai_provider
    monkeypatch.setattr(ai_provider,'get_ai_provider',provider)
    result=await subjects.infer_subjects([{'id':1,'title':'Eigenvalues','channel':'Math lesson','description':''},{'id':2,'title':'Unknown','channel':'','description':''},{'id':3,'title':'Other','channel':'','description':''}],['Design'])
    assert result=={1:'Mathematics'}
    assert 'no fixed taxonomy' in captured[0] and 'Eigenvalues' in captured[0]


@pytest.mark.asyncio
async def test_new_live_metadata_wins_over_a_classification_based_on_an_old_title(monkeypatch):
    item=activity('An old comedy title','A channel')
    async def infer(items, headings):
        async with database.async_session_maker() as db:
            document=await db.get(AppDocument,subjects.content_key(item['url']))
            document.payload=json.dumps({'url':item['url'],'title':'New mathematics lesson','channel':'A channel'})
            await db.commit()
        return {row['id']:'Entertainment' for row in items}
    async def metadata(url):return {}
    monkeypatch.setattr(subjects,'infer_subjects',infer)
    monkeypatch.setattr(subjects,'public_video_metadata',metadata)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        await client.post('/api/activity',json={'activities':[item]})
        result=(await client.post('/api/activity/classify',json={})).json()
        assert result['classified']==0
    async with database.async_session_maker() as db:
        document=await db.get(AppDocument,subjects.content_key(item['url']))
        data=json.loads(document.payload)
        assert data['title']=='New mathematics lesson' and 'subject' not in data
