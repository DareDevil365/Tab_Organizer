"""Owner-initiated OAuth and Calendar sync controls."""
import base64
import datetime as dt
import hashlib
import json
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_maker, get_db
from app.models.cloud_state import AppDocument
from app.services import google_calendar as calendar

router = APIRouter(prefix='/api/calendar', tags=['calendar'])


def state_key(state: str) -> str:
    return calendar.STATE_KEY + ':' + hashlib.sha256(state.encode()).hexdigest()


def result_page(message: str, status: int = 200) -> HTMLResponse:
    return HTMLResponse(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Tab Organizer Calendar</title>'
        '<meta name="viewport" content="width=device-width"><body><main>'
        f'<h1>Tab Organizer Calendar</h1><p>{message}</p>'
        '<p>Close this tab and return to Reminders.</p></main></body></html>',
        status_code=status,
        headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"},
    )


@router.get('/status')
async def status(db: AsyncSession = Depends(get_db)):
    row = await db.get(AppDocument, calendar.LINK_KEY)
    connected = calendar.configured() and bool(row and json.loads(row.payload).get('token'))
    return {'configured': calendar.configured(), 'connected': connected}


@router.post('/oauth/start')
async def start_oauth(db: AsyncSession = Depends(get_db)):
    if not calendar.configured():
        raise HTTPException(503, 'Google Calendar credentials are missing on the backend.')
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    now = dt.datetime.now(calendar.UTC)
    await db.execute(delete(AppDocument).where(
        AppDocument.key.startswith(calendar.STATE_KEY + ':'), AppDocument.expires_at <= now,
    ))
    db.add(AppDocument(
        key=state_key(state),
        payload=json.dumps({'verifier': verifier}),
        expires_at=now + dt.timedelta(minutes=10),
    ))
    await db.commit()
    return {'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode({
        'client_id': settings.GOOGLE_CLIENT_ID,
        'redirect_uri': settings.GOOGLE_CALENDAR_REDIRECT_URI,
        'scope': calendar.SCOPE,
        'response_type': 'code',
        'access_type': 'offline',
        'prompt': 'consent',
        'state': state,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
    })}


async def backfill():
    async with async_session_maker() as db:
        await calendar.sync_pending(db, limit=10)


@router.get('/oauth/callback', response_class=HTMLResponse)
async def oauth_callback(
    background_tasks: BackgroundTasks,
    state: str = Query(default='', max_length=128),
    code: str = Query(default='', max_length=3000),
    error: str = Query(default='', max_length=100),
    db: AsyncSession = Depends(get_db),
):
    if not state or not calendar.configured():
        return result_page('Start the connection from the extension.', 400)
    consumed = (await db.execute(delete(AppDocument).where(
        AppDocument.key == state_key(state), AppDocument.expires_at > dt.datetime.now(calendar.UTC),
    ).returning(AppDocument.payload))).scalar_one_or_none()
    if not consumed:
        return result_page('This connection attempt has expired. Start a new one from Reminders.', 400)
    await db.commit()
    record = json.loads(consumed)
    if error or not code:
        return result_page('Google Calendar access was not granted.', 400)
    try:
        link_row = await db.get(AppDocument, calendar.LINK_KEY, with_for_update=True)
        old_link = json.loads(link_row.payload) if link_row else {}
        async with httpx.AsyncClient(base_url=calendar.API_URL, timeout=12) as client:
            token = await calendar.access_token(
                client, grant_type='authorization_code', code=code,
                redirect_uri=settings.GOOGLE_CALENDAR_REDIRECT_URI, code_verifier=record['verifier'],
            )
            if calendar.SCOPE not in token.get('scope', '').split() or not token.get('refresh_token'):
                return result_page('Google did not grant the requested calendar access.', 400)
            client.headers['Authorization'] = 'Bearer ' + token['access_token']
            calendar_id = old_link.get('calendar_id')
            if calendar_id:
                result = await client.get(calendar.calendar_path(calendar_id))
                if result.status_code in (403, 404, 410):
                    calendar_id = None
                else:
                    result.raise_for_status()
            if not calendar_id:
                result = await client.post('/calendars', json={'summary': calendar.CALENDAR_NAME})
                result.raise_for_status()
                calendar_id = result.json()['id']
        payload = json.dumps({'calendar_id': calendar_id,
                              'token': calendar.cipher().encrypt(token['refresh_token'].encode()).decode()})
        if link_row:
            link_row.payload = payload
        else:
            db.add(AppDocument(key=calendar.LINK_KEY, payload=payload))
        await db.commit()
    except (httpx.HTTPError, ValueError, KeyError):
        return result_page('Could not finish connecting to Google. Try starting again from Reminders.', 502)
    background_tasks.add_task(backfill)
    return result_page('Connected. Tab Organizer will sync reminders to your calendar.')


@router.post('/sync')
async def sync(db: AsyncSession = Depends(get_db)):
    return await calendar.sync_pending(db, limit=6)


@router.post('/test-alert')
async def test_alert(db: AsyncSession = Depends(get_db)):
    row = await db.get(AppDocument, calendar.LINK_KEY)
    link = json.loads(row.payload) if row else {}
    if not calendar.configured() or not link.get('token'):
        raise HTTPException(409, 'Connect Google Calendar before sending a test alert.')
    when = (dt.datetime.now(calendar.UTC) + dt.timedelta(minutes=2)).replace(microsecond=0)
    try:
        async with httpx.AsyncClient(base_url=calendar.API_URL, timeout=6) as client:
            token = calendar.cipher().decrypt(link['token'].encode()).decode()
            access = await calendar.access_token(client, grant_type='refresh_token', refresh_token=token)
            client.headers['Authorization'] = 'Bearer ' + access['access_token']
            response = await client.post(calendar.calendar_path(link['calendar_id']) + '/events', json={
                'summary': 'Tab Organizer phone alert test',
                'start': {'dateTime': when.isoformat()},
                'end': {'dateTime': (when + dt.timedelta(minutes=5)).isoformat()},
                'transparency': 'transparent',
                'reminders': {'useDefault': False, 'overrides': [{'method': 'popup', 'minutes': 0}]},
            })
            response.raise_for_status()
            created = response.json()
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(502, 'Google Calendar could not schedule the test. Try reconnecting.') from None
    return {'at': when.isoformat(), 'eventUrl': created.get('htmlLink')}


@router.post('/disconnect')
async def disconnect(db: AsyncSession = Depends(get_db)):
    row = await db.get(AppDocument, calendar.LINK_KEY, with_for_update=True)
    if row:
        link = json.loads(row.payload)
        row.payload = json.dumps({'calendar_id': link['calendar_id']})
    await db.execute(delete(AppDocument).where(AppDocument.key.startswith(calendar.STATE_KEY + ':')))
    await db.commit()
    return {'connected': False}
