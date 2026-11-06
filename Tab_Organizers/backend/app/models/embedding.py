import datetime
from sqlalchemy import Integer, String, ForeignKey, LargeBinary, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class PageEmbedding(Base):
    __tablename__ = "embeddings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    page_id: Mapped[int] = mapped_column(Integer, ForeignKey("pages.id"), unique=True, nullable=False)
    vector: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), default="all-MiniLM-L6-v2")
    created_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
