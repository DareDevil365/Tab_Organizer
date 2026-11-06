import logging
import numpy as np
from typing import List, Dict, Any, Tuple, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.page import Page
from app.models.embedding import PageEmbedding
from app.services.embedder import (
    generate_embedding,
    generate_embeddings_batch,
    serialize_vector,
    deserialize_vector,
    compute_cosine_similarity
)
from app.services.ai_provider import get_ai_provider

logger = logging.getLogger(__name__)


async def ensure_page_embeddings(db: AsyncSession) -> int:
    """Finds all pages that lack vector embeddings and embeds them."""
    # Find page IDs that already have embeddings
    emb_stmt = select(PageEmbedding.page_id)
    emb_res = await db.execute(emb_stmt)
    embedded_ids = set(emb_res.scalars().all())

    # Find pages not yet embedded
    stmt = select(Page)
    res = await db.execute(stmt)
    all_pages = res.scalars().all()

    unembedded = [p for p in all_pages if p.id not in embedded_ids]
    if not unembedded:
        return 0

    texts_to_embed = [
        f"Title: {p.title or ''}. Domain: {p.domain or ''}. Topic: {p.topic or ''}. Category: {p.category or ''}. Notes: {p.description or ''}"
        for p in unembedded
    ]

    vectors = generate_embeddings_batch(texts_to_embed)

    new_embeddings = [
        PageEmbedding(
            page_id=page.id,
            vector=serialize_vector(vec),
            model_name="all-MiniLM-L6-v2"
        )
        for page, vec in zip(unembedded, vectors)
    ]

    db.add_all(new_embeddings)
    await db.commit()
    return len(new_embeddings)


async def search_relevant_pages(
    query: str,
    db: AsyncSession,
    top_k: int = 5,
    min_similarity: float = 0.1
) -> List[Dict[str, Any]]:
    """Performs local semantic similarity search over stored page embeddings."""
    await ensure_page_embeddings(db)

    # Load all embeddings
    emb_stmt = select(PageEmbedding)
    emb_res = await db.execute(emb_stmt)
    embeddings = emb_res.scalars().all()

    if not embeddings:
        return []

    # Query embedding
    query_vec = generate_embedding(query)

    # Reconstruct matrix
    doc_vectors = np.array([deserialize_vector(e.vector) for e in embeddings], dtype=np.float32)
    similarities = compute_cosine_similarity(query_vec, doc_vectors)

    # Sort indices
    sorted_indices = np.argsort(-similarities)

    # Fetch corresponding pages
    page_ids = [embeddings[i].page_id for i in sorted_indices[:top_k]]
    page_stmt = select(Page).where(Page.id.in_(page_ids))
    page_res = await db.execute(page_stmt)
    page_dict = {p.id: p for p in page_res.scalars().all()}

    results = []
    for idx in sorted_indices[:top_k]:
        sim = float(similarities[idx])
        if sim < min_similarity:
            continue
        pid = embeddings[idx].page_id
        page = page_dict.get(pid)
        if page:
            results.append({
                "id": page.id,
                "title": page.title,
                "url": page.url_original,
                "url_normalized": page.url_normalized,
                "domain": page.domain,
                "description": page.description,
                "topic": page.topic,
                "category": page.category,
                "similarity_score": round(sim, 3)
            })

    return results


async def ask_brain(question: str, db: AsyncSession) -> Dict[str, Any]:
    """
    RAG conversational assistant: retrieves relevant pages from the user's library
    and asks the AI provider to answer with source citations.
    """
    relevant_pages = await search_relevant_pages(question, db, top_k=6)

    context_lines = []
    for idx, p in enumerate(relevant_pages, 1):
        context_lines.append(
            f"[{idx}] Title: {p['title']}\n"
            f"    URL: {p['url']}\n"
            f"    Domain: {p['domain']}\n"
            f"    Topic: {p['topic'] or 'general'}\n"
            f"    Description: {p['description'] or 'No description'}"
        )
    context_str = "\n\n".join(context_lines)

    system_prompt = (
        "You are the personal knowledge brain assistant for the user's browser tabs and saved library. "
        "Answer the user's question clearly and accurately using the context from their saved pages. "
        "Cite the sources using numbers like [1], [2] corresponding to their saved pages where appropriate. "
        "If their saved library does not have enough information, synthesize a helpful answer while clarifying what came from their library."
    )

    provider = await get_ai_provider()
    answer_text = await provider.generate_response(
        prompt=question,
        context=context_str if context_str else "No directly matching saved pages found in library.",
        system_prompt=system_prompt
    )

    return {
        "question": question,
        "answer": answer_text,
        "sources": relevant_pages,
        "source_count": len(relevant_pages)
    }


async def generate_learning_plan(topic: str, db: AsyncSession) -> Dict[str, Any]:
    """Generates a structured learning roadmap from the user's saved pages on a given topic."""
    relevant_pages = await search_relevant_pages(f"learning study guide {topic}", db, top_k=10)

    context_lines = []
    for idx, p in enumerate(relevant_pages, 1):
        context_lines.append(f"[{idx}] {p['title']} ({p['url']}) - {p['topic']}: {p['description']}")
    context_str = "\n".join(context_lines)

    prompt = (
        f"Create a structured, step-by-step learning syllabus/plan for: '{topic}'.\n"
        f"Incorporate the user's actual saved pages as required reading/resources for each step:\n\n"
        f"User's saved resources:\n{context_str}\n\n"
        f"Organize into: 1) Prerequisites / Fundamentals, 2) Core Concepts, 3) Advanced / Practice. "
        f"Explicitly mention their saved links where relevant."
    )

    provider = await get_ai_provider()
    plan_text = await provider.generate_response(prompt=prompt)

    return {
        "topic": topic,
        "plan": plan_text,
        "resources_used": relevant_pages
    }
