import time
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_browser_sessions_lifecycle_and_fifo():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Clear existing sessions first
        await ac.delete("/api/windows/browser-sessions")

        now_ms = time.time() * 1000

        # 1. Post Session 1
        s1 = {
            "session_id": "session_1",
            "closed_at": now_ms - 20000,
            "window_count": 2,
            "total_tab_count": 5,
            "title_preview": "Window 1, Window 2",
            "windows": [
                {
                    "window_index": 0,
                    "tabs": [
                        {"title": "Doc 1", "url": "https://example.com/1", "groupId": 1, "groupTitle": "Dev", "groupColor": "blue"},
                        {"title": "Doc 2", "url": "https://example.com/2"}
                    ],
                    "groups": [{"id": 1, "title": "Dev", "color": "blue"}]
                },
                {
                    "window_index": 1,
                    "tabs": [
                        {"title": "Doc 3", "url": "https://example.com/3"},
                        {"title": "Doc 4", "url": "https://example.com/4"},
                        {"title": "Doc 5", "url": "https://example.com/5"}
                    ]
                }
            ]
        }
        res1 = await ac.post("/api/windows/browser-sessions", json=s1)
        assert res1.status_code == 200
        assert res1.json()["status"] == "saved"
        assert res1.json()["cached_sessions_count"] == 1

        # 2. Post Session 2
        s2 = {
            "session_id": "session_2",
            "closed_at": now_ms - 10000,
            "window_count": 1,
            "total_tab_count": 2,
            "title_preview": "Single Window",
            "windows": [
                {
                    "window_index": 0,
                    "tabs": [
                        {"title": "Github", "url": "https://github.com"},
                        {"title": "Arxiv", "url": "https://arxiv.org"}
                    ]
                }
            ]
        }
        res2 = await ac.post("/api/windows/browser-sessions", json=s2)
        assert res2.status_code == 200
        assert res2.json()["cached_sessions_count"] == 2

        # 3. Post Session 3 -> should evict Session 1 and keep Session 3 and Session 2!
        s3 = {
            "session_id": "session_3",
            "closed_at": now_ms,
            "window_count": 1,
            "total_tab_count": 1,
            "title_preview": "Latest Session",
            "windows": [
                {
                    "window_index": 0,
                    "tabs": [{"title": "Karl X", "url": "https://example.com/karlx"}]
                }
            ]
        }
        res3 = await ac.post("/api/windows/browser-sessions", json=s3)
        assert res3.status_code == 200
        assert res3.json()["cached_sessions_count"] == 2

        # 4. Get browser sessions -> should contain only session_3 and session_2
        get_res = await ac.get("/api/windows/browser-sessions")
        assert get_res.status_code == 200
        data = get_res.json()
        assert data["count"] == 2
        session_ids = [s["session_id"] for s in data["sessions"]]
        assert "session_3" in session_ids
        assert "session_2" in session_ids
        assert "session_1" not in session_ids  # Evicted!

        # 5. Delete session_3
        del_res = await ac.delete("/api/windows/browser-sessions/session_3")
        assert del_res.status_code == 200

        get_res2 = await ac.get("/api/windows/browser-sessions")
        assert get_res2.json()["count"] == 1
        assert get_res2.json()["sessions"][0]["session_id"] == "session_2"
