import numpy as np
import pytest
from httpx import AsyncClient,ASGITransport
from app import database
from app.main import app
from app.models.page import Page
from app.models.companion import CompanionNote
from app.services import topic_discovery as discovery
from app.services.graph_service import build_knowledge_graph
infer_paths_impl=discovery.infer_resource_paths
consolidate_impl=discovery.consolidate_headings


def docs(count=30):
    return [{'id':i+1,'title':('Telescope galaxies nebula astronomy' if i<count//2 else 'Bread sourdough yeast baking')+f' {i}',
             'text':('Telescope galaxies nebula astronomy' if i<count//2 else 'Bread sourdough yeast baking')+f' {i}'} for i in range(count)]


def test_discovery_input_excludes_notes_urls_and_old_folder_topic_labels():
    document=discovery.content_document({'id':1,'title':'Galaxies - YouTube','description':'Exploring https://youtube.com/x nebulae',
         'url_original':'https://example.com','topic':'Programming','category':'Private folder','notes':'Finance note','full_text':'Stars and astronomy'})
    assert 'Galaxies' in document['text'] and 'astronomy' in document['text']
    assert not any(token in document['text'] for token in ['YouTube','youtube','https','Programming','Private','Finance'])


@pytest.mark.asyncio
async def test_program_discovers_unlisted_interests_and_avoids_splitting_five_resources():
    result=await discovery.discover_topics(docs())
    assert len(result['groups'])>=2
    assert len(result['memberships'])==30
    assert all('Needs a Topic' != g['label'] for g in result['groups'])
    labels=' '.join(g['label'].lower() for g in result['groups'])
    assert any(term in labels for term in ['telescope','astronomy','galaxies','nebula'])
    assert any(term in labels for term in ['bread','yeast','baking','sourdough'])
    small=await discovery.discover_topics(docs(5))
    assert len(small['groups'])==1


def test_cohesive_large_group_is_not_split_just_to_meet_a_quota():
    matrix=np.tile(np.array([1.,0.,0.]),(40,1))
    assert discovery.candidate_split(matrix,list(range(40)))==[]


def test_overlapping_content_keeps_one_resource_with_multiple_topic_memberships(monkeypatch):
    documents=[{'id':i,'title':str(i),'text':str(i)} for i in range(11)]
    matrix=np.array([[1.,0.]]*5+[[0.,1.]]*5+[[.707,.707]])
    def split(matrix,indices,root=False): return [list(range(5))+[10],list(range(5,10))] if root else []
    monkeypatch.setattr(discovery,'candidate_split',split)
    groups,memberships=discovery.discover_structure(documents,matrix,'local-semantic')
    assert len(groups)==2
    shared=next(item for item in memberships if item['id']==10)
    assert len(shared['topics'])==2
    assert sum(item['id']==10 for item in memberships)==1


@pytest.mark.asyncio
async def test_note_changes_do_not_rebuild_or_relabel_the_graph(monkeypatch):
    calls=[]
    def encode(texts): calls.append(texts);return discovery.encode_text_documents(texts),'text-similarity'
    monkeypatch.setattr(discovery,'encode_documents',encode)
    async with database.async_session_maker() as db:
        page=Page(url_original='https://example.test',url_normalized='https://example.test',title='Telescope galaxies')
        db.add(page);await db.flush()
        first=await build_knowledge_graph(db)
        db.add(CompanionNote(id='unrelated-note',page_id=page.id,video_url=page.url_original,timestamped_url=page.url_original,video_title=page.title,comment='This is my recipe shopping list'))
        await db.commit()
        second=await build_knowledge_graph(db)
        assert first==second and len(calls)==1
        assert not any('recipe' in text for text in calls[0])


@pytest.mark.asyncio
async def test_graph_exports_many_to_many_edges_and_deep_hierarchy_without_duplicate_resources(monkeypatch):
    async with database.async_session_maker() as db:
        page=Page(url_original='https://example.test',url_normalized='https://example.test',title='A mixed resource')
        db.add(page);await db.commit()
    groups=[{'id':f't{i}','label':f'Generated {i}','parent_id':f't{i-1}' if i else None,'indices':[0],'children':[f't{i+1}'] if i<6 else []} for i in range(7)]
    groups.append({'id':'other','label':'Second interest','parent_id':None,'indices':[0],'children':[]})
    async def generated(documents):return {'groups':groups,'memberships':[{'id':page.id,'anchor':'t6','topics':[{'id':'t6','score':.9,'basis':'cluster member'},{'id':'other','score':.87,'basis':'related content'}]}], 'mode':'local-semantic','headings':'generated-headings'}
    monkeypatch.setattr('app.services.graph_service.discover_topics',generated)
    async with database.async_session_maker() as db:
        graph=await build_knowledge_graph(db)
    assert graph['schema']=='connections-v1' and graph['cross_connections']==1
    resource=[node for node in graph['nodes'] if node['type']=='page']
    assert len(resource)==1 and resource[0]['depth']==8 and set(resource[0]['parent_ids'])=={'t6','other'}
    assert len([edge for edge in graph['edges'] if edge['target']==resource[0]['id']])==2


@pytest.mark.asyncio
async def test_free_generation_accepts_new_headings_and_reuses_content_cache(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings,'AI_PROVIDER','gemini');monkeypatch.setattr(settings,'GEMINI_API_KEY','test-fixture')
    prompts=[]
    class Provider:
        async def generate_response(self,prompt,**kwargs):
            prompts.append(prompt)
            return '{"1":[["Radio Astronomy","Pulsars"],["Signal Processing"]]}'
    async def provider():return Provider()
    monkeypatch.setattr('app.services.ai_provider.get_ai_provider',provider)
    documents=[discovery.content_document({'id':1,'title':'Listening to pulsars','description':'Radio astronomy and signal processing',
                'notes':'Unrelated shopping list','url_original':'https://private.test','topic':'Old folder'})]
    first=await infer_paths_impl(documents);second=await infer_paths_impl(documents)
    assert first==second=={1:[['Radio Astronomy','Pulsars'],['Signal Processing']]}
    assert len(prompts)==1
    assert 'shopping list' not in prompts[0] and 'private.test' not in prompts[0] and 'Old folder' not in prompts[0]


@pytest.mark.asyncio
async def test_provider_wrapped_heading_map_is_unwrapped_and_persisted(monkeypatch):
    class Provider:
        async def generate_response(self,*args,**kwargs):return '```json\n{"headings":{"radio research":["Science","Astronomy"]}}\n```'
    async def provider():return Provider()
    monkeypatch.setattr('app.services.ai_provider.get_ai_provider',provider)
    documents=[{'id':1,'title':'Pulsars','text':'Pulsars'}]
    result=await consolidate_impl({1:[['Radio Research','Pulsars']]},documents)
    assert result=={1:[['Science','Astronomy','Pulsars']]}
    assert discovery.CACHE_FILE.with_name('topic_heading_aliases.json').exists()


def test_generated_hierarchy_only_expands_when_there_is_enough_content():
    documents=[{'id':i,'title':'Resource '+str(i),'text':''} for i in range(25)]
    paths={i:[['Novel Subject','Subtopic A' if i<12 else 'Subtopic B','Tiny detail']] for i in range(25)}
    groups,memberships=discovery.build_generated_communities(paths,documents,[],[])
    assert {g['label'] for g in groups}=={'Novel Subject','Subtopic A','Subtopic B'}
    small_groups,_=discovery.build_generated_communities({i:paths[i] for i in range(5)},documents[:5],[],[])
    assert len(small_groups)==1
