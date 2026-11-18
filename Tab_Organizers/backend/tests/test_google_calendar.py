import datetime as dt
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.fernet import Fernet

from app.config import settings
from app.main import app
from app.routers import google_calendar as routes
from app.services import google_calendar as calendar


def reminder(**changes):
    return {
        'id': 'fixture', 'title': 'Test reminder', 'note': 'Review the lesson',
        'url': 'https://example.org/lesson', 'at': 1899955800000, 'updatedAt': 1,
        'repeat': {'everyDays': 2, 'times': ['07:00', '19:00'],
                   'startDate': '2030-03-17', 'timezone': 'Asia/Kolkata'},
        **changes,
    }


def test_two_calendar_series_keep_wall_time_and_stop_on_completion():
    first = dt.datetime(2030, 3, 17, 7, tzinfo=calendar.ZoneInfo('Asia/Kolkata'))
    row = reminder(at=first.timestamp() * 1000, calendarStartAt=first.timestamp() * 1000)
    plan = calendar.event_plan(row)
    assert [item['start']['dateTime'] for item in plan] == [
        '2030-03-17T07:00:00+05:30', '2030-03-17T19:00:00+05:30',
    ]
    assert all(item['recurrence'] == ['RRULE:FREQ=DAILY;INTERVAL=2'] for item in plan)
    assert calendar.event_plan({**row, 'at': row['at'] + 12 * 3600000}) == plan
    snoozed = calendar.event_plan({**row, 'snoozedUntil': row['at'] + 900000})
    assert snoozed[0]['start']['dateTime'] == '2030-03-19T07:00:00+05:30'
    assert snoozed[1] == plan[1]
    assert snoozed[2]['start']['dateTime'] == '2030-03-17T01:45:00+00:00'
    assert 'recurrence' not in snoozed[2]
    assert calendar.event_plan({**row, 'completedAt': 9}) == []


@pytest.mark.asyncio
async def test_repeated_sync_reuses_events_and_done_deletes_them():
    items = {}
    calls = []

    def google(request):
        method = request.method
        calls.append(method)
        if method == 'GET':
            return httpx.Response(200, json={'items': list(items.values())})
        if method == 'POST':
            event = json.loads(request.content)
            assert event['reminders']['overrides'] == [{'method': 'popup', 'minutes': 0}]
            assert event['id'] not in items
            items[event['id']] = event
            return httpx.Response(200, json=event)
        if method == 'DELETE':
            items.pop(request.url.path.rsplit('/', 1)[-1])
            return httpx.Response(204)
        raise AssertionError(method)

    row = reminder(repeat=None)
    async with httpx.AsyncClient(base_url=calendar.API_URL, transport=httpx.MockTransport(google)) as client:
        await calendar.apply_events(client, '/calendars/test/events', row, calendar.event_plan(row))
        await calendar.apply_events(client, '/calendars/test/events', row, calendar.event_plan(row))
        assert calls.count('POST') == 1
        await calendar.apply_events(client, '/calendars/test/events', row, [])
    assert not items


@pytest.mark.asyncio
async def test_calendar_oauth_requires_owner_and_state_is_single_use(monkeypatch):
    monkeypatch.setattr(settings, 'APP_MODE', 'cloud')
    monkeypatch.setattr(settings, 'BACKEND_API_KEY', 'calendar-fixture-owner-key')
    monkeypatch.setattr(settings, 'GOOGLE_CLIENT_ID', 'fixture-id')
    monkeypatch.setattr(settings, 'GOOGLE_CLIENT_SECRET', 'fixture-secret')
    monkeypatch.setattr(settings, 'GOOGLE_CALENDAR_REDIRECT_URI', 'https://fixture.test/api/calendar/oauth/callback')
    monkeypatch.setattr(settings, 'GOOGLE_CALENDAR_TOKEN_KEY', Fernet.generate_key().decode())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.post('/api/calendar/oauth/start')).status_code == 401
        headers = {'Authorization': 'Bearer calendar-fixture-owner-key'}
        assert (await client.post('/api/calendar/test-alert')).status_code == 401
        assert (await client.post('/api/calendar/test-alert', headers=headers)).status_code == 409
        response = await client.post('/api/calendar/oauth/start', headers=headers)
        assert response.status_code == 200
        params = parse_qs(urlparse(response.json()['url']).query)
        assert params['access_type'] == ['offline']
        assert params['scope'] == [calendar.SCOPE]
        assert params['code_challenge_method'] == ['S256']
        assert 'fixture-secret' not in response.text
        path = '/api/calendar/oauth/callback'
        assert (await client.get(path, params={'state': 'incorrect'})).status_code == 400
        denied = await client.get(path, params={'state': params['state'][0], 'error': 'access_denied'})
        assert 'access was not granted' in denied.text
        replay = await client.get(path, params={'state': params['state'][0], 'error': 'access_denied'})
        assert 'expired' in replay.text
        assert routes.state_key(params['state'][0]).endswith(params['state'][0]) is False
