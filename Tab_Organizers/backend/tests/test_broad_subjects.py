import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from app import database
from app.models.page import Page
from app.services.content_subjects import subject_path, library_subjects


@pytest.mark.parametrize('title,heading',[
 ('A new movie trailer','Movies & TV'),('How to play flute | lesson 2','Music & Audio'),
 ('Cooking a simple recipe','Cooking'),('News from around the world','News & Current Affairs'),
 ('I built a wireless GPU for AI agents','Hardware & Computing'),('After Effects tricks','Video Editing'),
 ('What motion designers need to know','Motion Design'),('Social media for creators','Social Media'),
 ('Open source tools worth keeping','Open Source'),('CAD modeling in Fusion 360','CAD & 3D Design')])
def test_content_beyond_the_old_four_headings_overrides_stale_metadata(title,heading):
    page={'title':title,'topic':'Programming','domain':'youtube.com'}
    assert subject_path(page)[-1]==heading
    assert heading in library_subjects(page)
    assert not any('.com' in subject for subject in library_subjects(page))


def test_explicit_mixed_subjects_are_filterable_without_multiple_graph_parents():
    page={'title':'Wireless GPU for AI agents'}
    assert {'Hardware & Computing','AI & Machine Learning'}.issubset(library_subjects(page))
    assert subject_path(page)==('Technology','Hardware & Computing')
    assert {'Hobbies','Music & Audio'}.issubset(library_subjects({'title':'Flute lesson'}))
    assert {'Entertainment','Movies & TV'}.issubset(library_subjects({'title':'Movie trailer'}))
    assert library_subjects({'title':'A useful reference','topic':'My new research interest'})==[]


@pytest.mark.asyncio
async def test_api_projects_fresh_headings_without_rewriting_saved_user_topics():
    async with database.async_session_maker() as db:
        db.add(Page(url_original='https://example.test/reference',url_normalized='https://example.test/reference',title='Motion designers in After Effects',topic='Programming'))
        await db.commit()
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        page=(await client.get('/api/pages')).json()[0]
        assert 'motion' in page['display_topic'].lower() or 'design' in page['display_topic'].lower()
        assert page['display_topic'] in page['subject_topics']
        assert page['topic']=='Programming'
