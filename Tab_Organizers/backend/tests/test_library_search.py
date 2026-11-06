import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient
from app import database
from app.main import app
from app.models.page import Page
from app.models.companion import CompanionNote
from app.services import library_search as search


def document(id, title, text=None):
    return {'id': id, 'title': title, 'text': text or title, 'url': f'https://reference.test/{id}'}


def test_related_tools_and_typos_rank_above_unrelated_without_dropping_anything(monkeypatch):
    monkeypatch.setattr(search, '_semantic_scores', lambda texts, query: (np.zeros(len(texts)), 'related-text'))
    docs = [document(1, 'Gardening essentials'), document(2, 'Video editing tutorial'),
            document(3, 'After Effects compositing'), document(4, 'News for Motion Designers')]
    docs += [document(i, f'Saved reference {i}') for i in range(5, 145)]
    normal = search.rank_documents(docs, 'video editing')
    typo = search.rank_documents(docs, 'viddeo edditing')
    assert typo['interpreted_query'] == 'video editing'
    assert typo['results'] == normal['results']
    assert normal['results'][0]['id'] == 2
    assert {item['id'] for item in normal['results'][:3]} == {2, 3, 4}
    assert len(normal['results']) == len(docs)
    assert {item['id'] for item in normal['results']} == {d['id'] for d in docs}
    assert all(0 <= item['score'] <= 100 for item in normal['results'])


def test_semantic_similarity_can_rank_without_shared_words(monkeypatch):
    monkeypatch.setattr(search, '_semantic_scores', lambda texts, query: (np.array([.08, .85]), 'semantic'))
    ranked = search.rank_documents([document(1, 'Gardening'), document(2, 'Cutting a cinematic sequence')], 'post production')
    assert ranked['mode'] == 'semantic'
    assert ranked['results'][0]['id'] == 2


@pytest.mark.asyncio
async def test_search_uses_saved_notes_and_clean_content_without_changing_data(monkeypatch):
    captured = []
    def encode(texts, query):
        captured.extend(texts)
        return np.zeros(len(texts)), 'related-text'
    monkeypatch.setattr(search, '_semantic_scores', encode)
    async with database.async_session_maker() as db:
        page = Page(url_original='https://www.youtube.com/watch?v=private', url_normalized='https://www.youtube.com/watch?v=private',
                    title='A useful reference - YouTube', description='More at https://private.test/path')
        db.add(page)
        await db.flush()
        db.add(CompanionNote(id='note-fixture', page_id=page.id, video_url=page.url_original,
                             timestamped_url=page.url_original, video_title=page.title, comment='After Effects color grading'))
        await db.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/api/search', json={'query': 'video editing'})
        assert response.status_code == 200
        assert response.json()['results'][0]['score'] > 0
    assert 'After Effects color grading' in captured[0]
    assert not any(token in captured[0].lower() for token in ['youtube', 'https://', 'private.test'])
    async with database.async_session_maker() as db:
        saved = await db.get(Page, page.id)
        assert saved.title == 'A useful reference - YouTube'


@pytest.mark.asyncio
@pytest.mark.parametrize('query', ['', '   ', 'x' * 501])
async def test_invalid_query_is_rejected(query):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.post('/api/search', json={'query': query})).status_code == 422


def test_missing_model_has_honest_fallback_and_stable_complete_results(monkeypatch):
    def unavailable(*args):
        raise RuntimeError('Model unavailable')
    monkeypatch.setattr(search, '_semantic_scores', unavailable)
    ranked = search.rank_documents([document(1, 'Unknown'), document(2, 'Unknown')], 'zoology')
    assert ranked['mode'] == 'related-text'
    assert ranked['results'] == [{'id': 1, 'score': 0}, {'id': 2, 'score': 0}]
