import asyncio
import json
import time
from pathlib import Path
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, field_validator
from fastapi import APIRouter, HTTPException
from app.services.state_store import read_json, write_json, mutate_json

router = APIRouter(prefix="/api/windows", tags=["windows"])

DATA_DIR = Path("./data")
CLOSED_WINDOWS_FILE = DATA_DIR / "closed_windows.json"
BROWSER_SESSIONS_FILE = DATA_DIR / "browser_sessions.json"

MAX_SAVED_BROWSER_SESSIONS = 2  # Strictly cache the last 2 browser sessions
MAX_CLOSED_WINDOWS = 30         # Keep up to 30 closed windows in history
MAX_CACHE_AGE_SEC = 300         # 5-minute threshold for accidental quick recovery banner

# Async locks to prevent concurrent file corruption under rapid window-close events
_closed_windows_lock = asyncio.Lock()
_browser_sessions_lock = asyncio.Lock()


class TabItem(BaseModel):
    title: str
    url: str
    favIconUrl: Optional[str] = None
    groupId: Optional[int] = None
    groupTitle: Optional[str] = None
    groupColor: Optional[str] = None


class GroupItem(BaseModel):
    id: int
    title: Optional[str] = None
    color: Optional[str] = None


class ClosedWindowCreate(BaseModel):
    session_id: str
    closed_at: float  # ms timestamp
    tab_count: int
    title_preview: str
    tabs: List[TabItem]
    groups: Optional[List[GroupItem]] = []

    @field_validator("closed_at", mode="before")
    @classmethod
    def normalize_closed_at(cls, v: float) -> float:
        """Sanity check: if closed_at looks like seconds (< 1e12), convert to ms."""
        if v < 1e12:
            return v * 1000
        return v


class BrowserWindowItem(BaseModel):
    window_index: int
    tabs: List[TabItem]
    groups: Optional[List[GroupItem]] = []


class BrowserSessionCreate(BaseModel):
    session_id: str
    closed_at: float  # ms timestamp
    window_count: int
    total_tab_count: int
    title_preview: str
    windows: List[BrowserWindowItem]

    @field_validator("closed_at", mode="before")
    @classmethod
    def normalize_closed_at(cls, v: float) -> float:
        """Sanity check: if closed_at looks like seconds (< 1e12), convert to ms."""
        if v < 1e12:
            return v * 1000
        return v


# ---------------------------------------------------------------------------
# Async file helpers
# ---------------------------------------------------------------------------

def _read_json_file(path: Path) -> List[Dict[str, Any]]:
    return read_json(path,[])


def _write_json_file(path: Path, data: List[Dict[str, Any]], limit: int) -> None:
    write_json(path,data[:limit])


async def _mutate_sessions(path, limit, lock, transform):
    async with lock:
        return await asyncio.to_thread(mutate_json,path,[],lambda rows:transform(rows)[:limit])


async def _load_sessions() -> List[Dict[str, Any]]:
    return await asyncio.to_thread(_read_json_file, CLOSED_WINDOWS_FILE)


async def _save_sessions(sessions: List[Dict[str, Any]]) -> None:
    async with _closed_windows_lock:
        await asyncio.to_thread(_write_json_file, CLOSED_WINDOWS_FILE, sessions, MAX_CLOSED_WINDOWS)


async def _load_browser_sessions() -> List[Dict[str, Any]]:
    return await asyncio.to_thread(_read_json_file, BROWSER_SESSIONS_FILE)


async def _save_browser_sessions(sessions: List[Dict[str, Any]]) -> None:
    async with _browser_sessions_lock:
        await asyncio.to_thread(
            _write_json_file, BROWSER_SESSIONS_FILE, sessions, MAX_SAVED_BROWSER_SESSIONS
        )


# ==========================================
# 1. Closed Windows Recovery
# ==========================================

@router.get("/closed")
async def get_recently_closed_windows(limit: int = 30, recent_only: bool = True):
    """Returns recently closed single window sessions, enriched with age metadata.
    Does not delete older sessions from disk so history remains intact."""
    sessions = await _load_sessions()
    now_ms = time.time() * 1000

    enriched = []
    for s in sessions:
        closed_at = s.get("closed_at", now_ms)
        elapsed_sec = max(0, int((now_ms - closed_at) / 1000))
        is_recent = elapsed_sec <= MAX_CACHE_AGE_SEC

        if not recent_only or is_recent:
            ago_text = f"{elapsed_sec}s ago" if elapsed_sec < 60 else f"{elapsed_sec // 60}m ago" if elapsed_sec < 3600 else f"{elapsed_sec // 3600}h ago"

            enriched.append({
                **s,
                "elapsed_seconds": elapsed_sec,
                "closed_ago": ago_text,
                "is_recent_5m": is_recent,
                "expires_in_sec": max(0, MAX_CACHE_AGE_SEC - elapsed_sec) if is_recent else 0,
            })

    enriched.sort(key=lambda x: x.get("closed_at", 0), reverse=True)
    return {"sessions": enriched[:limit], "count": len(enriched)}


@router.post("/closed")
async def save_closed_window(payload: ClosedWindowCreate):
    """Saves a closed single-window snapshot."""
    recorded=False
    def add(rows):
        nonlocal recorded
        recorded=any(row.get('session_id')==payload.session_id for row in rows)
        return rows if recorded else [payload.model_dump(),*rows]
    await _mutate_sessions(CLOSED_WINDOWS_FILE,MAX_CLOSED_WINDOWS,_closed_windows_lock,add)
    return {"status": "already_recorded" if recorded else "saved", "session_id": payload.session_id, "tab_count": payload.tab_count}


@router.delete("/closed/{session_id}")
async def delete_closed_window(session_id: str):
    """Deletes a closed single-window session."""
    await _mutate_sessions(CLOSED_WINDOWS_FILE,MAX_CLOSED_WINDOWS,_closed_windows_lock,lambda rows:[s for s in rows if s.get('session_id')!=session_id])
    return {"status": "deleted", "session_id": session_id}


@router.delete("/closed")
async def clear_all_closed_windows():
    """Clears all single-window closed history."""
    await _mutate_sessions(CLOSED_WINDOWS_FILE,MAX_CLOSED_WINDOWS,_closed_windows_lock,lambda rows:[])
    return {"status": "cleared"}


# ==========================================
# 2. Multi-Window Browser Shutdown Sessions
# ==========================================

@router.get("/browser-sessions")
async def get_browser_sessions():
    """Returns the last 2 complete browser shutdown sessions with enriched metadata."""
    sessions = await _load_browser_sessions()
    now_ms = time.time() * 1000

    enriched = []
    for s in sessions[:MAX_SAVED_BROWSER_SESSIONS]:
        closed_at = s.get("closed_at", now_ms)
        elapsed_sec = max(0, int((now_ms - closed_at) / 1000))
        if elapsed_sec < 60:
            ago_text = f"{elapsed_sec}s ago"
        elif elapsed_sec < 3600:
            ago_text = f"{elapsed_sec // 60}m ago"
        elif elapsed_sec < 86400:
            ago_text = f"{elapsed_sec // 3600}h ago"
        else:
            ago_text = f"{elapsed_sec // 86400}d ago"

        enriched.append({
            **s,
            "elapsed_seconds": elapsed_sec,
            "closed_ago": ago_text,
            "is_recent_5m": elapsed_sec <= 300,
        })

    return {"sessions": enriched, "count": len(enriched)}


@router.post("/browser-sessions")
async def save_browser_session(payload: BrowserSessionCreate):
    """Saves or updates a multi-window browser shutdown session (retains strictly last 2)."""
    sessions=await _mutate_sessions(BROWSER_SESSIONS_FILE,MAX_SAVED_BROWSER_SESSIONS,_browser_sessions_lock,
        lambda rows:[payload.model_dump(),*[s for s in rows if s.get('session_id')!=payload.session_id]])

    return {
        "status": "saved",
        "session_id": payload.session_id,
        "window_count": payload.window_count,
        "total_tab_count": payload.total_tab_count,
        "cached_sessions_count": len(sessions),
    }


@router.delete("/browser-sessions/{session_id}")
async def delete_browser_session(session_id: str):
    """Deletes a specific browser session."""
    await _mutate_sessions(BROWSER_SESSIONS_FILE,MAX_SAVED_BROWSER_SESSIONS,_browser_sessions_lock,lambda rows:[s for s in rows if s.get('session_id')!=session_id])
    return {"status": "deleted", "session_id": session_id}


@router.delete("/browser-sessions")
async def clear_all_browser_sessions():
    """Clears all cached browser sessions."""
    await _mutate_sessions(BROWSER_SESSIONS_FILE,MAX_SAVED_BROWSER_SESSIONS,_browser_sessions_lock,lambda rows:[])
    return {"status": "cleared"}
