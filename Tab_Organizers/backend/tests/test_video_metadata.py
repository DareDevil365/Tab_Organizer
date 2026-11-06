import pytest
from app.services.video_metadata import generic_title,youtube_video_id,resolve_video_title,repair_generic_video_titles
from app.services import video_metadata
from app.models.page import Page
from app import database


def test_generic_titles_and_exact_youtube_host_allowlist():
    assert generic_title('YouTube','https://www.youtube.com/watch?v=PrFq5szYIWQk')
    assert not generic_title('Approaching Artificial Intelligence','https://youtube.com')
    assert youtube_video_id('https://www.youtube.com/watch?v=PrFq5zYIWQk')=='PrFq5zYIWQk'
    assert youtube_video_id('https://youtube.com.evil.test/watch?v=PrFq5zYIWQk') is None
    assert youtube_video_id('file:///youtube.com/watch?v=PrFq5zYIWQk') is None


@pytest.mark.asyncio
async def test_oembed_recovery_uses_fixed_endpoint_and_never_replaces_good_title(monkeypatch):
    calls=[]
    class Response:
        def raise_for_status(self):pass
        def json(self):return {'title':'Approaching Artificial Intelligence'}
    class Client:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def get(self,url,params):calls.append((url,params));return Response()
    monkeypatch.setattr(video_metadata.httpx,'AsyncClient',Client)
    url='https://www.youtube.com/watch?v=PrFq5zYIWQk'
    assert await resolve_video_title(url,'YouTube')=='Approaching Artificial Intelligence'
    assert calls[0][0]=='https://www.youtube.com/oembed'
    assert await resolve_video_title(url,'My custom lecture title')=='My custom lecture title'
    assert len(calls)==1


@pytest.mark.asyncio
async def test_repair_preserves_notes_and_all_non_title_metadata(monkeypatch):
    async def resolve(url,title):return 'Recovered lecture' if generic_title(title,url) else title
    monkeypatch.setattr(video_metadata,'resolve_video_title',resolve)
    async with database.async_session_maker() as db:
        page=Page(url_original='https://youtube.com/watch?v=PrFq5zYIWQk',url_normalized='https://youtube.com/watch?v=PrFq5zYIWQk',title='YouTube',topic='My chosen topic',is_important=True)
        db.add(page);await db.commit()
        assert await repair_generic_video_titles(db)==1
        await db.refresh(page)
        assert page.title=='Recovered lecture' and page.topic=='My chosen topic' and page.is_important
