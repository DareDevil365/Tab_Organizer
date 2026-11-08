import pytest
from httpx import ASGITransport, AsyncClient
from app import database
from app.main import app
from app.models.page import Page
from app.services.content_subjects import subject_path, semantic_content
from app.services.graph_service import build_knowledge_graph
from app.services.subject_taxonomy import CONCEPTS, canonical_subject_path


@pytest.mark.parametrize('topic', ['Programming', 'programming', ' Software Engineering ', 'Technology > Programming'])
def test_saved_topic_is_not_evidence_for_a_vague_title(topic):
    assert subject_path({'title': 'Cloudflare Cooked', 'topic': topic}) == ('Needs a Topic',)
    assert subject_path({'title': 'Programming explained'}) == ('Technology', 'Programming')


def test_aliases_and_known_categories_resolve_without_overriding_specific_content():
    assert subject_path({'title': 'An interesting resource', 'topic': 'Artificial Intelligence'}) == ('Needs a Topic',)
    assert subject_path({'title': 'An interesting resource', 'category': 'Programming'}) == ('Needs a Topic',)
    assert subject_path({'title': 'Typography for interfaces', 'topic': 'Programming'}) == ('Creative Work', 'Design', 'Typography')
    assert subject_path({'title': 'An interesting resource', 'category': 'My private bookmark folder'}) == ('Needs a Topic',)
    assert subject_path({'title': 'An interesting resource', 'topic': 'My special subject'}) == ('Needs a Topic',)
    for path, _ in CONCEPTS:
        for i in range(1, len(path) + 1):
            assert canonical_subject_path(path[i - 1]) == path[:i]
    assert canonical_subject_path('Artificial Intelligence & Machine Learning') == ('Technology', 'AI & Machine Learning')


def assert_rooted_tree(graph):
    nodes = {n['id']: n for n in graph['nodes']}
    assert len(nodes) == len(graph['nodes'])
    if not nodes:
        assert graph['edges'] == []
        return
    assert [n['id'] for n in nodes.values() if n['parent_id'] is None] == ['knowledge_root']
    assert len(graph['edges']) == len(nodes) - 1
    assert {(e['source'], e['target']) for e in graph['edges']} == {(n['parent_id'], n['id']) for n in nodes.values() if n['parent_id']}
    for node in nodes.values():
        visited = set()
        current = node
        while current['parent_id']:
            assert current['id'] not in visited
            visited.add(current['id'])
            current = nodes[current['parent_id']]
        assert current['id'] == 'knowledge_root'


@pytest.mark.asyncio
async def test_mixed_metadata_yields_one_programming_concept_and_preserves_resources():
    async with database.async_session_maker() as db:
        resources = [
            Page(url_original='https://one.test', url_normalized='https://one.test', title='Cloudflare Cooked', topic='Programming'),
            Page(url_original='https://two.test', url_normalized='https://two.test', title='FastAPI Repo'),
            Page(url_original='https://three.test', url_normalized='https://three.test', title='Web programming', topic='Software Engineering'),
            Page(url_original='https://four.test', url_normalized='https://four.test', title='Resource', topic='technology::programming'),
        ]
        db.add_all(resources)
        await db.commit()
        graph = await build_knowledge_graph(db)
        assert_rooted_tree(graph)
        assert len({n['id'] for n in graph['nodes']}) == len(graph['nodes'])
        assert not any(n['label'] == 'youtube.com' for n in graph['nodes'])
        assert len([n for n in graph['nodes'] if n['type'] == 'page']) == 4
        assert resources[0].topic == 'Programming'  # Projection never rewrites saved metadata.
        assert 'Programming' not in semantic_content(resources[0])


@pytest.mark.asyncio
async def test_default_graph_includes_resources_beyond_old_500_cutoff_and_reports_explicit_limits():
    async with database.async_session_maker() as db:
        db.add_all([Page(url_original=f'https://fixture.test/{i}', url_normalized=f'https://fixture.test/{i}',
                         title=f'Saved reference {i}', topic='Programming') for i in range(503)])
        await db.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/api/graph')
        assert response.status_code == 200
        graph = response.json()
        assert graph['schema'] == 'connections-v1'
        assert graph['resource_count'] == graph['total_resources'] == 503
        assert graph['is_truncated'] is False
        assert_rooted_tree(graph)
        limited = (await client.get('/api/graph?limit=17')).json()
        assert limited['resource_count'] == 17 and limited['total_resources'] == 503
        assert limited['is_truncated'] is True
        assert_rooted_tree(limited)


@pytest.mark.asyncio
async def test_empty_library_has_no_phantom_subjects():
    async with database.async_session_maker() as db:
        graph = await build_knowledge_graph(db)
        assert graph['resource_count'] == graph['total_resources'] == 0
        assert not graph['is_truncated']
        assert graph['nodes'] == graph['edges'] == []
