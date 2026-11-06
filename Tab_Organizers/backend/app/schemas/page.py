from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, PositiveInt
from typing import Optional, Literal

class PageBase(BaseModel):
    url_original: str
    url_normalized: str
    title: Optional[str] = None
    description: Optional[str] = None
    favicon_url: Optional[str] = None
    og_image_url: Optional[str] = None
    og_image_data: Optional[str] = None
    og_image_mime: Optional[str] = None
    domain: Optional[str] = None
    category: Optional[str] = None
    topic: Optional[str] = None
    content_summary: Optional[str] = None
    tags: Optional[str] = None
    is_important: bool = False
    is_urgent: bool = False

class PageCreate(PageBase):
    full_text: Optional[str] = None

class PageUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    topic: Optional[str] = None
    content_summary: Optional[str] = None
    tags: Optional[str] = None
    is_important: Optional[bool] = None
    is_urgent: Optional[bool] = None
    last_seen_open_at: Optional[datetime] = None

class PageResponse(PageBase):
    id: int
    display_topic: Optional[str] = None
    subject_topics: list[str] = Field(default_factory=list)
    note_count: int = 0
    completed_at: Optional[datetime] = None
    completion_kind: Literal['watched', 'read'] = 'read'
    created_at: datetime
    updated_at: datetime
    last_seen_open_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class CompletionUpdate(BaseModel):
    completed: bool


class BulkCompletionUpdate(CompletionUpdate):
    page_ids: list[PositiveInt] = Field(min_length=1, max_length=1000)


class BulkSaveRequest(BaseModel):
    tabs: list[PageCreate]


class BulkSaveResponse(BaseModel):
    saved_pages: list[dict] = []
    total_submitted: int
    new_saved_count: int
    updated_count: int
    message: str
