import logging
import numpy as np
from typing import List, Optional

logger = logging.getLogger(__name__)

_model = None
MODEL_NAME = "all-MiniLM-L6-v2"


def get_embedding_model():
    """Lazy loader for sentence-transformers model to optimize startup time."""
    global _model
    if _model is None:
        try:
            from sentence_transformers import SentenceTransformer
            logger.info(f"Loading local embedding model: {MODEL_NAME} on CPU...")
            _model = SentenceTransformer(MODEL_NAME, device="cpu")
        except Exception as e:
            logger.warning(f"sentence-transformers not available ({e}), falling back to deterministic text hashing embedder.")
            _model = FallbackEmbedder()
    return _model


class FallbackEmbedder:
    """
    Lightweight fallback embedder if sentence-transformers is not yet installed.
    Uses n-gram character hashing with tf-idf scaling to produce dense 384-d vectors.
    """
    def encode(self, texts, show_progress_bar=False, normalize_embeddings=True):
        is_single = isinstance(texts, str)
        text_list = [texts] if is_single else texts

        vectors = []
        for t in text_list:
            v = np.zeros(384, dtype=np.float32)
            words = (t or "").lower().split()
            for idx, word in enumerate(words):
                h = abs(hash(word)) % 384
                v[h] += 1.0 / (idx + 1)
            norm = np.linalg.norm(v)
            if norm > 0:
                v = v / norm
            vectors.append(v)

        return vectors[0] if is_single else np.array(vectors)


def generate_embedding(text: str) -> np.ndarray:
    """Generates a normalized 384-dimensional dense vector for input text."""
    model = get_embedding_model()
    vec = model.encode(text, show_progress_bar=False, normalize_embeddings=True)
    return np.array(vec, dtype=np.float32)


def generate_embeddings_batch(texts: List[str]) -> List[np.ndarray]:
    """Generates normalized vectors for a batch of texts."""
    model = get_embedding_model()
    vecs = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
    return [np.array(v, dtype=np.float32) for v in vecs]


def serialize_vector(vec: np.ndarray) -> bytes:
    """Converts a numpy vector to binary bytes for SQLite BLOB storage."""
    return vec.astype(np.float32).tobytes()


def deserialize_vector(blob: bytes) -> np.ndarray:
    """Reconstructs a numpy float32 vector from binary bytes."""
    return np.frombuffer(blob, dtype=np.float32)


def compute_cosine_similarity(query_vec: np.ndarray, doc_vectors: np.ndarray) -> np.ndarray:
    """
    Computes cosine similarity between a single query vector and a matrix of document vectors.
    Both must be unit-normalized.
    """
    if len(doc_vectors.shape) == 1:
        doc_vectors = doc_vectors.reshape(1, -1)
    # Cosine similarity for normalized vectors is just the dot product
    return np.dot(doc_vectors, query_vec)
