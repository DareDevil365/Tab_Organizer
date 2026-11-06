import datetime
from sqlalchemy import Integer, String, Text, ForeignKey, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

class TabGroup(Base):
    __tablename__ = "tab_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chrome_group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    color: Mapped[str] = mapped_column(String(50), nullable=False, default="blue")
    tab_count: Mapped[int] = mapped_column(Integer, default=0)
    tabs_data: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON-encoded array of tab objects
    saved_html_export_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class PageGroupLink(Base):
    __tablename__ = "page_group_links"

    page_id: Mapped[int] = mapped_column(Integer, ForeignKey("pages.id"), primary_key=True)
    group_id: Mapped[int] = mapped_column(Integer, ForeignKey("tab_groups.id"), primary_key=True)
