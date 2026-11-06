import time
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.asyncio
async def test_bulk_save_pages_logic():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        uid = int(time.time() * 1000)
        # 1. Save 2 initial pages
        initial_payload = {
            "tabs": [
                {
                    "url_original": f"https://example.com/unique_{uid}_1",
                    "url_normalized": f"https://example.com/unique_{uid}_1",
                    "title": "Machine Learning Tutorial",
                    "domain": "example.com"
                },
                {
                    "url_original": f"https://example.com/unique_{uid}_2",
                    "url_normalized": f"https://example.com/unique_{uid}_2",
                    "title": "FastAPI Repo",
                    "domain": "example.com"
                }
            ]
        }
        res1 = await ac.post("/api/pages/save-bulk", json=initial_payload)
        assert res1.status_code == 200
        data1 = res1.json()
        assert data1["new_saved_count"] == 2
        assert data1["updated_count"] == 0

        # 2. Save 3 pages (2 existing + 1 brand new)
        second_payload = {
            "tabs": [
                {
                    "url_original": f"https://example.com/unique_{uid}_1",
                    "url_normalized": f"https://example.com/unique_{uid}_1",
                    "title": "Machine Learning Tutorial Updated",
                    "domain": "example.com"
                },
                {
                    "url_original": f"https://example.com/unique_{uid}_2",
                    "url_normalized": f"https://example.com/unique_{uid}_2",
                    "title": "FastAPI Repo",
                    "domain": "example.com"
                },
                {
                    "url_original": f"https://example.com/unique_{uid}_3",
                    "url_normalized": f"https://example.com/unique_{uid}_3",
                    "title": "Diffusion Models Paper",
                    "domain": "example.com"
                }
            ]
        }
        res2 = await ac.post("/api/pages/save-bulk", json=second_payload)
        assert res2.status_code == 200
        data2 = res2.json()
        # Exactly 1 new saved, and 2 updated!
        assert data2["new_saved_count"] == 1
        assert data2["updated_count"] == 2
