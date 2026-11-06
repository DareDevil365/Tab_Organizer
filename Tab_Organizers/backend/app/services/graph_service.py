from collections import defaultdict
from typing import List, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.page import Page


async def build_knowledge_graph(db: AsyncSession, limit: int = 200) -> Dict[str, Any]:
    """
    Constructs a lightweight knowledge graph from saved pages.
    Nodes: Pages, Topics, Domains, Categories.
    Edges: Relationships connecting pages to topics, domains, and shared contexts.
    """
    stmt = select(Page).order_by(Page.created_at.desc()).limit(limit)
    res = await db.execute(stmt)
    pages = res.scalars().all()

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    seen_nodes = set()

    # Track co-occurrences
    domain_pages = defaultdict(list)
    topic_pages = defaultdict(list)
    category_pages = defaultdict(list)

    for p in pages:
        p_node_id = f"page_{p.id}"
        if p_node_id not in seen_nodes:
            nodes.append({
                "id": p_node_id,
                "label": p.title or p.domain or "Page",
                "type": "page",
                "url": p.url_original,
                "domain": p.domain,
                "topic": p.topic or "other",
                "category": p.category or "uncategorized",
                "val": 5
            })
            seen_nodes.add(p_node_id)

        # Domain node
        if p.domain:
            d_node_id = f"domain_{p.domain}"
            if d_node_id not in seen_nodes:
                nodes.append({
                    "id": d_node_id,
                    "label": p.domain,
                    "type": "domain",
                    "val": 10
                })
                seen_nodes.add(d_node_id)
            edges.append({
                "source": p_node_id,
                "target": d_node_id,
                "type": "has_domain"
            })
            domain_pages[p.domain].append(p_node_id)

        # Topic node
        if p.topic and p.topic != "other":
            t_node_id = f"topic_{p.topic}"
            if t_node_id not in seen_nodes:
                nodes.append({
                    "id": t_node_id,
                    "label": p.topic.upper(),
                    "type": "topic",
                    "val": 12
                })
                seen_nodes.add(t_node_id)
            edges.append({
                "source": p_node_id,
                "target": t_node_id,
                "type": "has_topic"
            })
            topic_pages[p.topic].append(p_node_id)

        # Category node
        if p.category:
            c_node_id = f"cat_{p.category}"
            if c_node_id not in seen_nodes:
                nodes.append({
                    "id": c_node_id,
                    "label": f"📁 {p.category}",
                    "type": "category",
                    "val": 14
                })
                seen_nodes.add(c_node_id)
            edges.append({
                "source": p_node_id,
                "target": c_node_id,
                "type": "in_folder"
            })
            category_pages[p.category].append(p_node_id)

    return {
        "nodes": nodes,
        "edges": edges,
        "total_nodes": len(nodes),
        "total_edges": len(edges)
    }
