import datetime as dt
from types import SimpleNamespace
import pytest
from app.routers.activity import summarize_activity
from app.main import app
from httpx import AsyncClient, ASGITransport

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 4, 12, tzinfo=UTC)

@pytest.mark.asyncio
async def test_retrying_a_committed_batch_does_not_double_count_time():
    item = {'url':'https://example.com/read','domain':'example.com',
            'started_at':'2026-11-04T11:00:00Z','ended_at':'2026-11-04T11:00:30Z','duration_seconds':30}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        first = await client.post('/api/activity',json={'activities':[item,item]})
        retry = await client.post('/api/activity',json={'activities':[dict(item,started_at='2026-11-04T16:30:00+05:30',ended_at='2026-11-04T16:30:30+05:30')]})
        next_interval = dict(item,started_at='2026-11-04T11:00:30Z',ended_at='2026-11-04T11:01:00Z')
        next_response = await client.post('/api/activity',json={'activities':[next_interval]})
    assert first.status_code == retry.status_code == next_response.status_code == 201
    assert first.json()['recorded'] == 1
    assert retry.json()['recorded'] == 0
    assert next_response.json()['recorded'] == 1
def interval(start, end, seconds=None, url='https://www.example.com/path', topic='Design'):
    return SimpleNamespace(started_at=start, ended_at=end, duration_seconds=seconds if seconds is not None else int((end-start).total_seconds()), url=url, domain='www.example.com', topic=topic)

def test_rolling_window_clips_intervals_on_both_boundaries():
    result=summarize_activity([
        interval(NOW-dt.timedelta(days=1,hours=1), NOW-dt.timedelta(days=1)+dt.timedelta(hours=1)),
        interval(NOW-dt.timedelta(hours=1), NOW+dt.timedelta(hours=1)),
    ], 1, NOW)
    assert result.total_seconds == 7200
    assert sum(day.duration_seconds for day in result.trends) == result.total_seconds
    assert len(result.trends) == 2  # Both partial local dates in a rolling 24 hours.

def test_browser_offset_splits_cross_midnight_and_merges_www_hosts():
    # Local midnight in UTC+05:30 is 18:30 UTC, not 00:00 UTC.
    start=dt.datetime(2026,11,3,18,20,tzinfo=UTC)
    result=summarize_activity([
        interval(start,start+dt.timedelta(minutes=20)),
        interval(start,start+dt.timedelta(minutes=10),url='https://example.com/other'),
    ],1,NOW,330)
    assert result.domain_breakdown[0].domain == 'example.com'
    assert len(result.domain_breakdown) == 1
    assert result.domain_breakdown[0].topic == 'Design'
    assert {day.date:day.duration_seconds for day in result.trends} == {'2026-11-03':1200,'2026-11-04':600}

def test_invalid_and_future_intervals_are_ignored_and_naive_legacy_dates_are_utc():
    result=summarize_activity([
        interval(NOW,NOW-dt.timedelta(seconds=10),seconds=10),
        interval(NOW+dt.timedelta(hours=1),NOW+dt.timedelta(hours=2)),
        interval((NOW-dt.timedelta(seconds=30)).replace(tzinfo=None),NOW.replace(tzinfo=None),seconds=999),
    ],1,NOW)
    assert result.total_seconds == 30

@pytest.mark.asyncio
async def test_activity_summary_accepts_browser_offset_and_rejects_invalid_offset():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        response=await client.get('/api/activity/summary?days=1&utc_offset_minutes=330')
        assert response.status_code==200
        assert response.json()['total_seconds']==0
        assert len(response.json()['trends'])==2
        assert (await client.get('/api/activity/summary?utc_offset_minutes=900')).status_code==422
