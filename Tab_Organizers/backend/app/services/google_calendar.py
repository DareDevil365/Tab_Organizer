"""Google Calendar integration for the owner of this backend."""
import asyncio
import datetime as dt
import hashlib
import json
import logging
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_maker
from app.models.cloud_state import AppDocument

SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
LINK_KEY = 'google-calendar:link'
STATE_KEY = 'google-calendar:state'
REMINDER_PREFIX = 'page-reminder:'
SYNC_PREFIX = 'google-calendar:reminder:'
CALENDAR_NAME = 'Tab Organizer Reminders'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
API_URL = 'https://www.googleapis.com/calendar/v3'
UTC = dt.timezone.utc
log = logging.getLogger(__name__)


def configured() -> bool:
    return bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET
                and settings.GOOGLE_CALENDAR_REDIRECT_URI and settings.GOOGLE_CALENDAR_TOKEN_KEY)


def cipher() -> Fernet:
    return Fernet(settings.GOOGLE_CALENDAR_TOKEN_KEY.encode())


async def access_token(client: httpx.AsyncClient, **grant):
    response = await client.post(TOKEN_URL, data={
        'client_id': settings.GOOGLE_CLIENT_ID,
        'client_secret': settings.GOOGLE_CLIENT_SECRET,
        **grant,
    })
    response.raise_for_status()
    return response.json()


def calendar_path(calendar_id: str) -> str:
    return '/calendars/' + quote(calendar_id, safe='')


def is_active(row: dict, now: dt.datetime) -> bool:
    if row.get('completedAt') or row.get('deletedAt'):
        return False
    return bool(row.get('repeat') or row['at'] > now.timestamp() * 1000)


def recurring_start(start: dt.date, time: dt.time, interval: int, zone: ZoneInfo,
                    earliest: dt.datetime) -> dt.datetime:
    days = (earliest.astimezone(zone).date() - start).days
    occurrence = start + dt.timedelta(days=max(0, days // interval) * interval)
    while True:
        wall_time = dt.datetime.combine(occurrence, time)
        candidate = wall_time.replace(tzinfo=zone)
        # A spring-forward gap cannot represent the requested wall time.
        if (candidate.astimezone(UTC) >= earliest
                and candidate.astimezone(UTC).astimezone(zone).replace(tzinfo=None) == wall_time):
            return candidate
        occurrence += dt.timedelta(days=interval)


def event_plan(row: dict) -> list[dict]:
    if row.get('completedAt') or row.get('deletedAt'):
        return []
    repeat = row.get('repeat')
    at = dt.datetime.fromtimestamp(row['at'] / 1000, UTC)
    first = dt.datetime.fromtimestamp((row.get('calendarStartAt') or row['at']) / 1000, UTC)
    snoozed = row.get('snoozedUntil')
    text = '\n\n'.join(part for part in (row['note'], row['url']) if part)
    shared = {
        'summary': row['title'],
        'description': text,
        'transparency': 'transparent',
        'reminders': {'useDefault': False, 'overrides': [{'method': 'popup', 'minutes': 0}]},
        'extendedProperties': {'private': {'tabOrganizerReminder': row['id']}},
    }

    def event(when: dt.datetime, recurrence=None, zone=None):
        stop = (when.astimezone(UTC) + dt.timedelta(minutes=15)).astimezone(when.tzinfo)
        body = {
            **shared,
            'start': {'dateTime': when.isoformat()},
            'end': {'dateTime': stop.isoformat()},
        }
        if recurrence:
            body['recurrence'] = [recurrence]
            body['start']['timeZone'] = zone
            body['end']['timeZone'] = zone
        return body

    if not repeat:
        # Keep a delivered one-off event on the calendar until Done or Remove.
        return [event(at)]

    zone = ZoneInfo(repeat['timezone'])
    interval = repeat['everyDays']
    start = dt.date.fromisoformat(repeat['startDate'])
    # After a snooze, resume the same series at the first slot after the snoozed time.
    earliest = max(first, dt.datetime.fromtimestamp(snoozed / 1000, UTC) + dt.timedelta(seconds=1)) if snoozed else first
    events = [
        event(recurring_start(start, dt.time.fromisoformat(slot), interval, zone, earliest),
              f'RRULE:FREQ=DAILY;INTERVAL={interval}', repeat['timezone'])
        for slot in repeat['times']
    ]
    if snoozed:
        events.append(event(dt.datetime.fromtimestamp(snoozed / 1000, UTC)))
    return events


async def list_reminder_events(client: httpx.AsyncClient, path: str, reminder_id: str) -> list[dict]:
    events = []
    params = {'privateExtendedProperty': f'tabOrganizerReminder={reminder_id}'}
    while True:
        result = await client.get(path, params=params)
        result.raise_for_status()
        data = result.json()
        events.extend(data.get('items', []))
        if not data.get('nextPageToken'):
            return events
        params['pageToken'] = data['nextPageToken']


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


async def apply_events(client: httpx.AsyncClient, path: str, row: dict, events: list[dict]) -> None:
    existing = await list_reminder_events(client, path, row['id'])
    # Reuse equivalent events, including a prior write whose response got lost.
    # Different schedules get different IDs so a delayed retry cannot duplicate an alert.
    expected_ids = set()
    for event in events:
        plan = digest(event)
        matching = next((item for item in existing if
            item.get('extendedProperties', {}).get('private', {}).get('tabOrganizerPlan') == plan), None)
        if matching:
            expected_ids.add(matching['id'])
            continue
        event_id = digest([row['id'], row['updatedAt'], plan])
        body = {
            **event, 'id': event_id,
            'extendedProperties': {'private': {**event['extendedProperties']['private'], 'tabOrganizerPlan': plan}},
        }
        response = await client.post(path, json=body)
        if response.status_code == 409:
            previous = await client.get(path + '/' + event_id)
            gone = previous.status_code in (404, 410)
            if not gone:
                previous.raise_for_status()
            if gone or previous.json().get('status') == 'cancelled':
                # Google can retain a deleted event's ID. Use a new deterministic
                # ID for this retry while preserving the same plan marker.
                body['id'] = digest([event_id, 'replacement'])
                event_id = body['id']
                response = await client.post(path, json=body)
            else:
                response = previous
        response.raise_for_status()
        expected_ids.add(event_id)
    for item in existing:
        if item['id'] not in expected_ids:
            response = await client.delete(path + '/' + quote(item['id'], safe=''))
            if response.status_code not in (404, 410):
                response.raise_for_status()


async def sync_one(db: AsyncSession, reminder_id: str) -> bool:
    """Lock the reminder while writing its current plan, preserving edit order."""
    if not configured():
        return False
    row = await db.get(AppDocument, REMINDER_PREFIX + reminder_id, with_for_update=True)
    link_row = await db.get(AppDocument, LINK_KEY)
    if not row or not link_row:
        return False
    link = json.loads(link_row.payload)
    if not link.get('token'):
        return False
    reminder = json.loads(row.payload)
    now = dt.datetime.now(UTC)
    marker_key = SYNC_PREFIX + reminder_id
    marker = await db.get(AppDocument, marker_key)
    prior = json.loads(marker.payload) if marker else {}
    current_calendar = prior.get('calendar_id') == link['calendar_id']
    events = event_plan(reminder)
    if not current_calendar and not is_active(reminder, now):
        events = []
    signature = digest(events)
    if current_calendar and prior.get('signature') == signature:
        return False
    async with httpx.AsyncClient(base_url=API_URL, timeout=7) as client:
        # Token calls use a separate origin, so the Calendar bearer never leaves
        # Google Calendar and the client secret only goes to Google's token server.
        token = cipher().decrypt(link['token'].encode()).decode()
        result = await access_token(client, grant_type='refresh_token', refresh_token=token)
        client.headers['Authorization'] = 'Bearer ' + result['access_token']
        await apply_events(client, calendar_path(link['calendar_id']) + '/events', reminder, events)
    payload = json.dumps({'calendar_id': link['calendar_id'], 'signature': signature})
    if marker:
        marker.payload = payload
    else:
        db.add(AppDocument(key=marker_key, payload=payload))
    await db.commit()
    return True


async def sync_saved_reminder(reminder_id: str) -> None:
    try:
        async with async_session_maker() as db:
            await asyncio.wait_for(sync_one(db, reminder_id), timeout=12)
    except Exception as exc:
        # Keep the snapshot eligible for retry without logging request payloads,
        # Google tokens, or reminder text.
        log.warning('Calendar reminder sync deferred (%s)', type(exc).__name__)


async def sync_pending(db: AsyncSession, *, limit: int = 30, budget: int = 32) -> dict:
    link = await db.get(AppDocument, LINK_KEY) if configured() else None
    if not link or not json.loads(link.payload).get('token'):
        return {'synced': 0, 'failed': 0}
    reminders = (await db.execute(select(AppDocument.key).where(
        AppDocument.key.startswith(REMINDER_PREFIX)).order_by(AppDocument.key))).scalars().all()
    await db.rollback()
    clock = asyncio.get_running_loop().time
    deadline = clock() + budget
    synced = failed = 0
    for key in reminders:
        remaining = deadline - clock()
        if synced + failed >= limit or remaining <= 0:
            break
        try:
            synced += await asyncio.wait_for(sync_one(db, key.removeprefix(REMINDER_PREFIX)), timeout=min(12, remaining))
        except Exception as exc:
            failed += 1
            log.warning('Calendar reminder retry deferred (%s)', type(exc).__name__)
        finally:
            await db.rollback()
    return {'synced': synced, 'failed': failed}
