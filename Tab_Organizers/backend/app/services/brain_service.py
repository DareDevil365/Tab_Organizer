import logging
import hashlib
import asyncio
import numpy as np
from typing import List, Dict, Any, Tuple, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_

from app.models.page import Page
from app.services.content_subjects import semantic_content, clean_content, subject_path, website_name
from app.models.embedding import PageEmbedding
from app.models.companion import CompanionNote
from app.services.embedder import (
    generate_embedding,
    generate_embeddings_batch,
    serialize_vector,
    deserialize_vector,
    compute_cosine_similarity
)
from app.services.embedder import embedding_identity
from app.services.cloud_embeddings import EmbeddingUnavailable
from app.services.ai_provider import get_ai_provider

logger = logging.getLogger(__name__)


async def ensure_page_embeddings(db: AsyncSession) -> int:
    """Refresh legacy/platform-heavy or changed embeddings from subject content.

    A versioned content fingerprint uses the existing model_name field, avoiding
    a schema migration and ensuring edited titles/notes metadata get reindexed.
    """
    rows = (await db.execute(select(PageEmbedding))).scalars().all()
    existing = {row.page_id: row for row in rows}
    pages = (await db.execute(select(Page))).scalars().all()
    pending = []
    identity=await asyncio.to_thread(embedding_identity)
    for page in pages:
        text = semantic_content(page)
        fingerprint = hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]
        # v3 also invalidates fallback vectors made with Python's process-seeded
        # hash function, which could not be compared after a backend restart.
        version = f"{identity}:subjects-v4:{fingerprint}"
        row = existing.get(page.id)
        if row is None or row.model_name != version:
            pending.append((page, row, text, version))
    if not pending:
        return 0
    vectors = await asyncio.to_thread(generate_embeddings_batch,[item[2] for item in pending])
    for (page, row, _, version), vector in zip(pending, vectors):
        if row is None:
            db.add(PageEmbedding(page_id=page.id, vector=serialize_vector(vector), model_name=version))
        else:
            row.vector = serialize_vector(vector)
            row.model_name = version
    await db.commit()
    return len(pending)


async def search_relevant_pages(
    query: str,
    db: AsyncSession,
    top_k: int = 5,
    min_similarity: float = 0.1
) -> List[Dict[str, Any]]:
    """Performs local semantic similarity search over stored page embeddings."""
    try:await ensure_page_embeddings(db)
    except EmbeddingUnavailable:return await text_relevant_pages(query,db,top_k)

    emb_stmt = select(PageEmbedding)
    emb_res = await db.execute(emb_stmt)
    embeddings = emb_res.scalars().all()

    if not embeddings:
        return []

    # Search requests can contain pasted links too. Keep query vectors subject-
    # based just like document vectors rather than leaking addresses to RAG.
    try:query_vec = await asyncio.to_thread(generate_embedding,clean_content(query))
    except EmbeddingUnavailable:return await text_relevant_pages(query,db,top_k)

    doc_vectors = np.array([deserialize_vector(e.vector) for e in embeddings], dtype=np.float32)
    similarities = compute_cosine_similarity(query_vec, doc_vectors)

    sorted_indices = np.argsort(-similarities)

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


async def text_relevant_pages(query, db, top_k):
    """Keep Q&A usable on an exhausted free embedding allowance, without mixing vectors."""
    from app.services.library_search import rank_documents
    pages=(await db.execute(select(Page))).scalars().all()
    ranked=await asyncio.to_thread(rank_documents,[{'id':page.id,'title':page.title or '', 'url':page.url_original,'text':semantic_content(page)} for page in pages],query,False)
    by_id={page.id:page for page in pages}
    return [{'id':page.id,'title':page.title,'url':page.url_original,'url_normalized':page.url_normalized,
        'domain':page.domain,'description':page.description,'topic':page.topic,'category':page.category,
        'similarity_score':item['score']/100,'retrieval_mode':'related-text'} for item in ranked['results'][:top_k]
        if item['score']>0 for page in [by_id[item['id']]]]


async def ask_brain(question: str, db: AsyncSession) -> Dict[str, Any]:
    """
    RAG conversational assistant: retrieves relevant pages from the user's library
    and asks the AI provider to answer with source citations.
    """
    relevant_pages = await search_relevant_pages(question, db, top_k=6)

    context_lines = [f"[{idx}] {semantic_content(p)}" for idx, p in enumerate(relevant_pages, 1)]
    context_str = "\n\n".join(context_lines)

    system_prompt = (
        "You are the personal knowledge brain assistant for the user's browser tabs and saved library. "
        "Answer the user's question clearly and accurately using the context from their saved pages. "
        "Cite the sources using numbers like [1], [2] corresponding to their saved pages where appropriate. "
        "If their saved library does not have enough information, synthesize a helpful answer while clarifying what came from their library."
    )

    provider = await get_ai_provider()
    answer_text = await provider.generate_response(
        prompt=clean_content(question),
        context=context_str if context_str else "No directly matching saved pages found in library.",
        system_prompt=system_prompt
    )

    return {
        "question": question,
        "answer": answer_text,
        "sources": relevant_pages,
        "source_count": len(relevant_pages)
    }


async def ask_page_brain(
    page_id: int,
    message: str,
    db: AsyncSession
) -> Dict[str, Any]:
    """
    Dedicated in-context AI assistant for a specific tab/page.
    Automatically context-loads the page metadata, full description, and all user comments/notes.
    User does NOT need to specify which page they are asking about.
    """
    page_stmt = select(Page).where(Page.id == page_id)
    page_res = await db.execute(page_stmt)
    page = page_res.scalar_one_or_none()

    if not page:
        raise ValueError(f"Page with ID {page_id} not found")

    # Fetch all notes/comments linked to this page or URL
    notes_stmt = select(CompanionNote).where(
        or_(
            CompanionNote.page_id == page_id,
            CompanionNote.video_url == page.url_original
        )
    ).order_by(CompanionNote.created_at.asc())
    notes_res = await db.execute(notes_stmt)
    notes = notes_res.scalars().all()

    notes_text_list = []
    for n in notes:
        time_tag = f"[{n.timestamp_formatted}] " if n.timestamp_seconds > 0 else ""
        notes_text_list.append(f"- {time_tag}{clean_content(n.comment)}")

    notes_context = "\n".join(notes_text_list) if notes_text_list else "No user comments or notes yet."

    system_prompt = (
        f"You are the dedicated AI copilot for this specific tab/resource.\n"
        f"Current Tab Details:\n"
        f"- Title: {website_name(page)}\n"
        f"- Subject: {' > '.join(subject_path(page))}\n"
        f"- Stored Summary / Description: {clean_content(page.description or page.content_summary or 'None')}\n\n"
        f"User's Notes and Comments on this resource:\n{notes_context}\n\n"
        f"The user is viewing this tab's detail page right now. You already know what page they are talking about; "
        f"NEVER ask what page or video they mean. Provide direct, helpful, concise answers, summaries, notes expansions, "
        f"or technical explanations specifically for this page."
    )

    provider = await get_ai_provider()
    answer = await provider.generate_response(
        prompt=clean_content(message),
        context=semantic_content(page),
        system_prompt=system_prompt
    )

    return {
        "page_id": page.id,
        "title": page.title,
        "message": message,
        "answer": answer
    }


async def generate_learning_plan(topic: str, db: AsyncSession) -> Dict[str, Any]:
    """Generates a structured learning roadmap from the user's saved pages on a given topic."""
    relevant_pages = await search_relevant_pages(f"learning study guide {topic}", db, top_k=10)

    context_lines = [f"[{idx}] {semantic_content(p)}" for idx, p in enumerate(relevant_pages, 1)]
    context_str = "\n".join(context_lines)

    prompt = (
        f"Create a structured, step-by-step learning syllabus/plan for: '{clean_content(topic)}'.\n"
        f"Incorporate the user's actual saved pages as required reading/resources for each step:\n\n"
        f"User's saved resources:\n{context_str}\n\n"
        f"Organize into: 1) Prerequisites / Fundamentals, 2) Core Concepts, 3) Advanced / Practice. "
        f"Refer to saved resources using source numbers [1], [2]; do not invent links."
    )

    provider = await get_ai_provider()
    plan_text = await provider.generate_response(prompt=prompt)

    return {
        "topic": topic,
        "plan": plan_text,
        "resources_used": relevant_pages
    }
