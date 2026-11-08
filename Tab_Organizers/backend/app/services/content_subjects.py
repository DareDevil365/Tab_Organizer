"""Content-first subjects for graph projection and retrieval; saved metadata is unchanged."""
import re
from urllib.parse import urlparse
from typing import Any
from app.services.subject_taxonomy import canonical_subject_path


def _get(page: Any, field: str) -> str:
    value = page.get(field) if isinstance(page, dict) else getattr(page, field, None)
    return str(value or '').strip()


def clean_content(text: str) -> str:
    # Remove links/hostnames across TLDs, including .ai/.dev/.ac. No URL tokens
    # reach the semantic encoder or model context, even inside descriptions.
    text = re.sub(r"(?:https?://|www\.)[^\s<>]+", ' ', text, flags=re.I)
    text = re.sub(r"\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:/[^\s<>]*)?", ' ', text, flags=re.I)
    text = re.sub(r'\b(?:YouTube|Vimeo)\b', ' ', text, flags=re.I)
    return re.sub(r'\s+', ' ', text).strip(' -|')


def website_name(page: Any) -> str:
    # Used only when the stored heading is missing/a URL. Keep the human brand
    # name, never the address or path. Prefer captured readable metadata.
    title = clean_content(_get(page, 'title'))
    if title and title.lower() not in {'untitled', 'saved page', 'untitled video'}:
        return re.sub(r'\s*[-|]\s*YouTube\s*$', '', title, flags=re.I).strip()
    hostname = urlparse(_get(page, 'url_original') or _get(page, 'url_normalized')).hostname or _get(page, 'domain')
    parts = hostname.lower().removeprefix('www.').split('.')
    brand = parts[0] if parts else ''
    return brand.replace('-', ' ').title() if brand else 'Saved resource'


SUBJECT_RULES = [
    (r'\bhackathons?\b|\bdemo day\b', ('Building & Opportunities', 'Hackathons')),
    (r'\bmotion design\w*\b|\bmotion graphics?\b|\bkeyfram\w*\b', ('Creative Work', 'Video Editing', 'Motion Design')),
    (r'\bvideo edit\w*\b|\bfilm edit\w*\b|\bafter ?effects\b|\bpremiere pro\b|\bdavinci resolve\b|\bcapcut\b|\bpost.production\b|\bcompositing\b|\bvfx\b|\bcolor grading\b', ('Creative Work', 'Video Editing')),
    (r'\bcad\b|\bfreecad\b|\bautocad\b|\bsolidworks\b|\bfusion 360\b|\b3d (?:design|model\w*)\b', ('Creative Work', 'Design', 'CAD & 3D Design')),
    (r'\bmovie\w*\b|\btrailer\b|\bteaser\b|\b(?:film|tv|television) series\b|\bseason \d+\b', ('Entertainment', 'Movies & TV')),
    (r'\b(?:flute|guitar|piano|violin|ukulele|drum|singing)\b|\bmusic lesson\w*\b|\bmusical instrument\w*\b|\bsong\b|\blyrics?\b', ('Hobbies', 'Music & Audio')),
    (r'\brecipe\w*\b|\bcook(?:ing|ery)?\b|\bbaking\b|\bfood lesson\w*\b', ('Hobbies', 'Cooking')),
    (r'\bworkout\w*\b|\bfitness\b|\byoga\b|\bweight training\b', ('Hobbies', 'Fitness & Wellbeing')),
    (r'\bnews\b|\bheadlines?\b|\bbreaking\b|\bcurrent affairs\b|\bjournalism\b', ('People & Media', 'News & Current Affairs')),
    (r'\bsocial media\b|\bcontent creat\w*\b|\bcreator economy\b|\binstagram\b|\btiktok\b|\blinkedin\b', ('People & Media', 'Social Media')),
    (r'\bopen.source\b|\bfoss\b', ('Technology', 'Programming', 'Open Source')),
    (r'\b(?:gpu|cpu|hardware|semiconductor|arduino|raspberry pi|circuit|microcontroller|turbine)\b|\b3d print\w*\b', ('Technology', 'Hardware & Computing')),
    (r'\bautomotive\b|\bsupercar\w*\b|\belectric car\w*\b|\bcar review\b', ('Technology', 'Hardware & Computing', 'Automotive & Cars')),
    (r'\bvideo game\w*\b|\bgameplay\b|\bgaming\b|\bminecraft\b|\besports\b', ('Entertainment', 'Gaming')),
    (r'\bproductivity\b|\btask management\b|\bnote.taking\b', ('Work & Life', 'Productivity & Tools')),
    (r'\btransformers?\b|\battention mechanism\b', ('Technology', 'AI & Machine Learning', 'Transformers')),
    (r'\bdiffusion\b', ('Technology', 'AI & Machine Learning', 'Diffusion Models')),
    (r'\bretrieval augmented\b|\brag\b|\bembeddings?\b|\bvector search\b', ('Technology', 'AI & Machine Learning', 'Retrieval & Embeddings')),
    (r'\bneural networks?\b|\bdeep learning\b|\bmachine learning\b|\blanguage models?\b|\bllms?\b|\bAI\b', ('Technology', 'AI & Machine Learning')),
    (r'\breact\b|\btypescript\b|\bjavascript\b|\bfrontend\b', ('Technology', 'Programming', 'Web Development')),
    (r'\bpython\b|\bfastapi\b|\bbackend\b', ('Technology', 'Programming', 'Backend Development')),
    (r'\btypography\b|\btypeface\b', ('Creative Work', 'Design', 'Typography')),
    (r'\bui\b|\bux\b|\binterface\b|\bdesign system\b|\bglassmorphism\b', ('Creative Work', 'Design', 'Interface Design')),
    (r'\bdesign\b', ('Creative Work', 'Design')),
    (r'\bfourier\b|\blinear algebra\b|\bcalculus\b|\bmathematics\b', ('Learning', 'Mathematics')),
    (r'\bphysics\b|\bchemistry\b|\bbiology\b', ('Learning', 'Science')),
    (r'\bfinance\b|\binvesting\b|\bstock market\b', ('Learning', 'Finance')),
    (r'\bprogramming\b|\balgorithms?\b|\bsoftware\b', ('Technology', 'Programming')),
]


def subject_path(page: Any) -> tuple[str, ...]:
    # Title evidence wins over boilerplate descriptions and old platform labels.
    title = website_name(page)
    details = clean_content(' '.join(_get(page, f) for f in ('description', 'content_summary')))
    for corpus in (title, details):
        for pattern, path in SUBJECT_RULES:
            if re.search(pattern, corpus, re.I):
                return canonical_subject_path(path[-1]) or path
    # Saved labels may be old keyword guesses, not independent content evidence.
    # Preserve them in storage, but do not turn them into semantic truth.
    # Fallback is the readable website name and its description, never its URL.
    if re.search(r'\bdevfolio\b', title, re.I):
        return ('Building & Opportunities', 'Hackathons')
    return ('Needs a Topic',)


def subject_paths(page: Any, note_text: str = '') -> list[tuple[str, ...]]:
    """Every content-supported subject, without ancestor duplicates or URL evidence."""
    title = website_name(page)
    details = clean_content(' '.join(_get(page, field) for field in ('description', 'content_summary')))
    matches = []
    # Notes and saved/automatically suggested tags cannot assign subjects.
    for corpus in (title, details):
        for pattern, path in SUBJECT_RULES:
            if re.search(pattern, corpus, re.I):
                path = canonical_subject_path(path[-1]) or path
                if path not in matches: matches.append(path)
    if any('AI & Machine Learning' in path for path in matches) and re.search(r'\bnews\b|\bupdates?\b|\breleases?\b|\blaunch\w*\b', title, re.I):
        news_path=canonical_subject_path('AI News')
        if news_path:matches.insert(0,news_path)
    if any('Generative Media' in path for path in matches) and re.search(r'\bvideo\b', title, re.I):
        editing_path=canonical_subject_path('Video Editing')
        if editing_path:matches.append(editing_path)
    if not matches: matches = [subject_path(page)]
    return [path for i, path in enumerate(matches) if path and path not in matches[:i]
            and not any(len(other) > len(path) and other[:len(path)] == path for other in matches)]


def semantic_content(page: Any) -> str:
    title = website_name(page)
    # Platform suffixes are navigation chrome, not semantic subject evidence.
    title = re.sub(r'\s*[-|]\s*(?:YouTube|Vimeo)\s*$', '', title, flags=re.I)
    # Embed source content, never a previous classifier's conclusions. Otherwise
    # one bad label reinforces itself in retrieval and later model answers.
    parts = [title]
    parts += [clean_content(_get(page, f)) for f in ('description', 'content_summary')]
    parts.append(clean_content(_get(page, 'full_text'))[:6000])
    return '\n'.join(part for part in parts if part)


def library_subjects(page: Any) -> list[str]:
    """Content-derived headings are a projection, never a rewrite of saved metadata.

    A resource can appear under several headings when its title contains explicit
    evidence (for example AI hardware); graph ancestry still has one primary path.
    """
    paths = subject_paths(page)
    structural = {'Technology', 'Creative Work', 'People & Media', 'Work & Life', 'Building & Opportunities', 'Learning'}
    labels = []
    for path in paths:
        for label in path:
            if label == 'Needs a Topic' or (len(path) > 1 and label in structural): continue
            if label not in labels: labels.append(label)
    return labels
