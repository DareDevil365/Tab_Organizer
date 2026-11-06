from pathlib import Path
import os
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_ROOT_DIR = _BACKEND_DIR.parent
_ENV_FILES = (
    str(_BACKEND_DIR / ".env"),
    str(_ROOT_DIR / ".env"),
    ".env",
)
if os.environ.get('TAB_ORGANIZER_PROFILE') == 'cloud':
    _ENV_FILES += (str(_BACKEND_DIR / '.env.cloud'),)

class Settings(BaseSettings):
    APP_MODE: str = 'local'
    AI_PROVIDER: str = 'gemini'
    GEMINI_API_KEY: str | None = None
    GEMINI_MODEL: str = 'gemini-flash-lite-latest'
    OPENROUTER_API_KEY: str | None = None
    OPENROUTER_MODEL: str = 'deepseek/deepseek-v4-flash-0731:free'
    GROQ_API_KEY: str | None = None
    OLLAMA_BASE_URL: str = 'http://localhost:11434'
    DATABASE_URL: str = 'sqlite+aiosqlite:///./data/tab_organizer.db'
    HOST: str = '127.0.0.1'
    PORT: int = 8742
    CLASSIFY_ON_STARTUP: bool = True
    EMBEDDING_PROVIDER: str = 'local'
    CLOUDFLARE_ACCOUNT_ID: str | None = None
    CLOUDFLARE_API_TOKEN: str | None = None
    EMBEDDING_DAILY_BYTES: int = 4_000_000
    SUPABASE_URL: str | None = None
    BACKEND_API_KEY: str | None = None
    CRON_SECRET: str | None = None

    @property
    def cloud(self):
        return self.APP_MODE == 'cloud' or os.environ.get('VERCEL') == '1'

    model_config = SettingsConfigDict(env_file=_ENV_FILES, env_file_encoding='utf-8', extra='ignore')

settings = Settings()
