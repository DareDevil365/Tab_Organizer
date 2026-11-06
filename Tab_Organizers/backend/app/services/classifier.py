import json
import logging
import re
from pathlib import Path
from typing import List, Dict, Any, Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_

from app.models.page import Page
from app.services.ai_provider import (
    get_ai_provider,
    AIProvider,
    OpenRouterProvider,
    GeminiProvider,
    GroqProvider,
    OllamaProvider
)

logger = logging.getLogger(__name__)

def get_data_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "data"

DATA_DIR = get_data_dir()
TAXONOMY_RULES_FILE = DATA_DIR / "taxonomy_rules.json"
LEGACY_TAXONOMY_FILE = DATA_DIR / "taxonomy.json"
TAXONOMY_FILE = LEGACY_TAXONOMY_FILE

def _get_rules_file() -> Path:
    if TAXONOMY_RULES_FILE != (Path("./data") / "taxonomy_rules.json") and TAXONOMY_RULES_FILE != (get_data_dir() / "taxonomy_rules.json"):
        return TAXONOMY_RULES_FILE
    return DATA_DIR / "taxonomy_rules.json"

def _get_taxonomy_file() -> Path:
    if TAXONOMY_FILE != (Path("./data") / "taxonomy.json") and TAXONOMY_FILE != (get_data_dir() / "taxonomy.json"):
        return TAXONOMY_FILE
    return DATA_DIR / "taxonomy.json"

DEFAULT_TAXONOMY = [
    "Artificial Intelligence",
    "Programming",
    "Design & UI/UX",
    "Academics & Science",
    "Finance & Business",
    "Hardware & Tech",
    "Automotive & Cars",
    "Music & Audio",
    "Productivity & Tools",
    "Gaming",
    "Social Media & Community",
    "Entertainment & Video",
    "News & Media",
    "other"
]

DEFAULT_TAXONOMY_RULES = [
    {
        "name": "Artificial Intelligence",
        "slug": "ai_ml",
        "keywords": [
            "ai", "llm", "gpt", "claude", "gemini", "machine learning", "deep learning",
            "neural", "diffusion", "transformer", "transformers", "openai", "anthropic",
            "pytorch", "huggingface", "artificial intelligence", "reasoning", "agent",
            "agents", "langchain", "ollama", "chatgpt", "vision models", "large language",
            "vizuara", "cme295", "cme296", "language models", "slm", "small language model",
            "diffusion language", "loss function", "predict the next token"
        ],
        "description": "Artificial intelligence, machine learning models, LLMs, neural networks, and AI tools"
    },
    {
        "name": "Programming",
        "slug": "programming",
        "keywords": [
            "github", "gitlab", "programming", "python", "javascript", "typescript", "react",
            "golang", "rust", "c++", "developer", "coding", "software", "frontend", "backend",
            "api", "framework", "css", "html", "docker", "kubernetes", "bug", "debugging",
            "codeforces", "npm", "sql", "sqlite", "git", "fastapi", "repo", "repos", "code"
        ],
        "description": "Software engineering, web development, algorithms, code repositories, APIs and libraries"
    },
    {
        "name": "Design & UI/UX",
        "slug": "design",
        "keywords": [
            "design", "ui", "ux", "ui/ux", "ui ux", "figma", "styling", "typography",
            "dribbble", "behance", "photoshop", "illustrator", "animation", "motion",
            "color", "palette", "layout", "visual", "fiverr", "logo", "comics", "drawing"
        ],
        "description": "User interface design, Figma, typography, CSS styling, visual arts and graphic design"
    },
    {
        "name": "Academics & Science",
        "slug": "academics",
        "keywords": [
            "stanford", "mit", "harvard", "lecture", "arxiv", "paper", "research", "physics",
            "math", "mathematics", "science", "spring 2026", "autumn 2025", "course",
            "professor", "university", "academic", "journal", "cs f111", "bits",
            "signal", "signals", "systems", "electromagnetic", "circuit", "circuits",
            "engineering", "theory", "field theory", "chemistry", "biology"
        ],
        "description": "University lectures, research papers, mathematics, physics, and scientific studies"
    },
    {
        "name": "Finance & Business",
        "slug": "finance",
        "keywords": [
            "finance", "stock", "crypto", "bitcoin", "ethereum", "money", "investing", "economy",
            "startup", "monopoly", "business", "market", "revenue", "banking", "trading",
            "case study", "venture", "how to beat a monopoly", "valuation", "fixed income"
        ],
        "description": "Markets, economy, cryptocurrency, investing, startup business and monetization"
    },
    {
        "name": "Hardware & Tech",
        "slug": "technology",
        "keywords": [
            "silicon", "chip", "semiconductor", "hardware", "intel", "amd", "nvidia",
            "processor", "gpu", "cpu", "device", "gadget", "apple", "tech", "technology",
            "quantum", "arduino", "raspberry pi", "charger", "anker", "silicon is over",
            "electronic", "electronics", "transistor", "bond model", "tim cook",
            "plane", "aviation", "tracks", "tracker", "privacy"
        ],
        "description": "Computer hardware, chips, semiconductors, gadgets, devices and technology news"
    },
    {
        "name": "Automotive & Cars",
        "slug": "automotive",
        "keywords": [
            "car", "cars", "audi", "jaguar", "ferrari", "porsche", "bmw", "mercedes",
            "horsepower", "type 01", "nuvolari", "prototype", "automotive", "vehicle",
            "engine", "racing", "evo india", "drove", "405 days", "1000hp"
        ],
        "description": "Cars, supercars, automotive engineering, prototypes and driving reviews"
    },
    {
        "name": "Music & Audio",
        "slug": "music",
        "keywords": [
            "music", "song", "album", "spotify", "sound", "track", "audio", "guitar",
            "piano", "synth", "beats", "producer", "band", "concert"
        ],
        "description": "Music tracks, albums, music production, instruments and audio"
    },
    {
        "name": "Productivity & Tools",
        "slug": "productivity",
        "keywords": [
            "notion", "productivity", "notes", "todo", "linear", "slack", "browser extension",
            "tools", "workflow", "organizer", "management", "focus", "inbox", "gmail",
            "email", "zulip", "dash", "tab organizer"
        ],
        "description": "Productivity methods, notes, project management, Notion, extensions and browser tools"
    },
    {
        "name": "Gaming",
        "slug": "gaming",
        "keywords": [
            "game", "gaming", "steam", "playstation", "xbox", "nintendo", "gameplay",
            "walkthrough", "esports", "fps", "rpg", "twitch"
        ],
        "description": "Video games, game development, esports, consoles and gameplay walkthroughs"
    },
    {
        "name": "Social Media & Community",
        "slug": "social_media",
        "keywords": [
            "reddit", "instagram", "twitter", "x.com", "tiktok", "facebook", "linkedin",
            "community", "social", "discord"
        ],
        "description": "Social networks, online communities, forums, discussion and messaging"
    },
    {
        "name": "Entertainment & Video",
        "slug": "entertainment",
        "keywords": [
            "movie", "trailer", "netflix", "film", "cinema", "entertainment", "comedy",
            "show", "series", "actor", "hollywood", "no kings", "essay", "educational content"
        ],
        "description": "Movies, TV shows, entertainment content, comedy and pop culture"
    },
    {
        "name": "News & Media",
        "slug": "news",
        "keywords": [
            "news", "bbc", "cnn", "reuters", "times", "journalism", "article", "breaking",
            "world", "politics", "report", "president", "government", "history"
        ],
        "description": "Current events, journalism, international news and world updates"
    }
]


def load_taxonomy_rules() -> List[Dict[str, Any]]:
    """Loads rich taxonomy rules from disk, merging with defaults to guarantee all categories exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rules_file = _get_rules_file()
    
    disk_rules = []
    if rules_file.exists():
        try:
            with open(rules_file, "r", encoding="utf-8") as f:
                content = json.load(f)
                if isinstance(content, list):
                    disk_rules = content
        except Exception as e:
            logger.warning(f"Failed to read taxonomy_rules.json: {e}")

    # Build map of existing rules on disk by lowercased name and slug
    disk_map = {}
    for r in disk_rules:
        name_key = (r.get("name") or "").strip().lower()
        slug_key = (r.get("slug") or "").strip().lower()
        if name_key:
            disk_map[name_key] = r
        if slug_key:
            disk_map[slug_key] = r

    merged_rules = []
    seen_keys = set()

    for default_rule in DEFAULT_TAXONOMY_RULES:
        name_key = default_rule["name"].strip().lower()
        slug_key = default_rule["slug"].strip().lower()
        
        if name_key in disk_map or slug_key in disk_map:
            user_r = disk_map.get(name_key) or disk_map.get(slug_key)
            user_kws = user_r.get("keywords") or []
            combined_kws = list(dict.fromkeys([k.strip().lower() for k in (list(user_kws) + list(default_rule["keywords"])) if k and k.strip()]))
            merged_rules.append({
                "name": default_rule["name"],
                "slug": default_rule["slug"],
                "keywords": combined_kws,
                "description": user_r.get("description") or default_rule.get("description", "")
            })
        else:
            merged_rules.append(dict(default_rule))
            
        seen_keys.add(name_key)
        seen_keys.add(slug_key)

    # Append any custom user rules from disk that aren't in defaults
    for r in disk_rules:
        name_key = (r.get("name") or "").strip().lower()
        slug_key = (r.get("slug") or "").strip().lower()
        if name_key not in seen_keys and slug_key not in seen_keys:
            merged_rules.append(r)
            if name_key: seen_keys.add(name_key)
            if slug_key: seen_keys.add(slug_key)

    # If disk rules were missing default categories, persist merged rules
    if len(disk_rules) < len(DEFAULT_TAXONOMY_RULES):
        save_taxonomy_rules(merged_rules)

    return merged_rules


def save_taxonomy_rules(rules: List[Dict[str, Any]]) -> None:
    """Saves customized taxonomy rules to disk and syncs legacy list."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rules_file = _get_rules_file()
    with open(rules_file, "w", encoding="utf-8") as f:
        json.dump(rules, f, indent=2)

    # Sync legacy names list
    names = [r.get("name") or r.get("slug") for r in rules if r]
    legacy_file = _get_taxonomy_file()
    with open(legacy_file, "w", encoding="utf-8") as f:
        json.dump(names, f, indent=2)


def reset_taxonomy_rules_to_default() -> List[Dict[str, Any]]:
    """Completely resets taxonomy rules to DEFAULT_TAXONOMY_RULES."""
    save_taxonomy_rules(DEFAULT_TAXONOMY_RULES)
    return list(DEFAULT_TAXONOMY_RULES)


def load_taxonomy() -> List[str]:
    """Loads active taxonomy names list."""
    rules = load_taxonomy_rules()
    names = [r.get("name") or r.get("slug") for r in rules if r]
    if "other" not in [n.lower() for n in names]:
        names.append("other")
    return names


def save_taxonomy(taxonomy: List[str]) -> None:
    """Backwards compatibility helper for updating taxonomy strings."""
    current_rules = load_taxonomy_rules()
    rule_map = {r.get("name", "").lower(): r for r in current_rules}

    new_rules = []
    for item in taxonomy:
        if not item or not item.strip():
            continue
        key = item.strip().lower()
        if key in rule_map:
            new_rules.append(rule_map[key])
        else:
            new_rules.append({
                "name": item.strip(),
                "slug": item.strip().lower().replace(" ", "_"),
                "keywords": [item.strip().lower()],
                "description": f"Tabs related to {item.strip()}"
            })
    save_taxonomy_rules(new_rules)


def classify_by_rules(
    item: Dict[str, Any],
    rules: Optional[List[Dict[str, Any]]] = None
) -> Optional[str]:
    """
    Evaluates title, URL, description, domain, and tags against keyword and description rules.
    Returns the matching rule's name if a strong match is detected.
    """
    if rules is None:
        rules = load_taxonomy_rules()

    title = (item.get("title") or "").lower()
    description = (item.get("description") or "").lower()
    url = (item.get("url") or item.get("url_original") or "").lower()
    domain = (item.get("domain") or "").lower()
    tags = (item.get("tags") or "").lower()

    text_corpus = f"{title} {description} {url} {domain} {tags}"

    best_topic = None
    best_score = 0.0

    for rule in rules:
        topic_name = rule.get("name") or rule.get("slug")
        keywords = rule.get("keywords") or []
        rule_desc = rule.get("description") or ""

        score = 0.0

        for kw in keywords:
            kw_clean = kw.strip().lower()
            if not kw_clean:
                continue

            # Word boundary regex pattern with optional plural 's'
            pattern = r'(?:\b|[\s/_.-])' + re.escape(kw_clean) + r's?(?:\b|[\s/_.-])'

            if re.search(pattern, title):
                score += 3.5
            if re.search(pattern, domain) or re.search(pattern, url):
                score += 3.0
            if re.search(pattern, description):
                score += 2.0
            if re.search(pattern, tags):
                score += 2.5

        if score > best_score and score >= 2.0:
            best_score = score
            best_topic = topic_name

    return best_topic


async def classify_pages_batch_with_fallback(
    items: List[Dict[str, Any]],
    taxonomy: List[str]
) -> List[Dict[str, Any]]:
    """
    Combines high-speed rule-based classification with LLM fallback chain.
    """
    rules = load_taxonomy_rules()
    results = []
    unclassified_items = []

    # 1. Rule-based pre-pass
    for item in items:
        matched = classify_by_rules(item, rules)
        if matched:
            results.append({"id": item["id"], "topic": matched})
        else:
            unclassified_items.append(item)

    if not unclassified_items:
        return results

    # 2. LLM fallback for remaining ambiguous items
    providers: List[AIProvider] = []
    try:
        primary = await get_ai_provider()
        providers.append(primary)
    except Exception as e:
        logger.warning(f"Could not initialize primary AI provider: {e}")

    for candidate in [OpenRouterProvider(), GeminiProvider(), GroqProvider(), OllamaProvider()]:
        if not any(type(candidate) is type(p) for p in providers):
            providers.append(candidate)

    llm_results = None
    for provider in providers:
        try:
            res = await provider.classify_batch(unclassified_items, taxonomy)
            if res:
                llm_results = res
                break
        except Exception as e:
            logger.warning(f"Classification failed with {provider.__class__.__name__}: {e}")

    if llm_results:
        results.extend(llm_results)
    else:
        for item in unclassified_items:
            results.append({"id": item["id"], "topic": "other"})

    return results


async def run_batch_classification(
    db: AsyncSession,
    batch_size: int = 15,
    limit: Optional[int] = 100,
    reclassify_all: bool = False
) -> Dict[str, Any]:
    """
    Classifies pages using rule matching + AI provider.
    If reclassify_all is True, re-evaluates all pages in the library.
    """
    taxonomy = load_taxonomy()

    if reclassify_all:
        query = select(Page).limit(limit or 500)
    else:
        query = select(Page).where(
            or_(
                Page.topic.is_(None),
                Page.topic.in_(['other', 'none', 'unknown', 'uncategorized', ''])
            )
        ).limit(limit or 100)

    res = await db.execute(query)
    pages_to_process = list(res.scalars().all())

    if not pages_to_process:
        return {"classified_count": 0, "remaining_count": 0, "status": "no_pending_pages"}

    total_classified = 0

    for i in range(0, len(pages_to_process), batch_size):
        chunk = pages_to_process[i:i + batch_size]
        items_payload = [
            {
                "id": p.id,
                "title": p.title or "",
                "url": p.url_normalized or p.url_original,
                "description": (p.description or "")[:200],
                "domain": p.domain or "",
                "tags": p.tags or ""
            }
            for p in chunk
        ]

        classifications = await classify_pages_batch_with_fallback(items_payload, taxonomy)
        class_map = {c["id"]: c["topic"] for c in classifications}

        for p in chunk:
            if p.id in class_map:
                p.topic = class_map[p.id]
                total_classified += 1

        await db.commit()

    count_stmt = select(func.count(Page.id)).where(
        or_(
            Page.topic.is_(None),
            Page.topic.in_(['other', 'none', 'unknown', 'uncategorized', ''])
        )
    )
    count_res = await db.execute(count_stmt)
    remaining = count_res.scalar_one()

    return {
        "classified_count": total_classified,
        "remaining_count": remaining,
        "status": "success"
    }


def classify_single_page_rule(page_data: Dict[str, Any]) -> Optional[str]:
    """Synchronous rule classifier for immediate tab upserts."""
    rules = load_taxonomy_rules()
    return classify_by_rules(page_data, rules)


def suggest_page_tags(page_data: Dict[str, Any]) -> List[str]:
    """Extracts matching keywords from taxonomy rules to suggest as tags."""
    rules = load_taxonomy_rules()
    title = (page_data.get("title") or "").lower()
    description = (page_data.get("description") or "").lower()
    url = (page_data.get("url") or page_data.get("url_original") or "").lower()
    domain = (page_data.get("domain") or "").lower()

    text = f"{title} {description} {url} {domain}"
    matched_kws = []

    for rule in rules:
        for kw in rule.get("keywords") or []:
            kw_clean = kw.strip().lower()
            if len(kw_clean) < 3:
                continue
            pattern = r'(?:\b|[\s/_.-])' + re.escape(kw_clean) + r's?(?:\b|[\s/_.-])'
            if re.search(pattern, text):
                matched_kws.append(kw_clean)

    return list(dict.fromkeys(matched_kws))[:5]


async def run_background_classification(batch_size: int = 15, limit: int = 100) -> None:
    """Helper for FastAPI BackgroundTasks that creates its own session."""
    from app.database import async_session_maker
    try:
        async with async_session_maker() as session:
            await run_batch_classification(session, batch_size=batch_size, limit=limit, reclassify_all=False)
    except Exception as e:
        logger.error(f"Background classification task error: {e}")
