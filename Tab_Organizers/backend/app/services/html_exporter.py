import json
from collections import Counter
from datetime import datetime
from typing import List, Dict, Any, Optional
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATE_DIR = Path(__file__).parent.parent / "templates"
env = Environment(
    loader=FileSystemLoader(TEMPLATE_DIR),
    autoescape=select_autoescape(['html', 'xml'])
)

IGNORED_TOPICS = {"general", "other", "uncategorized", "none", "unknown", ""}


def generate_export_html(
    pages: List[Dict[str, Any]],
    export_title: Optional[str] = None
) -> str:
    """
    Renders a list of page dicts into a self-contained offline HTML file
    following the DESIGN.md visual specification v2.
    """
    template = env.get_template("export.html.j2")

    # 1. Tab Groups: only show if 2+ distinct groups exist
    group_counts = Counter(p.get("group_name") for p in pages if p.get("group_name"))
    distinct_groups = [g for g, _ in group_counts.items() if g] if len(group_counts) >= 2 else []

    # 2. Domains: only show if 3+ distinct domains exist
    domain_counts = Counter(p.get("domain") for p in pages if p.get("domain"))
    distinct_domains = domain_counts.most_common(8) if len(domain_counts) >= 3 else []

    # 3. Topics: only show if 2+ meaningful distinct topics exist
    topic_counts = Counter(
        p.get("topic").strip().lower()
        for p in pages
        if p.get("topic") and p.get("topic").strip().lower() not in IGNORED_TOPICS
    )
    distinct_topics = topic_counts.most_common(6) if len(topic_counts) >= 2 else []

    # Determine whether any filter row should be rendered
    has_filters = bool(distinct_groups or distinct_domains or distinct_topics)

    # Format date
    export_date = datetime.now().strftime("%B %d, %Y")

    # Serialize pages to JSON safe for script tag embedding
    pages_json = json.dumps(pages, ensure_ascii=False)

    return template.render(
        pages=pages,
        pages_json=pages_json,
        export_title=export_title or "Saved Tab Collection",
        export_date=export_date,
        total_count=len(pages),
        distinct_groups=distinct_groups,
        distinct_domains=distinct_domains,
        distinct_topics=distinct_topics,
        has_filters=has_filters,
    )
