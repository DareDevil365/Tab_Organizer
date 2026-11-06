"""One private extension connection key; no accounts, sign-in or user database."""
import hmac
from fastapi import HTTPException, Request, APIRouter
from app.config import settings

router=APIRouter()


def validate_cloud_settings():
    if not settings.cloud:return
    if not settings.DATABASE_URL.startswith(('postgres://','postgresql://','postgresql+psycopg://')):
        raise RuntimeError('Cloud mode requires a PostgreSQL DATABASE_URL')
    if not settings.BACKEND_API_KEY or len(settings.BACKEND_API_KEY)<32:
        raise RuntimeError('Set a private BACKEND_API_KEY of at least 32 characters')
    if settings.EMBEDDING_PROVIDER!='cloudflare':raise RuntimeError('Cloud mode requires hosted cloudflare embeddings')
    if not settings.CLOUDFLARE_ACCOUNT_ID or not settings.CLOUDFLARE_API_TOKEN:raise RuntimeError('Set Cloudflare account ID and API token')
    if not settings.CRON_SECRET or len(settings.CRON_SECRET)<32:raise RuntimeError('Set a CRON_SECRET of at least 32 characters')


async def require_owner(request: Request):
    if not settings.cloud or request.method=='OPTIONS' or request.url.path in {'/health','/auth/config'}:return
    authorization=request.headers.get('authorization','')
    key=settings.CRON_SECRET if request.url.path=='/api/maintenance' else settings.BACKEND_API_KEY
    if not key or not hmac.compare_digest(authorization.encode(),('Bearer '+key).encode()):
        raise HTTPException(401,'Set the private connection key in Settings',headers={'WWW-Authenticate':'Bearer'})


@router.get('/auth/config')
async def auth_config():
    return {'auth_required':settings.cloud,'auth_method':'connection-key' if settings.cloud else 'local'}


@router.get('/auth/session')
async def connection_check():
    return {'connected':True}
