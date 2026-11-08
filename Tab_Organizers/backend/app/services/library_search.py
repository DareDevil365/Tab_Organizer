"""Local hybrid ranking over the entire saved library, including companion notes."""
import asyncio
import difflib
import hashlib
import math
import re
import threading
from collections import Counter, OrderedDict
import numpy as np
from sqlalchemy import select
from app.models.page import Page
from app.models.companion import CompanionNote
from app.services.content_subjects import semantic_content, clean_content
from app.services.embedder import get_embedding_model, FallbackEmbedder
from app.config import settings

_encoder_lock = threading.Lock()
_vectors = OrderedDict()
STOP = {'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'how', 'with', 'from', 'it', 'my'}
# Explicit terminology helps brand/tool queries and the offline lexical fallback.
RELATED = [
    ('video editing motion graphics post production', r'\b(?:video edit\w*|film edit\w*|after effects|aftereffects|premiere pro|davinci resolve|final cut|capcut|motion design\w*|motion graphics|compositing|vfx|color grading|keyframing)\b'),
    ('artificial intelligence machine learning', r'\b(?:llms?|neural networks?|transformers?|deep learning|machine learning|artificial intelligence)\b'),
    ('web development frontend programming', r'\b(?:react|typescript|javascript|frontend|web development|css|html)\b'),
    ('backend development programming', r'\b(?:python|fastapi|django|backend|sql|databases?)\b'),
    ('interface design typography visual design', r'\b(?:ui ux|interface design|typography|typefaces?|figma|graphic design)\b'),
]


def words(text):
    return [word for word in re.findall(r'[^\W_]+', text.casefold()) if word not in STOP and len(word) > 1]


def expand(text):
    return text + '\n' + '\n'.join(label for label, pattern in RELATED if re.search(pattern, text, re.I))


def interpret_query(query, vocabulary):
    # Never rewrite a term already present; correct conservative near-miss spellings.
    result = []
    ordered = sorted(vocabulary, key=lambda word: (-vocabulary[word], word))
    for word in words(clean_content(query)):
        if word not in vocabulary and len(word) >= 4:
            candidates = [candidate for candidate in ordered if abs(len(candidate) - len(word)) <= 1 and candidate[0] == word[0]]
            close = difflib.get_close_matches(word, candidates, n=1, cutoff=.79 if len(word) >= 5 else .84)
            if close:
                word = close[0]
        result.append(word)
    return ' '.join(result)


def _semantic_scores(texts, query):
    with _encoder_lock:
        model = get_embedding_model()
        if isinstance(model, FallbackEmbedder):
            return np.zeros(len(texts)), 'related-text'
        inputs = texts + [query]
        keys = [hashlib.sha256((settings.EMBEDDING_PROVIDER+'\0'+text).encode('utf-8')).hexdigest() for text in inputs]
        missing = dict((key, text) for key, text in zip(keys, inputs) if key not in _vectors)
        if missing:
            encoded = model.encode(list(missing.values()), show_progress_bar=False, normalize_embeddings=True)
            _vectors.update(zip(missing, encoded))
        matrix = np.array([_vectors[key] for key in keys], dtype=np.float32)
        for key in keys:
            _vectors.move_to_end(key)
        while len(_vectors) > 3000:
            _vectors.popitem(last=False)
        return np.dot(matrix[:-1], matrix[-1]), 'semantic'


def rank_documents(documents, query, use_semantic=True):
    if not documents:
        return {'results': [], 'interpreted_query': query, 'mode': 'related-text', 'total': 0}
    texts = [expand(document['text']) for document in documents]
    tokens = [Counter(words(text)) for text in texts]
    vocabulary = sum(tokens, Counter())
    for label, _ in RELATED:
        vocabulary.update(words(label))
    interpreted = interpret_query(query, vocabulary)
    expanded_query = expand(interpreted)
    query_words = set(words(expanded_query))
    average = max(1, sum(sum(t.values()) for t in tokens) / len(tokens))
    frequencies = Counter(term for row in tokens for term in row)
    try:
        if not use_semantic:raise ValueError('Text fallback requested')
        similarities, mode = _semantic_scores(texts, expanded_query)
    except Exception:
        similarities, mode = np.zeros(len(texts)), 'related-text'
    results = []
    for i, (document, row) in enumerate(zip(documents, tokens)):
        lexical = 0
        length = sum(row.values())
        for term in query_words:
            count = row[term]
            if count:
                idf = math.log(1 + (len(tokens) - frequencies[term] + .5) / (frequencies[term] + .5))
                lexical += idf * count * 2.2 / (count + 1.2 * (.25 + .75 * length / average))
        lexical_score = lexical / (lexical + 2) if lexical else 0
        title = ' '.join(words(document['title']))
        phrase = bool(interpreted and interpreted in title)
        url_match = bool(query.strip() and query.strip().casefold() in document.get('url', '').casefold())
        semantic = max(0, min(1, float(similarities[i])))
        score = max(.96 if phrase else 0, .98 if url_match else 0, .85 * lexical_score, .9 * semantic)
        results.append({'id': document['id'], 'score': round(score * 100)})
    # Stable input order breaks ties. There is deliberately no top-k/threshold cutoff.
    results.sort(key=lambda item: -item['score'])
    return {'results': results, 'interpreted_query': interpreted, 'mode': mode, 'total': len(results)}


async def search_library(db, query):
    pages = (await db.execute(select(Page).order_by(Page.created_at.desc(), Page.id.desc()))).scalars().all()
    notes = (await db.execute(select(CompanionNote.page_id, CompanionNote.comment))).all()
    by_page = {}
    for page_id, comment in notes:
        if page_id is not None:
            by_page.setdefault(page_id, []).append(clean_content(comment or ''))
    documents = [{'id': page.id, 'title': clean_content(page.title or ''), 'url': page.url_original,
                  'text': '\n'.join([semantic_content(page),
                                     '\n'.join(by_page.get(page.id, []))[:6000]])} for page in pages]
    return await asyncio.to_thread(rank_documents, documents, query)
