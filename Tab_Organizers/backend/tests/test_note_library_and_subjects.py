import pytest
import numpy as np
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from app.main import app
from app import database
from app.models.page import Page
from app.models.companion import CompanionNote
from app.models.embedding import PageEmbedding
from app.services.content_subjects import subject_path, semantic_content
from app.services.note_library import link_existing_notes


def note(note_id='first', url='https://www.youtube.com/watch?v=abcdefghijk&t=42s'):
    return dict(id=note_id, video_url=url, timestamped_url=url,
                video_title='Transformers and attention explained', comment='Remember this idea',
                timestamp_seconds=42, timestamp_formatted='00:42')


@pytest.mark.asyncio
async def test_deleting_resource_removes_owned_notes_and_vectors_without_startup_resurrection():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        first = (await client.post('/api/companion', json=note())).json()
        other = (await client.post('/api/companion', json=note('keep', 'https://www.youtube.com/watch?v=12345678901'))).json()
        async with database.async_session_maker() as db:
            db.add(PageEmbedding(page_id=first['page_id'], vector=b'[]', model_name='test'))
            await db.commit()
        assert (await client.delete(f"/api/pages/{first['page_id']}")).status_code == 204
        async with database.async_session_maker() as db:
            assert await link_existing_notes(db) == 0
            assert (await db.execute(select(PageEmbedding))).scalars().all() == []
        assert (await client.get(f"/api/pages/{first['page_id']}")).status_code == 404
        assert (await client.get(f"/api/pages/{other['page_id']}")).status_code == 200
        assert [n['id'] for n in (await client.get('/api/companion')).json()] == ['keep']


@pytest.mark.asyncio
async def test_note_save_creates_library_resource_and_filters_without_video_leaks():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        first = await client.post('/api/companion', json=note())
        assert first.status_code == 201
        page_id = first.json()['page_id']
        # Timestamp variations refer to one resource and retries don't duplicate notes.
        again = await client.post('/api/companion', json=note())
        assert again.json()['page_id'] == page_id
        await client.post('/api/companion', json=note('second', 'https://www.youtube.com/watch?v=abcdefghijk&t=65s'))
        await client.post('/api/companion', json=note('other', 'https://www.youtube.com/watch?v=12345678901'))
        pages = (await client.get('/api/pages?has_notes=true')).json()
        assert len(pages) == 2
        assert next(p for p in pages if p['id'] == page_id)['note_count'] == 2
        notes = (await client.get('/api/companion', params={'video_url': 'https://www.youtube.com/watch?v=abcdefghijk'})).json()
        assert {n['id'] for n in notes} == {'first', 'second'}
        await client.delete('/api/companion/first')
        await client.delete('/api/companion/second')
        assert len((await client.get('/api/pages?has_notes=true')).json()) == 1
        assert (await client.get(f'/api/pages/{page_id}')).json()['note_count'] == 0


@pytest.mark.asyncio
async def test_existing_page_flags_and_legacy_notes_are_preserved():
    async with database.async_session_maker() as db:
        page = Page(url_original='https://example.com/article', url_normalized='https://example.com/article',
                    title='My saved title', is_important=True, is_urgent=True)
        db.add(page)
        db.add(CompanionNote(**note('legacy', 'https://example.com/article')))
        await db.commit()
        assert await link_existing_notes(db) == 1
        assert await link_existing_notes(db) == 0
        assert page.title == 'My saved title'
        assert page.is_important and page.is_urgent
        saved = await db.get(CompanionNote, 'legacy')
        assert saved.page_id == page.id and saved.comment == 'Remember this idea'


def test_subjects_follow_titles_not_hosts():
    ai = {'title': 'Transformers explained - YouTube', 'domain': 'youtube.com', 'topic': 'Entertainment & Video'}
    art = {'title': 'Typography and interface craft - YouTube', 'domain': 'youtube.com'}
    assert subject_path(ai)[-1] == 'Transformers'
    assert 'Design' in subject_path(art)
    assert subject_path({'title': 'Build a project at this hackathon', 'domain': 'devfolio.co'})[-1] == 'Hackathons'
    assert subject_path({'title': 'Devfolio', 'domain': 'devfolio.co'})[-1] == 'Hackathons'
    text = semantic_content({**ai, 'description': 'Watch https://youtube.com/watch?v=abcdefghijk on YouTube'})
    assert 'youtube' not in text.lower() and 'https:' not in text
    assert 'Transformers' in text


def test_any_tld_and_url_only_titles_use_human_site_metadata():
    from app.services.content_subjects import clean_content, website_name
    assert clean_content('Visit example.ai and example.dev/path or https://example.ac/x') == 'Visit and or'
    page = {'title': 'https://devfolio.co/', 'url_original': 'https://devfolio.co/',
            'description': 'Discover hackathons and build projects with developers.'}
    assert website_name(page) == 'Devfolio'
    assert subject_path(page)[-1] == 'Hackathons'
    assert 'devfolio.co' not in semantic_content(page)


@pytest.mark.asyncio
async def test_all_rag_prompts_exclude_urls_but_ui_sources_keep_links(monkeypatch):
    from app.services import brain_service
    captured = []
    class Provider:
        async def generate_response(self, **kwargs):
            captured.append(kwargs)
            return 'Answer [1]'
    async def provider():
        return Provider()
    async def search(*args, **kwargs):
        return [{'id': 1, 'title': 'Transformers - YouTube', 'url': 'https://youtube.com/watch?v=abcdefghijk',
                 'url_normalized': 'https://youtube.com/watch?v=abcdefghijk', 'domain': 'youtube.com',
                 'topic': 'Artificial Intelligence', 'description': 'Attention explained at https://resource.ai/detail'}]
    monkeypatch.setattr(brain_service, 'get_ai_provider', provider)
    monkeypatch.setattr(brain_service, 'search_relevant_pages', search)
    async with database.async_session_maker() as db:
        page = Page(url_original='https://youtube.com/watch?v=abcdefghijk', url_normalized='https://youtube.com/watch?v=abcdefghijk',
                    domain='youtube.com', title='Transformers - YouTube', description='Attention explained at https://resource.ai/detail')
        db.add(page)
        await db.commit()
        response = await brain_service.ask_brain('Explain transformers', db)
        await brain_service.ask_page_brain(page.id, 'Summarize this', db)
        await brain_service.generate_learning_plan('Transformers', db)
        assert response['sources'][0]['url'].startswith('https://')
    assert len(captured) == 3
    for call in captured:
        text = str(call).lower()
        assert 'https://' not in text and 'youtube.com' not in text and 'resource.ai' not in text
        assert 'transformers' in text


@pytest.mark.asyncio
async def test_old_embeddings_rebuild_once_and_refresh_changed_content(monkeypatch):
    from app.services import brain_service
    encoded = []
    def encode(texts):
        encoded.extend(texts)
        return [np.ones(384, dtype=np.float32) for _ in texts]
    monkeypatch.setattr(brain_service, 'generate_embeddings_batch', encode)
    async with database.async_session_maker() as db:
        page = Page(url_original='https://youtube.com/watch?v=abcdefghijk', url_normalized='https://youtube.com/watch?v=abcdefghijk',
                    title='Neural networks on YouTube', domain='youtube.com')
        db.add(page)
        await db.flush()
        db.add(PageEmbedding(page_id=page.id, model_name='all-MiniLM-L6-v2:subjects-v2:oldfingerprint', vector=np.zeros(384, dtype=np.float32).tobytes()))
        await db.commit()
        assert await brain_service.ensure_page_embeddings(db) == 1
        assert 'youtube' not in encoded[0].lower()
        assert await brain_service.ensure_page_embeddings(db) == 0
        page.title = 'Typography for interfaces'
        await db.commit()
        assert await brain_service.ensure_page_embeddings(db) == 1
        assert len((await db.execute(select(PageEmbedding))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_query_embeddings_also_exclude_pasted_addresses(monkeypatch):
    from app.services import brain_service
    queries = []
    monkeypatch.setattr(brain_service, 'generate_embeddings_batch',
                        lambda texts: [np.ones(384, dtype=np.float32) for _ in texts])
    def encode_query(text):
        queries.append(text)
        return np.ones(384, dtype=np.float32)
    monkeypatch.setattr(brain_service, 'generate_embedding', encode_query)
    async with database.async_session_maker() as db:
        db.add(Page(url_original='https://example.ai/attention', url_normalized='https://example.ai/attention',
                    title='Transformers and attention'))
        await db.commit()
        results = await brain_service.search_relevant_pages('Explain transformers at https://example.ai/attention', db)
    assert queries == ['Explain transformers at']
    assert results[0]['url'] == 'https://example.ai/attention'
