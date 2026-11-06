from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    AI_PROVIDER: str = 'gemini'
    GEMINI_API_KEY: str | None = None
    OPENROUTER_API_KEY: str | None = None
    OPENROUTER_MODEL: str = 'deepseek/deepseek-v4-flash-0731:free'
    GROQ_API_KEY: str | None = None
    OLLAMA_BASE_URL: str = 'http://localhost:11434'
    DATABASE_URL: str = 'sqlite+aiosqlite:///./data/tab_organizer.db'
    HOST: str = '127.0.0.1'
    PORT: int = 8742

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

settings = Settings()
