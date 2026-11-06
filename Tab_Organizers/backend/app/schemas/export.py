from typing import List, Optional
from pydantic import BaseModel, Field


class ExportTabItem(BaseModel):
    url_original: str
    url_normalized: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    favicon_url: Optional[str] = None
    og_image_url: Optional[str] = None
    og_image_data: Optional[str] = None  # Base64 data URI
    domain: Optional[str] = None
    category: Optional[str] = None
    topic: Optional[str] = None
    group_name: Optional[str] = None
    group_color: Optional[str] = None


class ExportRequest(BaseModel):
    title: Optional[str] = Field(default="Saved Tab Collection", description="Custom collection title")
    tabs: List[ExportTabItem] = Field(..., description="List of tabs to export and persist")
    save_to_library: bool = Field(default=False, description="Whether to also persist tabs to the main library pages database")


class ExportResponse(BaseModel):
    html_content: str
    item_count: int
    title: str
