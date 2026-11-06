import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_terminator_rules():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Get rules
        res = await ac.get("/api/terminator/rules")
        assert res.status_code == 200
        data = res.json()
        assert "terminate_new_tabs" in data
        assert "deduplicate_tabs" in data
        assert "custom_targets" in data

        # 2. Update rules
        new_config = {
            "terminate_new_tabs": True,
            "deduplicate_tabs": True,
            "custom_targets": [
                {"pattern": "youtube.com", "description": "YouTube feeds", "enabled": True},
                {"pattern": "twitter.com", "description": "Twitter feeds", "enabled": False}
            ]
        }
        put_res = await ac.put("/api/terminator/rules", json=new_config)
        assert put_res.status_code == 200
        assert put_res.json()["status"] == "updated"

        # 3. Verify updated rules
        get_res = await ac.get("/api/terminator/rules")
        assert get_res.status_code == 200
        updated_data = get_res.json()
        assert len(updated_data["custom_targets"]) == 2
        assert updated_data["custom_targets"][0]["pattern"] == "youtube.com"
