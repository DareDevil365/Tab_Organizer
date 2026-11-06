from pydantic import BaseModel, ConfigDict
from typing import Optional, List
import datetime

class TabItem(BaseModel):
    url: str
    title: Optional[str] = None
    favicon_url: Optional[str] = None
    domain: Optional[str] = None
    og_image_url: Optional[str] = None
    description: Optional[str] = None

class TabGroupBase(BaseModel):
    name: str
    color: str = "blue"
    chrome_group_id: Optional[int] = None
    saved_html_export_path: Optional[str] = None

class TabGroupCreate(TabGroupBase):
    tabs: List[TabItem] = []

class TabGroupUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    tabs: Optional[List[TabItem]] = None
    saved_html_export_path: Optional[str] = None

class TabGroupResponse(TabGroupBase):
    id: int
    tab_count: int = 0
    tabs: List[TabItem] = []
    created_at: Optional[datetime.datetime] = None
    updated_at: Optional[datetime.datetime] = None

    model_config = ConfigDict(from_attributes=True)
