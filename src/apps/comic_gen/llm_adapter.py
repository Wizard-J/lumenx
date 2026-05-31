"""
LLM Adapter - Unified interface for DashScope and OpenAI-compatible APIs.

Supports two providers:
  - dashscope (default): Alibaba Cloud DashScope via OpenAI-compatible endpoint
  - openai: Any OpenAI-compatible API (OpenAI, DeepSeek, Ollama, etc.)

Configuration priority (highest first):
  LLM_* keys   — unified path set via the Settings UI (LLM_API_KEY, LLM_BASE_URL, LLM_MODEL)
  OPENAI_*     — legacy .env direct keys, kept for backward compat
  Built-in defaults

Environment variables read:
  LLM_PROVIDER / OPENAI_PROVIDER → "dashscope" or "openai"
  LLM_API_KEY  / OPENAI_API_KEY  → API key for the OpenAI‑compatible endpoint
  LLM_BASE_URL / OPENAI_BASE_URL → base URL override (DashScope or proxy)
  LLM_MODEL    / OPENAI_MODEL    → default model name
  DASHSCOPE_API_KEY              → always used for dashscope provider
"""
import os
import time
import logging
from typing import Dict, List, Optional, Any

from ...utils.endpoints import get_provider_base_url
from ...utils.op_logger import enter_operation, update_operation

logger = logging.getLogger(__name__)


# ── Configuration key mapping ─────────────────────────────────────────
# Priority order for each setting:
#   1. LLM_* keys (set via UI config) — unified OpenAI‑compatible path
#   2. OPENAI_* keys (legacy .env direct) — kept for backward compat
#   3. Built‑in defaults


def _strip_quotes(val: str) -> str:
    """Strip surrounding single/double quotes, handling dotenv quoting."""
    if len(val) >= 2:
        if (val[0] == val[-1]) and val[0] in ('"', "'"):
            return val[1:-1]
    return val


def _get_llm_setting(*keys: str, default: str = "") -> str:
    """Resolve a config value by checking env vars in priority order.

    Uses os.getenv so that os.environ updates from /config/env
    are visible immediately.  Strips dotenv quoting automatically.
    """
    for key in keys:
        val = os.getenv(key, "")
        if val:
            return _strip_quotes(val)
    return default


class LLMAdapter:
    """Unified LLM call interface supporting DashScope and OpenAI-compatible APIs."""

    def __init__(self):
        self.provider = _get_llm_setting("LLM_PROVIDER", default="dashscope").lower()
        self._client = None
        logger.info(f"LLM Adapter initialized with provider: {self.provider}")

    @property
    def is_configured(self) -> bool:
        if self.provider == "openai":
            return bool(_get_llm_setting("LLM_API_KEY", "OPENAI_API_KEY"))
        return bool(os.getenv("DASHSCOPE_API_KEY"))

    def _get_client(self):
        """Get or create the OpenAI-compatible client (lazy, cached)."""
        if self._client is None:
            try:
                from openai import OpenAI
            except ImportError:
                raise RuntimeError(
                    "openai package not installed. Run: pip install openai>=1.0.0"
                )

            if self.provider == "openai":
                api_key = _get_llm_setting("LLM_API_KEY", "OPENAI_API_KEY")
                base_url = _get_llm_setting(
                    "LLM_BASE_URL", "OPENAI_BASE_URL",
                    default="https://api.openai.com/v1",
                )
                self._client = OpenAI(
                    api_key=api_key,
                    base_url=base_url,
                )
            else:
                # DashScope – support optional LLM_BASE_URL override for proxy
                base_url = _get_llm_setting(
                    "LLM_BASE_URL",
                    default=f"{get_provider_base_url('DASHSCOPE')}/compatible-mode/v1",
                )
                self._client = OpenAI(
                    api_key=os.getenv("DASHSCOPE_API_KEY"),
                    base_url=base_url,
                )
        return self._client

    def _get_default_model(self) -> str:
        if self.provider == "openai":
            return _get_llm_setting("LLM_MODEL", "OPENAI_MODEL", default="gpt-4o")
        return "qwen3.5-plus"

    def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        response_format: Optional[Dict[str, str]] = None,
    ) -> str:
        """
        Send a chat completion request and return the response content.
        """
        client = self._get_client()
        model = model or self._get_default_model()

        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if response_format:
            kwargs["response_format"] = response_format

        # Extract last user message as preview
        user_msg = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                user_msg = m.get("content", "")[:200]
                break

        t0 = time.time()
        entry_id = enter_operation("llm_call",
                                 detail=user_msg, model=model,
                                 extra={"provider": self.provider})

        try:
            response = client.chat.completions.create(**kwargs)
            elapsed = (time.time() - t0) * 1000
            content_preview = (response.choices[0].message.content or "")[:200]
            update_operation(entry_id, "success",
                                detail=content_preview,
                                duration_ms=elapsed,
                                extra={"provider": self.provider,
                                       "tokens": response.usage.total_tokens if response.usage else None})
            return response.choices[0].message.content
        except Exception as e:
            elapsed = (time.time() - t0) * 1000
            provider_label = "LLM" if self.provider == "openai" else "DashScope"
            update_operation(entry_id, "error",
                                detail=str(e)[:300],
                                duration_ms=elapsed,
                                extra={"provider": self.provider})
            raise RuntimeError(f"{provider_label} API error: {e}") from e
