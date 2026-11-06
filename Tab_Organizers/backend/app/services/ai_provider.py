import abc
import json
import logging
import re
from typing import List, Dict, Any, Optional
import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class AIProvider(abc.ABC):
    """Abstract base class for all AI providers (Gemini, Groq, Ollama)."""

    @abc.abstractmethod
    async def classify_batch(
        self,
        items: List[Dict[str, Any]],
        taxonomy: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Classifies a list of items into topics from the given taxonomy.
        Returns: list of dicts with {"id": item_id, "topic": classified_topic}
        """
        pass

    @abc.abstractmethod
    async def generate_response(
        self,
        prompt: str,
        context: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> str:
        """Generates conversational text with context for the Brain assistant."""
        pass


class GeminiProvider(AIProvider):
    """Free-tier Google Gemini API provider with multi-key rotation and fallback."""

    def __init__(self, api_key: Optional[str] = None):
        raw_key = api_key or settings.GEMINI_API_KEY or ""
        self.api_keys = [k.strip() for k in raw_key.split(",") if k.strip()]
        self.models = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-pro"]
        self.base_url = "https://generativelanguage.googleapis.com/v1beta/models"

    async def classify_batch(
        self,
        items: List[Dict[str, Any]],
        taxonomy: List[str]
    ) -> List[Dict[str, Any]]:
        if not self.api_keys:
            raise ValueError("No GEMINI_API_KEY configured")

        prompt = (
            f"You are a strict tab/web page categorization engine.\n"
            f"Allowed taxonomy: {json.dumps(taxonomy)}\n\n"
            f"Classify each of the following pages into EXACTLY ONE topic from the allowed taxonomy. "
            f"If none fit well, use 'other'.\n\n"
            f"Pages to classify:\n{json.dumps(items, ensure_ascii=False, indent=2)}\n\n"
            f"Respond ONLY with a valid JSON array of objects with keys 'id' and 'topic', e.g.:\n"
            f'[{{\"id\": 1, \"topic\": \"Artificial Intelligence\"}}]'
        )

        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"
            }
        }

        last_err = None
        for key in self.api_keys:
            for model in self.models:
                url = f"{self.base_url}/{model}:generateContent?key={key}"
                try:
                    async with httpx.AsyncClient(timeout=25.0) as client:
                        resp = await client.post(url, json=payload)
                        if resp.status_code == 429:
                            logger.warning(f"Gemini key rate-limited (429) on {model}, trying next key...")
                            continue
                        if resp.status_code >= 400:
                            logger.warning(f"Gemini request failed {resp.status_code}: {resp.text}")
                            continue
                        data = resp.json()
                        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
                        return parse_classification_json(raw_text, items, taxonomy)
                except Exception as e:
                    last_err = e
                    logger.warning(f"Gemini call error on {model}: {e}")

        raise RuntimeError(f"All Gemini API keys and models failed: {last_err}")

    async def generate_response(
        self,
        prompt: str,
        context: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> str:
        if not self.api_keys:
            raise ValueError("No GEMINI_API_KEY configured")

        combined_text = ""
        if system_prompt:
            combined_text += f"{system_prompt}\n\n"
        if context:
            combined_text += f"Context from saved library:\n{context}\n\n"
        combined_text += f"User Question:\n{prompt}"

        payload = {
            "contents": [{"parts": [{"text": combined_text}]}],
            "generationConfig": {"temperature": 0.4}
        }

        last_err = None
        for key in self.api_keys:
            for model in self.models:
                url = f"{self.base_url}/{model}:generateContent?key={key}"
                try:
                    async with httpx.AsyncClient(timeout=30.0) as client:
                        resp = await client.post(url, json=payload)
                        if resp.status_code == 429:
                            continue
                        if resp.status_code >= 400:
                            continue
                        data = resp.json()
                        return data["candidates"][0]["content"]["parts"][0]["text"]
                except Exception as e:
                    last_err = e

        raise RuntimeError(f"All Gemini API keys failed for chat generation: {last_err}")

class OpenRouterProvider(AIProvider):
    """OpenRouter API provider supporting oxalpha, deepseek, gemini, etc."""

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        self.api_key = api_key or settings.OPENROUTER_API_KEY
        self.model = model or settings.OPENROUTER_MODEL or "deepseek/deepseek-v4-flash-0731:free"
        models = [
            self.model,
            "deepseek/deepseek-v4-flash-0731:free",
            "liquid/lfm-2.5-2.6b:free",
            "deepseek/deepseek-chat",
            "google/gemini-2.0-flash-001",
            "openai/gpt-4o-mini"
        ]
        self.fallback_models = list(dict.fromkeys(models))
        self.base_url = "https://openrouter.ai/api/v1/chat/completions"

    async def classify_batch(
        self,
        items: List[Dict[str, Any]],
        taxonomy: List[str]
    ) -> List[Dict[str, Any]]:
        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY is not configured")

        system_msg = (
            f"You are a strict tab classification model.\n"
            f"Allowed taxonomy: {json.dumps(taxonomy)}.\n"
            f"Classify each input page into EXACTLY ONE topic from the allowed taxonomy.\n"
            f"If none fit well, use 'other'.\n"
            f"Respond ONLY with a JSON array of objects with keys 'id' and 'topic', e.g.:\n"
            f'[{{"id": 1, "topic": "Artificial Intelligence"}}]'
        )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": "https://localhost:8742",
            "X-Title": "Karl X Tab Organizer",
            "Content-Type": "application/json"
        }

        last_err = None
        for model_name in self.fallback_models:
            payload = {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": json.dumps(items, ensure_ascii=False)}
                ],
                "temperature": 0.1
            }
            try:
                async with httpx.AsyncClient(timeout=25.0) as client:
                    resp = await client.post(self.base_url, json=payload, headers=headers)
                    if resp.status_code == 429:
                        logger.warning(f"OpenRouter rate limit on {model_name}, trying next fallback...")
                        continue
                    if resp.status_code >= 400:
                        logger.warning(f"OpenRouter error {resp.status_code} on {model_name}: {resp.text}")
                        continue
                    data = resp.json()
                    raw_text = data["choices"][0]["message"]["content"]
                    return parse_classification_json(raw_text, items, taxonomy)
            except Exception as e:
                last_err = e
                logger.warning(f"OpenRouter call failed on {model_name}: {e}")

        raise RuntimeError(f"All OpenRouter models failed: {last_err}")

    async def generate_response(
        self,
        prompt: str,
        context: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> str:
        if not self.api_key:
            raise ValueError("OPENROUTER_API_KEY is not configured")

        messages = []
        sys = system_prompt or "You are Karl, a helpful personal knowledge assistant for the user's saved tabs."
        if context:
            sys += f"\n\nContext from library:\n{context}"
        messages.append({"role": "system", "content": sys})
        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": "https://localhost:8742",
            "X-Title": "Karl X Tab Organizer",
            "Content-Type": "application/json"
        }

        last_err = None
        for model_name in self.fallback_models[:1]:
            payload = {
                "model": model_name,
                "messages": messages,
                "temperature": 0.4
            }
            try:
                async with httpx.AsyncClient(timeout=12.0) as client:
                    resp = await client.post(self.base_url, json=payload, headers=headers)
                    if resp.status_code == 429:
                        continue
                    if resp.status_code >= 400:
                        logger.warning(f"OpenRouter error {resp.status_code} on {model_name}: {resp.text}")
                        continue
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
            except Exception as e:
                last_err = e

        raise RuntimeError(f"OpenRouter generation timed out or failed ({last_err})")


class GroqProvider(AIProvider):
    """Free-tier Groq API provider."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.GROQ_API_KEY
        self.model = "llama-3.1-8b-instant"
        self.base_url = "https://api.groq.com/openai/v1/chat/completions"

    async def classify_batch(
        self,
        items: List[Dict[str, Any]],
        taxonomy: List[str]
    ) -> List[Dict[str, Any]]:
        if not self.api_key:
            raise ValueError("GROQ_API_KEY is not configured")

        system_msg = (
            f"You are a strict tab classification model. "
            f"Allowed taxonomy: {json.dumps(taxonomy)}. "
            f"Classify each input page into EXACTLY ONE topic from the allowed taxonomy. "
            f"If none fit, use 'other'. Respond ONLY with JSON array of {{\"id\": ..., \"topic\": \"...\"}}."
        )

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": json.dumps(items, ensure_ascii=False)}
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"}
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self.base_url, json=payload, headers=headers)
            if resp.status_code == 429:
                raise RuntimeError("Groq API rate limit exceeded (HTTP 429)")
            resp.raise_for_status()

            data = resp.json()
            raw_text = data["choices"][0]["message"]["content"]
            return parse_classification_json(raw_text, items, taxonomy)

    async def generate_response(
        self,
        prompt: str,
        context: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> str:
        if not self.api_key:
            raise ValueError("GROQ_API_KEY is not configured")

        messages = []
        sys = system_prompt or "You are Karl, a helpful personal knowledge assistant."
        if context:
            sys += f"\n\nContext from library:\n{context}"
        messages.append({"role": "system", "content": sys})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.5
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self.base_url, json=payload, headers=headers)
            if resp.status_code == 429:
                raise RuntimeError("Groq API rate limit exceeded (HTTP 429)")
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]


class OllamaProvider(AIProvider):
    """Local Ollama instance provider (zero external API dependency)."""

    def __init__(self, base_url: Optional[str] = None, model: str = "llama3:latest"):
        self.base_url = (base_url or settings.OLLAMA_BASE_URL).rstrip("/")
        self.model = model

    async def classify_batch(
        self,
        items: List[Dict[str, Any]],
        taxonomy: List[str]
    ) -> List[Dict[str, Any]]:
        prompt = (
            f"You are a strict tab classification system.\n"
            f"Allowed taxonomy: {json.dumps(taxonomy)}\n\n"
            f"Classify each of the following pages into EXACTLY ONE topic from the allowed taxonomy. "
            f"If none fit, use 'other'. Respond ONLY with JSON array of objects with 'id' and 'topic'.\n\n"
            f"Pages:\n{json.dumps(items, ensure_ascii=False)}\n\nJSON Output:"
        )

        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "format": "json"
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{self.base_url}/api/generate", json=payload)
            resp.raise_for_status()
            data = resp.json()
            raw_text = data.get("response", "[]")
            return parse_classification_json(raw_text, items, taxonomy)

    async def generate_response(
        self,
        prompt: str,
        context: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> str:
        full_prompt = ""
        if system_prompt:
            full_prompt += f"System: {system_prompt}\n\n"
        if context:
            full_prompt += f"Context:\n{context}\n\n"
        full_prompt += f"User: {prompt}\nAssistant:"

        payload = {
            "model": self.model,
            "prompt": full_prompt,
            "stream": False
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{self.base_url}/api/generate", json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "")


def parse_classification_json(
    raw_text: str,
    items: List[Dict[str, Any]],
    taxonomy: List[str]
) -> List[Dict[str, Any]]:
    """
    Robust JSON parser for LLM outputs.
    Handles extra markdown wrappers, root object vs list, missing items, and taxonomy normalization.
    """
    raw_text = raw_text.strip()
    if raw_text.startswith("```json"):
        raw_text = raw_text[7:]
    elif raw_text.startswith("```"):
        raw_text = raw_text[3:]
    if raw_text.endswith("```"):
        raw_text = raw_text[:-3]
    raw_text = raw_text.strip()

    valid_taxonomy_map = {}
    for t in taxonomy:
        t_clean = t.strip()
        valid_taxonomy_map[t_clean.lower()] = t_clean
        valid_taxonomy_map[t_clean.lower().replace(" ", "_")] = t_clean
        valid_taxonomy_map[t_clean.lower().replace(" & ", "_").replace("&", "_").replace(" ", "_")] = t_clean

    aliases = {
        "ai": "Artificial Intelligence",
        "ai_ml": "Artificial Intelligence",
        "ml": "Artificial Intelligence",
        "llm": "Artificial Intelligence",
        "machine learning": "Artificial Intelligence",
        "deep learning": "Artificial Intelligence",
        "coding": "Programming",
        "dev": "Programming",
        "software": "Programming",
        "ui": "Design & UI/UX",
        "ux": "Design & UI/UX",
        "design": "Design & UI/UX",
        "ui/ux": "Design & UI/UX",
        "science": "Academics & Science",
        "math": "Academics & Science",
        "academic": "Academics & Science",
        "academics": "Academics & Science",
        "business": "Finance & Business",
        "finance": "Finance & Business",
        "tech": "Hardware & Tech",
        "technology": "Hardware & Tech",
        "hardware": "Hardware & Tech",
        "cars": "Automotive & Cars",
        "car": "Automotive & Cars",
        "automotive": "Automotive & Cars",
        "video": "Entertainment & Video",
        "entertainment": "Entertainment & Video",
        "media": "News & Media",
        "news": "News & Media",
        "music": "Music & Audio",
        "audio": "Music & Audio",
        "productivity": "Productivity & Tools",
        "tools": "Productivity & Tools",
        "gaming": "Gaming",
        "game": "Gaming",
        "social": "Social Media & Community",
        "community": "Social Media & Community"
    }
    for alias, target in aliases.items():
        if target in taxonomy and alias not in valid_taxonomy_map:
            valid_taxonomy_map[alias] = target

    try:
        parsed = json.loads(raw_text)
        results = []

        if isinstance(parsed, dict):
            for k in ["classifications", "items", "results", "pages", "data"]:
                if k in parsed and isinstance(parsed[k], list):
                    parsed = parsed[k]
                    break
            else:
                parsed = [parsed]

        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and "id" in item and "topic" in item:
                    topic = str(item["topic"]).strip()
                    matched_topic = valid_taxonomy_map.get(topic.lower(), topic)
                    if matched_topic.lower() not in valid_taxonomy_map:
                        matched_topic = "other"
                    results.append({
                        "id": int(item["id"]),
                        "topic": matched_topic
                    })

        # Fill in any missing items with 'other'
        returned_ids = {r["id"] for r in results}
        for orig in items:
            if orig["id"] not in returned_ids:
                results.append({"id": orig["id"], "topic": "other"})

        return results

    except Exception as e:
        logger.warning(f"Failed to parse LLM classification JSON ({e}). Raw response: {raw_text[:200]}")
        return [{"id": item["id"], "topic": "other"} for item in items]


class FallbackAIProvider(AIProvider):
    """
    Chains multiple providers in sequence (e.g. OpenRouter -> Gemini).
    If the primary provider fails, rate limits, or times out, the next provider takes over seamlessly.
    """

    def __init__(self, providers: List[AIProvider]):
        self.providers = providers

    async def classify_batch(
        self,
        items: List[Dict[str, Any]],
        taxonomy: List[str]
    ) -> List[Dict[str, Any]]:
        last_err = None
        for p in self.providers:
            try:
                return await p.classify_batch(items, taxonomy)
            except Exception as e:
                last_err = e
                logger.warning(f"Batch classification failed on {type(p).__name__}: {e}. Trying fallback...")
        raise RuntimeError(f"All providers in FallbackAIProvider failed classify_batch: {last_err}")

    async def generate_response(
        self,
        prompt: str,
        context: Optional[str] = None,
        system_prompt: Optional[str] = None
    ) -> str:
        last_err = None
        for p in self.providers:
            try:
                return await p.generate_response(prompt, context=context, system_prompt=system_prompt)
            except Exception as e:
                last_err = e
                logger.warning(f"Generation failed on {type(p).__name__}: {e}. Trying fallback...")
        raise RuntimeError(f"All providers in FallbackAIProvider failed generate_response: {last_err}")


async def get_ai_provider() -> AIProvider:
    """Factory returning configured providers wrapped in an automatic fallback chain."""
    providers: List[AIProvider] = []
    primary = (settings.AI_PROVIDER or "openrouter").lower()

    if primary == "gemini" and settings.GEMINI_API_KEY:
        providers.append(GeminiProvider())
    elif primary == "openrouter" and settings.OPENROUTER_API_KEY:
        providers.append(OpenRouterProvider())
    elif primary == "groq" and settings.GROQ_API_KEY:
        providers.append(GroqProvider())

    # Add available fallbacks
    if settings.OPENROUTER_API_KEY and not any(isinstance(p, OpenRouterProvider) for p in providers):
        providers.append(OpenRouterProvider())
    if settings.GEMINI_API_KEY and not any(isinstance(p, GeminiProvider) for p in providers):
        providers.append(GeminiProvider())
    if settings.GROQ_API_KEY and not any(isinstance(p, GroqProvider) for p in providers):
        providers.append(GroqProvider())

    if not providers:
        providers.append(OllamaProvider())

    if len(providers) == 1:
        return providers[0]
    return FallbackAIProvider(providers)

