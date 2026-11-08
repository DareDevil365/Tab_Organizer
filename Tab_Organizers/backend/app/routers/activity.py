import datetime
from collections import defaultdict
from typing import List, Optional, Annotated
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.database import get_db
from app.models.activity import ActivityLog
from app.models.page import Page
from app.schemas.activity import (
    ActivityBatchCreate,
    ActivityClassifyRequest,
    ActivitySummary,
    DomainUsage,
    TopicUsage,
    DailyTrend
)
from app.services.url_normalizer import normalize_url
from app.services.completion import completion_kind
from app.services.activity_subjects import remember_activity_content, activity_topic_map, classify_activity_subjects

router = APIRouter(prefix="/api/activity", tags=["activity"])


@router.post('/classify')
async def classify_browsing(payload: ActivityClassifyRequest, db: AsyncSession = Depends(get_db)):
    return await classify_activity_subjects(db, payload.limit)


@router.get('/completions')
async def completion_summary(days: int = Query(default=7, ge=1, le=90), db: AsyncSession = Depends(get_db)):
    now = datetime.datetime.now(datetime.timezone.utc)
    start = now - datetime.timedelta(days=days)
    pages = (await db.execute(select(Page).where(Page.completed_at >= start, Page.completed_at <= now).order_by(Page.completed_at.desc()))).scalars().all()
    watched = sum(completion_kind(page) == 'watched' for page in pages)
    total_saved = (await db.execute(select(func.count(Page.id)))).scalar_one()
    total_completed = (await db.execute(select(func.count(Page.id)).where(Page.completed_at.is_not(None)))).scalar_one()
    return {
        'period_days': days, 'completed': len(pages), 'watched': watched, 'read': len(pages) - watched,
        'total_saved': total_saved, 'total_completed': total_completed, 'unseen': total_saved - total_completed,
        'recent': [{'id': page.id, 'title': page.title or 'Saved resource', 'kind': completion_kind(page),
                    'completed_at': page.completed_at.replace(tzinfo=datetime.timezone.utc).isoformat()} for page in pages[:50]],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def record_activities(payload: ActivityBatchCreate, db: AsyncSession = Depends(get_db)):
    """Logs a batch of tab activity/time tracking intervals."""
    if not payload.activities:
        return {"recorded": 0}

    # Gather normalized URLs to associate with Page IDs
    norm_urls = [normalize_url(a.url) for a in payload.activities if a.url]
    page_map = {}
    if norm_urls:
        stmt = select(Page.id, Page.url_normalized, Page.topic).where(Page.url_normalized.in_(norm_urls))
        res = await db.execute(stmt)
        for pid, pnorm, ptopic in res.all():
            page_map[pnorm] = (pid, ptopic)

    # A network response can be lost after commit. Retrying the durable worker
    # queue must not count that exact same interval a second time.
    def utc_naive(value):
        return value.replace(tzinfo=None) if value.tzinfo is None else value.astimezone(datetime.timezone.utc).replace(tzinfo=None)

    starts = [utc_naive(item.started_at) for item in payload.activities]
    existing = (await db.execute(select(ActivityLog).where(
        ActivityLog.started_at >= min(starts), ActivityLog.started_at <= max(starts),
    ))).scalars().all()
    seen = {(item.url, utc_naive(item.started_at), utc_naive(item.ended_at), item.duration_seconds) for item in existing}
    records = []
    await remember_activity_content(db, payload.activities)
    for item in payload.activities:
        start, end = utc_naive(item.started_at), utc_naive(item.ended_at)
        key = (item.url, start, end, item.duration_seconds)
        if item.duration_seconds <= 0 or end <= start or key in seen:
            continue
        seen.add(key)

        norm = normalize_url(item.url)
        page_info = page_map.get(norm)
        page_id = page_info[0] if page_info else None
        topic = item.topic or (page_info[1] if page_info else None) or "other"

        records.append(
            ActivityLog(
                page_id=page_id,
                url=item.url,
                domain=item.domain or "unknown",
                topic=topic,
                started_at=start,
                ended_at=end,
                duration_seconds=item.duration_seconds,
            )
        )

    db.add_all(records)
    await db.commit()
    return {"recorded": len(records), "classification_pending": any((row.topic or 'other').casefold() == 'other' for row in records)}


def summarize_activity(logs, days: int, now: datetime.datetime, utc_offset_minutes: int = 0, topics=None) -> ActivitySummary:
    """Clip rolling-window intervals and split time across the browser's local dates.

    Offset uses ISO convention: +330 means UTC+05:30 (the browser sends
    -new Date().getTimezoneOffset()). Legacy naive timestamps are treated as UTC.
    """
    utc = datetime.timezone.utc
    now = now.replace(tzinfo=utc) if now.tzinfo is None else now.astimezone(utc)
    cutoff = now - datetime.timedelta(days=days)
    zone = datetime.timezone(datetime.timedelta(minutes=utc_offset_minutes))
    domain_totals, topic_totals, daily_totals = defaultdict(int), defaultdict(int), defaultdict(int)
    website_topics = defaultdict(lambda: defaultdict(int))
    total_seconds = 0
    for log in logs:
        start = log.started_at.replace(tzinfo=utc) if log.started_at.tzinfo is None else log.started_at.astimezone(utc)
        end = log.ended_at.replace(tzinfo=utc) if log.ended_at.tzinfo is None else log.ended_at.astimezone(utc)
        span = (end - start).total_seconds()
        left, right = max(start, cutoff), min(end, now)
        if span <= 0 or right <= left or log.duration_seconds <= 0:
            continue
        recorded = min(log.duration_seconds, span)
        seconds = round(recorded * (right - left).total_seconds() / span)
        if seconds <= 0:
            continue
        try:
            domain = urlparse(log.url).hostname or log.domain or 'unknown'
        except ValueError:
            domain = log.domain or 'unknown'
        domain = domain.lower().removeprefix('www.')
        topic = (topics or {}).get(normalize_url(log.url)) or log.topic or 'other'
        domain_totals[domain] += seconds
        topic_totals[topic] += seconds
        website_topics[domain][topic] += seconds
        total_seconds += seconds
        # Allocate integer seconds cumulatively so daily bars sum to the total.
        cursor, allocated = left, 0
        while cursor < right:
            local = cursor.astimezone(zone)
            midnight = datetime.datetime.combine(local.date() + datetime.timedelta(days=1), datetime.time(), tzinfo=zone).astimezone(utc)
            segment_end = min(midnight, right)
            cumulative = round(seconds * (segment_end - left).total_seconds() / (right - left).total_seconds())
            daily_totals[local.date().isoformat()] += cumulative - allocated
            allocated = cumulative
            cursor = segment_end
    sorted_domains = sorted(domain_totals.items(), key=lambda item: item[1], reverse=True)
    sorted_topics = sorted(topic_totals.items(), key=lambda item: item[1], reverse=True)
    domain_breakdown = [DomainUsage(domain=domain, duration_seconds=seconds,
        percentage=round(seconds / total_seconds * 100, 1) if total_seconds else 0,
        topic=max(website_topics[domain], key=website_topics[domain].get)) for domain, seconds in sorted_domains]
    # Headings follow actual recent time, not a fixed saved-page taxonomy.
    # Keep smaller interests expandable without losing any recorded seconds.
    ranked_known = [(topic, seconds) for topic, seconds in sorted_topics if topic.casefold() != 'other']
    minimum = max(30, total_seconds * .005)
    visible_known = {topic for index, (topic, seconds) in enumerate(ranked_known) if index < 3 or (index < 8 and seconds >= minimum)}
    visible_topics = [(topic, seconds) for topic, seconds in sorted_topics if topic in visible_known or topic.casefold() == 'other']
    topic_breakdown = [TopicUsage(topic=topic, duration_seconds=seconds,
        percentage=round(seconds / total_seconds * 100, 1) if total_seconds else 0) for topic, seconds in visible_topics]
    remaining = sum(seconds for topic, seconds in sorted_topics if topic not in visible_known and topic.casefold() != 'other')
    if remaining:
        topic_breakdown.append(TopicUsage(topic='Other subjects', duration_seconds=remaining,
            percentage=round(remaining / total_seconds * 100, 1)))
    first, last = cutoff.astimezone(zone).date(), now.astimezone(zone).date()
    trends = []
    while first <= last:
        key = first.isoformat()
        trends.append(DailyTrend(date=key, duration_seconds=daily_totals.get(key, 0)))
        first += datetime.timedelta(days=1)
    return ActivitySummary(total_seconds=total_seconds, daily_average_seconds=total_seconds // max(1, days),
        top_domain=sorted_domains[0][0] if sorted_domains else None,
        top_topic=sorted_topics[0][0] if sorted_topics else None,
        domain_breakdown=domain_breakdown, topic_breakdown=topic_breakdown, trends=trends)


@router.get("/summary", response_model=ActivitySummary)
async def get_activity_summary(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    utc_offset_minutes: Annotated[int, Query(ge=-840, le=840)] = 0,
):
    """Active browsing totals for a rolling period, with browser-local daily bars."""
    now = datetime.datetime.now(datetime.timezone.utc)
    cutoff = now - datetime.timedelta(days=days)
    stmt = select(ActivityLog).where(ActivityLog.ended_at > cutoff, ActivityLog.started_at < now)
    logs = (await db.execute(stmt)).scalars().all()
    topics = await activity_topic_map(db, {log.url for log in logs})
    return summarize_activity(logs, days, now, utc_offset_minutes, topics)


@router.get("/by-domain", response_model=List[DomainUsage])
async def get_activity_by_domain(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db)
):
    """Returns top domain usage statistics."""
    summary = await get_activity_summary(days=days, db=db)
    return summary.domain_breakdown


@router.get("/by-topic", response_model=List[TopicUsage])
async def get_activity_by_topic(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db)
):
    """Returns topic breakdown statistics."""
    summary = await get_activity_summary(days=days, db=db)
    return summary.topic_breakdown


@router.get("/trends", response_model=List[DailyTrend])
async def get_activity_trends(
    days: int = Query(default=14, ge=1, le=90),
    db: AsyncSession = Depends(get_db)
):
    """Returns daily time tracking trend line data."""
    summary = await get_activity_summary(days=days, db=db)
    return summary.trends


@router.get("/digest")
async def get_weekly_digest(db: AsyncSession = Depends(get_db)):
    """
    Returns a formatted weekly digest summarizing screen time, top domains, and topics
    (e.g., 'You spent 6h on YouTube this week, mostly video editing').
    """
    summary = await get_activity_summary(days=7, db=db)
    total_hours = round(summary.total_seconds / 3600, 1)
    total_mins = summary.total_seconds // 60

    top_d = summary.top_domain or "No domain recorded"
    top_t = summary.top_topic or "general"

    if summary.total_seconds == 0:
        headline = "No browsing activity recorded this week."
    else:
        hours_part = f"{summary.total_seconds // 3600}h " if summary.total_seconds >= 3600 else ""
        mins_part = f"{(summary.total_seconds % 3600) // 60}m"
        time_str = f"{hours_part}{mins_part}".strip()
        headline = f"You spent {time_str} browsing this week, mostly on {top_d} focusing on '{top_t}'."

    return {
        "period_days": 7,
        "total_seconds": summary.total_seconds,
        "total_hours": total_hours,
        "total_minutes": total_mins,
        "top_domain": summary.top_domain,
        "top_topic": summary.top_topic,
        "headline": headline,
        "domain_breakdown": summary.domain_breakdown[:5],
        "topic_breakdown": summary.topic_breakdown[:5],
    }

