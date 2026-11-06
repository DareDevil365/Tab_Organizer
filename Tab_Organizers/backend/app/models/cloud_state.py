import datetime
from sqlalchemy import String, Text, LargeBinary, DateTime, Integer
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class AppDocument(Base):
    __tablename__ = 'app_documents'
    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    payload: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EmbeddingCache(Base):
    __tablename__ = 'embedding_cache'
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    vector: Mapped[bytes] = mapped_column(LargeBinary)
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), index=True)


class EmbeddingBudget(Base):
    __tablename__ = 'embedding_budgets'
    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    used_bytes: Mapped[int] = mapped_column(Integer, default=0)
