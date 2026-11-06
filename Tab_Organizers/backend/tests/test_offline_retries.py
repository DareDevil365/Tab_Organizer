import pytest
from httpx import AsyncClient,ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_collection_retry_after_lost_response_creates_one_collection():
    payload={'name':'Offline fixture','client_id':'fixture-request-000001','tabs':[{'url':'https://example.test/saved','title':'Saved reference'}]}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        first=await client.post('/api/groups',json=payload)
        retry=await client.post('/api/groups',json=payload)
        assert first.status_code==retry.status_code==201
        assert first.json()['id']==retry.json()['id']
        assert len((await client.get('/api/groups')).json())==1
        await client.delete('/api/groups/'+str(first.json()['id']))
        assert (await client.post('/api/groups',json=payload)).status_code==409

@pytest.mark.asyncio
async def test_delete_receipt_restores_the_resource_and_notes():
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        note={'id':'offline-note-fixture','video_url':'https://example.test/reference','timestamped_url':'https://example.test/reference','video_title':'Useful reference material','comment':'Keep this note','timestamp_seconds':0,'timestamp_formatted':'00:00','created_at':'2026-10-31T10:00:00Z'}
        first=(await client.post('/api/companion',json=note)).json()
        assert (await client.post('/api/companion',json=note)).json()['id']==first['id']
        removed=await client.delete('/api/pages/'+str(first['page_id']))
        assert removed.status_code==204 and removed.headers['X-Recycle-Id']
        restored=await client.post('/api/recycle-bin/'+removed.headers['X-Recycle-Id']+'/restore',json={})
        assert restored.status_code==200
        notes=(await client.get('/api/companion')).json()
        assert len(notes)==1 and notes[0]['comment']=='Keep this note'
        assert notes[0]['created_at'].startswith('2026-10-31T10:00:00')

def test_search_navigation_does_not_become_graph_subject_evidence():
    from app.services.topic_discovery import content_document
    doc=content_document({'id':1,'title':'ResearchTool - Google Search','full_text':'Television movies entertainment navigation sign in '*100})
    assert doc['title']=='ResearchTool'
    assert doc['needs_context'] and 'Television' not in doc['text']
    assert not content_document({'id':2,'title':'ResearchTool','description':'A tool for research literature discovery, citations and academic reading.'})['needs_context']
