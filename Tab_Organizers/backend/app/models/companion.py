import datetime
from sqlalchemy import String, Text, Float, Integer, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base

class CompanionNote(Base):
    __tablename__ = "companion_notes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    video_url: Mapped[str] = mapped_column(Text, nullable=False)
    timestamped_url: Mapped[str] = mapped_column(Text, nullable=False)
    video_title: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    timestamp_formatted: Mapped[str] = mapped_column(String(32), default="00:00")
    comment: Mapped[str] = mapped_column(Text, nullable=False)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
