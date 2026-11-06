"""Page reads must not synchronously run library-wide semantic discovery."""
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from app import database
from app.models.page import Page
from app.services import graph_service, topic_discovery


@pytest.mark.asyncio
async def test_page_reads_reuse_completed_headings_after_deletion_without_model_work(monkeypatch):
    async with database.async_session_maker() as db:
        pages = [Page(url_original=f'https://example.test/{i}', url_normalized=f'https://example.test/{i}',
                      title=f'Reference material {i}') for i in range(2)]
        db.add_all(pages)
        await db.commit()
        documents = [topic_discovery.content_document(page) for page in pages]
        ids = [page.id for page in pages]
    discovery = {'groups': [{'id': 'subject', 'label': 'Generated subject', 'parent_id': None}],
                 'memberships': [{'id': id, 'anchor': 'subject', 'topics': [{'id': 'subject'}]} for id in ids],
                 'document_keys': {str(doc['id']): topic_discovery.document_key(doc) for doc in documents}}
    topic_discovery.write_json(topic_discovery.CACHE_FILE, discovery)

    async def forbidden(*args):
        pytest.fail('A card read triggered full graph discovery')
    monkeypatch.setattr(graph_service, 'discovered_library', forbidden)
    monkeypatch.setattr(topic_discovery, 'discover_topics', forbidden)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        listing = (await client.get('/api/pages')).json()
        assert all(page['display_topic'] == 'Generated subject' for page in listing)
        assert (await client.get(f'/api/pages/{ids[0]}')).json()['display_topic'] == 'Generated subject'
        assert all(page['display_topic'] == 'Generated subject' for page in (await client.get('/api/pages/saved-status')).json())
        assert (await client.delete(f'/api/pages/{ids[1]}')).status_code == 204
        listing = (await client.get('/api/pages')).json()
        assert [page['id'] for page in listing] == [ids[0]]
        assert listing[0]['display_topic'] == 'Generated subject'
        # Changed content cannot inherit an obsolete generated heading by ID.
        await client.put(f'/api/pages/{ids[0]}', json={'title': 'Entirely different reference'})
        assert (await client.get(f'/api/pages/{ids[0]}')).json()['display_topic'] != 'Generated subject'
        assert (await client.get('/api/pages/saved-status')).json() == [
            {'url_original': 'https://example.test/0', 'url_normalized': 'https://example.test/0', 'display_topic': None}]


@pytest.mark.asyncio
async def test_uncached_page_reads_do_not_wait_for_discovery(monkeypatch):
    async def forbidden(*args):
        pytest.fail('An uncached card read triggered graph discovery')
    monkeypatch.setattr(graph_service, 'discovered_library', forbidden)
    async with database.async_session_maker() as db:
        db.add(Page(url_original='https://example.test/new', url_normalized='https://example.test/new', title='A new reference'))
        await db.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        pages = (await client.get('/api/pages')).json()
        assert len(pages) == 1
        assert (await client.get(f"/api/pages/{pages[0]['id']}")).status_code == 200
