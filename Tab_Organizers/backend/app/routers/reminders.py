import datetime
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, ConfigDict
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.reminder import Reminder
from app.models.page import Page

router = APIRouter(prefix="/api/reminders", tags=["reminders"])


class ReminderCreate(BaseModel):
    page_id: int
    note: Optional[str] = None
    remind_on_next_open: bool = True
    remind_at: Optional[datetime.datetime] = None


class SnoozeRequest(BaseModel):
    page_id: Optional[int] = None
    url: Optional[str] = None
    title: Optional[str] = None
    note: Optional[str] = None
    snooze_until: Optional[datetime.datetime] = None
    snooze_minutes: Optional[int] = None


class ReminderResponse(BaseModel):
    id: int
    page_id: int
    page_title: Optional[str] = None
    url: Optional[str] = None
    note: Optional[str] = None
    remind_on_next_open: bool
    remind_at: Optional[datetime.datetime] = None
    created_at: datetime.datetime
    fired_at: Optional[datetime.datetime] = None
    model_config = ConfigDict(from_attributes=True)



@router.post("", response_model=ReminderResponse, status_code=status.HTTP_201_CREATED)
async def create_reminder(payload: ReminderCreate, db: AsyncSession = Depends(get_db)):
    """Creates a reminder for a specific page."""
    # Verify page exists
    p_stmt = select(Page).where(Page.id == payload.page_id)
    p_res = await db.execute(p_stmt)
    page = p_res.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    reminder = Reminder(
        page_id=payload.page_id,
        note=payload.note,
        remind_on_next_open=payload.remind_on_next_open,
        remind_at=payload.remind_at
    )
    db.add(reminder)
    await db.commit()
    await db.refresh(reminder)

    return ReminderResponse(
        id=reminder.id,
        page_id=reminder.page_id,
        page_title=page.title,
        url=page.url_original,
        note=reminder.note,
        remind_on_next_open=reminder.remind_on_next_open,
        remind_at=reminder.remind_at,
        created_at=reminder.created_at,
        fired_at=reminder.fired_at
    )


@router.get("/pending", response_model=Dict[str, List[ReminderResponse]] if False else Any)
async def get_pending_reminders(db: AsyncSession = Depends(get_db)):
    """Returns unfired reminders that should alert the user."""
    now = datetime.datetime.now(datetime.timezone.utc)
    stmt = (
        select(Reminder, Page)
        .join(Page, Reminder.page_id == Page.id)
        .where(Reminder.fired_at.is_(None))
    )
    res = await db.execute(stmt)
    items = []
    for rem, page in res.all():
        # Check if due
        is_due = rem.remind_on_next_open or (rem.remind_at and rem.remind_at <= now)
        if is_due:
            items.append({
                "id": rem.id,
                "page_id": rem.page_id,
                "page_title": page.title,
                "url": page.url_original,
                "note": rem.note,
                "remind_on_next_open": rem.remind_on_next_open,
                "remind_at": rem.remind_at,
                "created_at": rem.created_at,
                "fired_at": rem.fired_at,
            })
    return {"reminders": items}


@router.put("/{reminder_id}/fire")
async def mark_reminder_fired(reminder_id: int, db: AsyncSession = Depends(get_db)):
    """Marks a reminder as fired/dismissed."""
    stmt = select(Reminder).where(Reminder.id == reminder_id)
    res = await db.execute(stmt)
    rem = res.scalar_one_or_none()
    if not rem:
        raise HTTPException(status_code=404, detail="Reminder not found")

    rem.fired_at = datetime.datetime.now(datetime.timezone.utc)
    await db.commit()
    return {"status": "fired", "id": reminder_id}


@router.post("/snooze", response_model=ReminderResponse, status_code=status.HTTP_201_CREATED)
async def snooze_tab(payload: SnoozeRequest, db: AsyncSession = Depends(get_db)):
    """
    Snoozes a tab / URL until a specified time or duration.
    Calculates target datetime, creates or finds the Page, and records the Reminder.
    """
    now = datetime.datetime.now(datetime.timezone.utc)

    # Compute target snooze time
    if payload.snooze_until:
        target_time = payload.snooze_until
    elif payload.snooze_minutes:
        target_time = now + datetime.timedelta(minutes=payload.snooze_minutes)
    else:
        # Default: snooze for 1 hour
        target_time = now + datetime.timedelta(hours=1)

    page = None
    if payload.page_id:
        p_stmt = select(Page).where(Page.id == payload.page_id)
        p_res = await db.execute(p_stmt)
        page = p_res.scalar_one_or_none()
        if not page:
            raise HTTPException(status_code=404, detail="Page not found")
    elif payload.url:
        from app.services.url_normalizer import normalize_url, extract_domain
        norm_url = normalize_url(payload.url)
        p_stmt = select(Page).where(Page.url_normalized == norm_url)
        p_res = await db.execute(p_stmt)
        page = p_res.scalar_one_or_none()
        if not page:
            domain = extract_domain(payload.url)
            page = Page(
                url_original=payload.url,
                url_normalized=norm_url,
                title=payload.title or domain,
                domain=domain,
                category="Snoozed"
            )
            db.add(page)
            await db.flush()
    else:
        raise HTTPException(status_code=400, detail="Either page_id or url is required to snooze a tab")

    reminder = Reminder(
        page_id=page.id,
        note=payload.note or f"Snoozed until {target_time.strftime('%Y-%m-%d %H:%M')}",
        remind_on_next_open=False,
        remind_at=target_time
    )
    db.add(reminder)
    await db.commit()
    await db.refresh(reminder)

    return ReminderResponse(
        id=reminder.id,
        page_id=reminder.page_id,
        page_title=page.title,
        url=page.url_original,
        note=reminder.note,
        remind_on_next_open=reminder.remind_on_next_open,
        remind_at=reminder.remind_at,
        created_at=reminder.created_at,
        fired_at=reminder.fired_at
    )

