"""Cloudflare BGE-M3 inference, with persistent content caching and a daily cap."""
import hashlib
import re
import logging
import httpx
import numpy as np
from app.config import settings
from app.services.state_store import VectorStore

logger=logging.getLogger(__name__)
BATCH_SIZE=32


class EmbeddingUnavailable(RuntimeError):
    pass


class CloudflareEmbedder:
    key='cloudflare:bge-m3:v1'
    dimensions=1024

    def __init__(self, store=None, transport=None):
        self.store=store or VectorStore()
        self.transport=transport

    def encode(self, texts, show_progress_bar=False, normalize_embeddings=True):
        if not re.fullmatch(r'[a-fA-F0-9]{32}',settings.CLOUDFLARE_ACCOUNT_ID or '') or not settings.CLOUDFLARE_API_TOKEN:
            raise EmbeddingUnavailable('Cloudflare credentials are not configured')
        single=isinstance(texts,str)
        inputs=[str(text).strip()[:6000] or 'Saved resource' for text in ([texts] if single else texts)]
        if not inputs:return np.empty((0,self.dimensions),dtype=np.float32)
        keys=[hashlib.sha256((self.key+'\0'+text).encode()).hexdigest() for text in inputs]
        values={key:np.frombuffer(raw,dtype=np.float32).copy() for key,raw in self.store.load(keys).items()}
        # Validate persisted cache data rather than trusting a stale model's shape.
        values={key:vector for key,vector in values.items() if vector.shape==(self.dimensions,) and np.isfinite(vector).all()}
        missing=list(dict((key,text) for key,text in zip(keys,inputs) if key not in values).items())
        url=f'https://api.cloudflare.com/client/v4/accounts/{settings.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3'
        try:
            with httpx.Client(timeout=45,transport=self.transport) as client:
                for start in range(0,len(missing),BATCH_SIZE):
                    batch=missing[start:start+BATCH_SIZE]
                    self.store.reserve(sum(len(text.encode('utf-8')) for _,text in batch))
                    response=client.post(url,headers={'Authorization':f'Bearer {settings.CLOUDFLARE_API_TOKEN}'},json={'text':[text for _,text in batch]})
                    if response.status_code in (500,502,503,504):
                        response=client.post(url,headers={'Authorization':f'Bearer {settings.CLOUDFLARE_API_TOKEN}'},json={'text':[text for _,text in batch]})
                    if response.status_code in (402,429):raise EmbeddingUnavailable('Cloudflare free allowance is unavailable; try again later')
                    if response.status_code!=200:
                        logger.warning('Cloudflare embedding status %s for batch of %s',response.status_code,len(batch))
                        raise EmbeddingUnavailable('Cloudflare embedding request failed')
                    body=response.json()
                    if not body.get('success'):raise EmbeddingUnavailable('Cloudflare did not return embeddings')
                    matrix=np.asarray(body.get('result',{}).get('data'),dtype=np.float32)
                    if matrix.shape!=(len(batch),self.dimensions) or not np.isfinite(matrix).all():raise EmbeddingUnavailable('Invalid embedding response')
                    norms=np.linalg.norm(matrix,axis=1,keepdims=True)
                    if (norms<=0).any():raise EmbeddingUnavailable('Invalid zero embedding')
                    matrix=matrix/norms
                    entries={key:vector for (key,_),vector in zip(batch,matrix)}
                    self.store.save({key:vector.tobytes() for key,vector in entries.items()});values.update(entries)
        except EmbeddingUnavailable:raise
        except Exception:raise EmbeddingUnavailable('Hosted embeddings are temporarily unavailable') from None
        result=np.array([values[key] for key in keys],dtype=np.float32)
        return result[0] if single else result
