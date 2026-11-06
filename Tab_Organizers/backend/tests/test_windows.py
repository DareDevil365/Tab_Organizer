import time
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_closed_windows_lifecycle():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Clear existing
        await ac.delete("/api/windows/closed")

        now_ms = time.time() * 1000

        # 2. Save a closed window session (recent)
        session_data = {
            "session_id": "win_test_recent",
            "closed_at": now_ms - 30000,  # 30 seconds ago
            "tab_count": 3,
            "title_preview": "GitHub, Google, Claude",
            "tabs": [
                {"title": "GitHub", "url": "https://github.com", "favIconUrl": ""},
                {"title": "Google", "url": "https://google.com", "favIconUrl": ""},
                {"title": "Claude", "url": "https://claude.ai", "favIconUrl": ""}
            ],
            "groups": []
        }
        res = await ac.post("/api/windows/closed", json=session_data)
        assert res.status_code == 200
        assert res.json()["status"] == "saved"

        # 3. Save an expired session (10 minutes ago)
        expired_session = {
            "session_id": "win_test_expired",
            "closed_at": now_ms - 600000,  # 10 minutes ago
            "tab_count": 2,
            "title_preview": "Old Tabs",
            "tabs": [
                {"title": "Old", "url": "https://old.com", "favIconUrl": ""}
            ],
            "groups": []
        }
        await ac.post("/api/windows/closed", json=expired_session)

        # 4. Retrieve closed windows - only the recent one (< 5 min) should be returned!
        get_res = await ac.get("/api/windows/closed")
        assert get_res.status_code == 200
        data = get_res.json()
        assert len(data["sessions"]) == 1
        assert data["sessions"][0]["session_id"] == "win_test_recent"
        assert data["sessions"][0]["tab_count"] == 3
        assert data["sessions"][0]["is_recent_5m"] is True

        # 5. Delete specific session
        del_res = await ac.delete("/api/windows/closed/win_test_recent")
        assert del_res.status_code == 200
        assert del_res.json()["status"] == "deleted"
