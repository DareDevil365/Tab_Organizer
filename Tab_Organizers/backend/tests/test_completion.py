import datetime
import pytest
from httpx import AsyncClient, ASGITransport
from sqlalchemy import create_engine, inspect
from app import database
from app.main import app
from app.models.page import Page
from app.services.completion import migrate_completion_column


async def save_pages(*pages):
    async with database.async_session_maker() as db:
        db.add_all(pages)
        await db.commit()
        for page in pages:
            await db.refresh(page)
    return [page.id for page in pages]


def resource(url, title, **kwargs):
    return Page(url_original=url, url_normalized=url, title=title, **kwargs)


@pytest.mark.asyncio
async def test_explicit_completion_is_idempotent_and_reversible_and_survives_resave():
    [pid] = await save_pages(resource('https://www.youtube.com/watch?v=abcdefghijk', 'Attention explained', domain='youtube.com', is_important=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        # A read/open timestamp is never completion.
        assert (await client.get(f'/api/pages/{pid}')).json()['completed_at'] is None
        opened = await client.put(f'/api/pages/{pid}', json={'last_seen_open_at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        assert opened.json()['completed_at'] is None
        first = (await client.put(f'/api/pages/{pid}/completion', json={'completed': True})).json()
        again = (await client.put(f'/api/pages/{pid}/completion', json={'completed': True})).json()
        assert first['completion_kind'] == 'watched'
        assert first['completed_at'].endswith('Z')
        assert again['completed_at'] == first['completed_at']
        saved = await client.post('/api/pages', json={'url_original': first['url_original'], 'url_normalized': first['url_normalized'], 'title': first['title'], 'domain': 'youtube.com'})
        assert saved.json()['completed_at'] == first['completed_at']
        assert len((await client.get('/api/pages?completed=true')).json()) == 1
        assert (await client.get('/api/pages?completed=false')).json() == []
        summary = (await client.get('/api/activity/completions?days=7')).json()
        assert (summary['completed'], summary['watched'], summary['read'], summary['unseen']) == (1, 1, 0, 0)
        assert (await client.put(f'/api/pages/{pid}/completion', json={'completed': False})).json()['completed_at'] is None
        assert len((await client.get('/api/pages?completed=false')).json()) == 1
        assert (await client.get('/api/activity/completions')).json()['completed'] == 0


@pytest.mark.asyncio
async def test_bulk_completion_is_atomic_preserves_other_fields_and_deduplicates_ids():
    first, second = await save_pages(resource('https://reference.example/a', 'Article', is_important=True), resource('https://vimeo.com/123', 'Video', domain='vimeo.com'))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.put('/api/pages/completion', json={'page_ids': [first, 999999], 'completed': True})).status_code == 404
        assert (await client.get(f'/api/pages/{first}')).json()['completed_at'] is None
        response = await client.put('/api/pages/completion', json={'page_ids': [first, first, second], 'completed': True})
        assert response.status_code == 200
        pages = {p['id']: p for p in response.json()}
        assert len(pages) == 2 and pages[first]['is_important'] is True
        assert pages[first]['completion_kind'] == 'read'
        assert pages[second]['completion_kind'] == 'watched'
        summary = (await client.get('/api/activity/completions')).json()
        assert (summary['completed'], summary['watched'], summary['read']) == (2, 1, 1)
        await client.put('/api/pages/completion', json={'page_ids': [first, second], 'completed': False})
        assert len((await client.get('/api/pages?completed=false')).json()) == 2
        assert (await client.put('/api/pages/completion', json={'page_ids': [], 'completed': True})).status_code == 422


@pytest.mark.asyncio
async def test_completion_period_excludes_old_and_future_dates_and_keeps_unseen_separate():
    now = datetime.datetime.now(datetime.timezone.utc)
    await save_pages(
        resource('https://reference.example/old', 'Older article', completed_at=now - datetime.timedelta(days=8)),
        resource('https://reference.example/recent', 'Recent article', completed_at=now - datetime.timedelta(hours=2)),
        resource('https://youtu.be/abcdefghijk', 'Recent video', completed_at=now - datetime.timedelta(days=2)),
        resource('https://reference.example/future', 'Future', completed_at=now + datetime.timedelta(days=2)),
        resource('https://reference.example/unseen', 'Unseen'),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        week = (await client.get('/api/activity/completions?days=7')).json()
        assert (week['completed'], week['watched'], week['read'], week['unseen']) == (2, 1, 1, 1)
        assert [p['title'] for p in week['recent']] == ['Recent article', 'Recent video']
        assert (await client.get('/api/activity/completions?days=1')).json()['completed'] == 1
        assert (await client.get('/api/activity/completions?days=0')).status_code == 422


@pytest.mark.asyncio
async def test_missing_page_completion_does_not_create_resources():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.put('/api/pages/999/completion', json={'completed': True})).status_code == 404
        assert (await client.get('/api/pages')).json() == []


def test_legacy_completion_migration_preserves_data_and_is_idempotent():
    engine = create_engine('sqlite:///:memory:')
    with engine.begin() as db:
        db.exec_driver_sql('CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT)')
        db.exec_driver_sql("INSERT INTO pages (title) VALUES ('Existing saved resource')")
        migrate_completion_column(db)
        migrate_completion_column(db)
        assert [col['name'] for col in inspect(db).get_columns('pages')].count('completed_at') == 1
        assert db.exec_driver_sql('SELECT title, completed_at FROM pages').one() == ('Existing saved resource', None)
    engine.dispose()


@pytest.mark.asyncio
async def test_completion_survives_backup_roundtrip_and_legacy_merge_preserves_state():
    [pid] = await save_pages(resource('https://reference.example/backup', 'Saved article'))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        completed = (await client.put(f'/api/pages/{pid}/completion', json={'completed': True})).json()['completed_at']
        backup = (await client.get('/api/backup/export')).json()
        assert backup['pages'][0]['completed_at'] is not None
        assert (await client.post('/api/backup/import?merge=false', json=backup)).status_code == 200
        pages = (await client.get('/api/pages')).json()
        assert len(pages) == 1 and pages[0]['completed_at'] == completed
        del backup['pages'][0]['completed_at']
        assert (await client.post('/api/backup/import?merge=true', json=backup)).status_code == 200
        assert (await client.get('/api/pages')).json()[0]['completed_at'] == completed
