"""Recover generic YouTube headings via the fixed public oEmbed endpoint."""
import asyncio
import re
from urllib.parse import urlparse, parse_qs
import httpx
from sqlalchemy import select, update
from app.models.page import Page


def generic_title(title, url=''):
    text=(title or '').strip().casefold()
    host=(urlparse(url).hostname or '').removeprefix('www.')
    return not text or text in {'youtube','youtube - youtube','untitled','untitled video','saved page',host,'www.'+host} or text.startswith(('http://','https://'))


def youtube_video_id(url):
    parsed=urlparse(url)
    if parsed.scheme not in ('https','http'): return None
    host=(parsed.hostname or '').lower()
    if host=='youtu.be': candidate=parsed.path.strip('/').split('/')[0]
    elif host in ('youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'):
        candidate=parse_qs(parsed.query).get('v',[''])[0] if parsed.path=='/watch' else parsed.path.split('/')[2] if parsed.path.startswith(('/shorts/','embed/','/embed/','/live/')) and len(parsed.path.split('/'))>2 else ''
    else: return None
    return candidate if re.fullmatch(r'[\w-]{11}',candidate) else None


async def resolve_video_title(url, title):
    if not generic_title(title,url): return title
    id=youtube_video_id(url)
    if not id: return title
    try:
        async with httpx.AsyncClient(timeout=8,follow_redirects=False) as client:
            response=await client.get('https://www.youtube.com/oembed',params={'url':f'https://www.youtube.com/watch?v={id}','format':'json'})
            response.raise_for_status()
            actual=response.json().get('title')
            if isinstance(actual,str) and 1<len(actual)<1000 and not generic_title(actual,url): return actual.strip()
    except (httpx.HTTPError,ValueError,TypeError): pass
    return title


async def repair_generic_video_titles(db):
    pages=(await db.execute(select(Page))).scalars().all()
    candidates=[page for page in pages if generic_title(page.title,page.url_original) and youtube_video_id(page.url_original)]
    gate=asyncio.Semaphore(3)
    async def recover(page):
        async with gate: return page,await resolve_video_title(page.url_original,page.title)
    count=0
    for page,title in await asyncio.gather(*(recover(page) for page in candidates)):
        if title and title!=page.title:
            # A title edited during the request takes precedence over this repair.
            result=await db.execute(update(Page).where(Page.id==page.id,Page.title==page.title).values(title=title).execution_options(synchronize_session=False))
            count+=result.rowcount
    await db.commit()
    return count
