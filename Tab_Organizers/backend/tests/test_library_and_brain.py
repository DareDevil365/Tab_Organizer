import pytest
import numpy as np
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select

from app.database import Base
from app.models.page import Page
from app.models.reminder import Reminder
from app.models.activity import ActivityLog
from app.services.embedder import generate_embedding, compute_cosine_similarity
from app.services.graph_service import build_knowledge_graph


@pytest.mark.asyncio
async def test_embedder_and_similarity():
    v1 = generate_embedding("machine learning artificial intelligence deep neural networks")
    v2 = generate_embedding("artificial intelligence and machine learning models")
    v3 = generate_embedding("italian pasta cooking recipe with tomato sauce")

    assert v1.shape == (384,)
    assert v2.shape == (384,)
    assert v3.shape == (384,)

    sim_1_2 = compute_cosine_similarity(v1, v2.reshape(1, -1))[0]
    sim_1_3 = compute_cosine_similarity(v1, v3.reshape(1, -1))[0]

    # AI query should be significantly more similar to AI than cooking
    assert sim_1_2 > sim_1_3


@pytest.mark.asyncio
async def test_knowledge_graph_generation():
    test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    test_session = async_sessionmaker(test_engine, expire_on_commit=False, class_=AsyncSession)

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with test_session() as session:
        p1 = Page(
            url_original="https://github.com/fastapi",
            url_normalized="https://github.com/fastapi",
            title="FastAPI Repo",
            domain="github.com",
            topic="programming",
            category="Backend Dev"
        )
        p2 = Page(
            url_original="https://github.com/react",
            url_normalized="https://github.com/react",
            title="React Repo",
            domain="github.com",
            topic="programming",
            category="Frontend Dev"
        )
        session.add_all([p1, p2])
        await session.commit()

        graph = await build_knowledge_graph(session)
        assert graph["total_nodes"] > 0
        assert graph["total_edges"] > 0

        # Both pages should connect to github.com domain node and programming topic node
        node_types = {n["type"] for n in graph["nodes"]}
        assert "page" in node_types
        assert "domain" in node_types
        assert "topic" in node_types

    await test_engine.dispose()
