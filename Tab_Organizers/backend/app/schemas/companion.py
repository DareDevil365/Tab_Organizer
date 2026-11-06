from pydantic import BaseModel, ConfigDict, field_validator
import datetime
from typing import Optional

class CompanionNoteCreate(BaseModel):
    created_at: Optional[datetime.datetime] = None
    id: str
    video_url: str
    timestamped_url: str
    video_title: str
    timestamp_seconds: float = 0.0
    timestamp_formatted: str = "00:00"
    comment: str
    thumbnail_url: Optional[str] = None
    attachments: Optional[str] = None
    page_id: Optional[int] = None

class CompanionNoteResponse(BaseModel):
    page_note_count: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)

    id: str
    video_url: str
    timestamped_url: str
    video_title: str
    timestamp_seconds: float
    timestamp_formatted: str
    comment: str
    thumbnail_url: Optional[str] = None
    attachments: Optional[str] = None
    page_id: Optional[int] = None
    created_at: datetime.datetime

    @field_validator('created_at')
    @classmethod
    def utc_timestamp(cls,value):
        return value.replace(tzinfo=datetime.timezone.utc) if value.tzinfo is None else value
