import datetime
from collections import defaultdict
from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.database import get_db
from app.models.activity import ActivityLog
from app.models.page import Page
from app.schemas.activity import (
    ActivityBatchCreate,
    ActivitySummary,
    DomainUsage,
    TopicUsage,
    DailyTrend
)
from app.services.url_normalizer import normalize_url

router = APIRouter(prefix="/api/activity", tags=["activity"])


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

    records = []
    for item in payload.activities:
        if item.duration_seconds <= 0:
            continue

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
                started_at=item.started_at,
                ended_at=item.ended_at,
                duration_seconds=item.duration_seconds,
            )
        )

    db.add_all(records)
    await db.commit()
    return {"recorded": len(records)}


@router.get("/summary", response_model=ActivitySummary)
async def get_activity_summary(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db)
):
    """Computes time tracking analytics across domains, topics, and daily trends."""
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)

    stmt = select(ActivityLog).where(ActivityLog.started_at >= cutoff)
    res = await db.execute(stmt)
    logs = res.scalars().all()

    total_seconds = sum(l.duration_seconds for l in logs)
    daily_avg = total_seconds // max(1, days)

    # Domain aggregations
    domain_totals = defaultdict(int)
    topic_totals = defaultdict(int)
    daily_totals = defaultdict(int)

    for l in logs:
        domain_totals[l.domain] += l.duration_seconds
        topic_totals[l.topic or "other"] += l.duration_seconds
        # Date key YYYY-MM-DD
        date_str = l.started_at.strftime("%Y-%m-%d")
        daily_totals[date_str] += l.duration_seconds

    # Sort domains
    sorted_domains = sorted(domain_totals.items(), key=lambda x: x[1], reverse=True)
    domain_breakdown = [
        DomainUsage(
            domain=d,
            duration_seconds=sec,
            percentage=round((sec / total_seconds * 100) if total_seconds > 0 else 0.0, 1)
        )
        for d, sec in sorted_domains[:10]
    ]

    # Sort topics
    sorted_topics = sorted(topic_totals.items(), key=lambda x: x[1], reverse=True)
    topic_breakdown = [
        TopicUsage(
            topic=t,
            duration_seconds=sec,
            percentage=round((sec / total_seconds * 100) if total_seconds > 0 else 0.0, 1)
        )
        for t, sec in sorted_topics[:10]
    ]

    # Fill daily trends for last N days
    trends = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for i in range(days - 1, -1, -1):
        day_date = (now - datetime.timedelta(days=i)).strftime("%Y-%m-%d")
        trends.append(
            DailyTrend(
                date=day_date,
                duration_seconds=daily_totals.get(day_date, 0)
            )
        )

    top_domain = sorted_domains[0][0] if sorted_domains else None
    top_topic = sorted_topics[0][0] if sorted_topics else None

    return ActivitySummary(
        total_seconds=total_seconds,
        daily_average_seconds=daily_avg,
        top_domain=top_domain,
        top_topic=top_topic,
        domain_breakdown=domain_breakdown,
        topic_breakdown=topic_breakdown,
        trends=trends,
    )


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

