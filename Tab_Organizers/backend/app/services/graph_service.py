from typing import Any
from sqlalchemy import select
from app.models.page import Page
from app.services.topic_discovery import content_document, discover_topics


async def cached_topic_metadata(pages):
    # Loading or removing a card must never rebuild the entire semantic graph.
    # Per-document keys keep unchanged headings usable after other pages are
    # deleted, while withholding stale headings for edited/reused page IDs.
    if not pages:
        return {}
    from app.services.topic_discovery import cached_discovery, document_key
    discovery = await cached_discovery()
    if not discovery:
        return {}
    keys = discovery.get('document_keys', {})
    metadata = topic_metadata(discovery)
    return {page.id: metadata[page.id] for page in pages
            if page.id in metadata and keys.get(str(page.id)) == document_key(content_document(page))}


async def discovered_library(db):
    pages=(await db.execute(select(Page).order_by(Page.id))).scalars().all()
    discovery=await discover_topics([content_document(page) for page in pages])
    return pages,discovery


def topic_metadata(discovery):
    groups={group['id']:group for group in discovery['groups']}
    result={}
    for membership in discovery['memberships']:
        labels=[]
        for connection in membership['topics']:
            group=groups.get(connection['id'])
            trail=[]
            while group:
                trail.insert(0,group['label']);group=groups.get(group['parent_id'])
            for label in trail:
                if label not in labels: labels.append(label)
        result[membership['id']]={'display_topic':groups[membership['anchor']]['label'],'subject_topics':labels}
    return result


async def build_knowledge_graph(db, limit: int | None=None) -> dict[str,Any]:
    """One resource node, multiple content-derived topic edges; anchor only for layout."""
    pages,discovery=await discovered_library(db)
    total=len(pages)
    shown=pages if limit is None else sorted(pages,key=lambda page:page.id,reverse=True)[:limit]
    shown_ids={page.id for page in shown}
    groups={group['id']:group for group in discovery['groups']}
    memberships=[item for item in discovery['memberships'] if item['id'] in shown_ids]
    needed=set()
    counts={}
    for item in memberships:
        connected=set()
        for link in item['topics']:
            group=groups.get(link['id'])
            while group:
                needed.add(group['id']);connected.add(group['id']);group=groups.get(group['parent_id'])
        for id in connected: counts[id]=counts.get(id,0)+1
    nodes=[];edges=[]
    if shown: nodes.append({'id':'knowledge_root','label':'Your Knowledge','type':'category','parent_id':None,'parent_ids':[],'depth':0})
    def depth(id):
        level=1
        while groups[id]['parent_id']:
            level+=1;id=groups[id]['parent_id']
        return level
    for group in discovery['groups']:
        if group['id'] not in needed: continue
        parent=group['parent_id'] or 'knowledge_root'
        nodes.append({'id':group['id'],'label':group['label'],'type':'topic','parent_id':parent,'parent_ids':[parent],
                      'depth':depth(group['id']),'resource_count':counts[group['id']], 'description':f"{counts[group['id']]} resources grouped by their content"})
        edges.append({'source':parent,'target':group['id'],'type':'contains_subject'})
    by_page={page.id:page for page in shown}
    for membership in memberships:
        page=by_page[membership['id']]
        id=f'page_{page.id}'
        nodes.append({'id':id,'label':content_document(page)['title'],'type':'page','page_id':page.id,
                      'url':page.url_original,'description':page.description or '',
                      'parent_id':membership['anchor'],'parent_ids':[link['id'] for link in membership['topics']],
                      'depth':depth(membership['anchor'])+1})
        for connection in membership['topics']:
            edges.append({'source':connection['id'],'target':id,
                          'type':'contains_resource' if connection['id']==membership['anchor'] else 'related_topic',
                          'score':connection['score'],'basis':connection['basis']})
    return {'schema':'connections-v1','nodes':nodes,'edges':edges,'total_nodes':len(nodes),'total_edges':len(edges),
            'resource_count':len(shown),'total_resources':total,'is_truncated':len(shown)<total,
            'discovery_mode':discovery['mode'],'heading_mode':discovery['headings'],
            'cross_connections':sum(edge['type']=='related_topic' for edge in edges),'split_at':discovery.get('split_at',18)}
