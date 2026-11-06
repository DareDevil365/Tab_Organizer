import datetime
from typing import List, Optional
from pydantic import BaseModel, ConfigDict


class ActivityItem(BaseModel):
    url: str
    domain: str
    topic: Optional[str] = None
    started_at: datetime.datetime
    ended_at: datetime.datetime
    duration_seconds: int


class ActivityBatchCreate(BaseModel):
    activities: List[ActivityItem]


class ActivityResponse(ActivityItem):
    id: int
    page_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


class DomainUsage(BaseModel):
    domain: str
    duration_seconds: int
    percentage: float


class TopicUsage(BaseModel):
    topic: str
    duration_seconds: int
    percentage: float


class DailyTrend(BaseModel):
    date: str
    duration_seconds: int


class ActivitySummary(BaseModel):
    total_seconds: int
    daily_average_seconds: int
    top_domain: Optional[str] = None
    top_topic: Optional[str] = None
    domain_breakdown: List[DomainUsage]
    topic_breakdown: List[TopicUsage]
    trends: List[DailyTrend]
