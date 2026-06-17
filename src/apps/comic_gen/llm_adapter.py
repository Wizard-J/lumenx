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
from urllib.parse import urlparse

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


def _is_local_base_url(base_url: str) -> bool:
    parsed = urlparse(base_url)
    return parsed.hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _normalize_openai_base_url(base_url: str) -> str:
    """Normalize OpenAI-compatible base URLs.

    Ollama's native endpoint is commonly configured as http://localhost:11434,
    while OpenAI SDK calls need http://localhost:11434/v1. Keep cloud/proxy
    URLs unchanged and only auto-append /v1 for bare local endpoints.
    """
    raw = base_url.rstrip("/")
    parsed = urlparse(raw)
    if _is_local_base_url(raw) and parsed.path in ("", "/"):
        return raw + "/v1"
    return raw


class LLMAdapter:
    """Unified LLM call interface supporting DashScope and OpenAI-compatible APIs."""

    def __init__(self):
        self.provider = _get_llm_setting("LLM_PROVIDER", default="dashscope").lower()
        self._client = None
        logger.info(f"LLM Adapter initialized with provider: {self.provider}")

    @property
    def is_configured(self) -> bool:
        if self.provider == "openai":
            api_key = _get_llm_setting("LLM_API_KEY", "OPENAI_API_KEY")
            base_url = _get_llm_setting(
                "LLM_BASE_URL", "OPENAI_BASE_URL",
                default="https://api.openai.com/v1",
            )
            return bool(api_key) or _is_local_base_url(base_url)
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
                normalized_base_url = _normalize_openai_base_url(base_url)
                if not api_key and _is_local_base_url(normalized_base_url):
                    api_key = "ollama"
                self._client = OpenAI(
                    api_key=api_key,
                    base_url=normalized_base_url,
                )
            else:
                # DashScope – support optional LLM_BASE_URL override for proxy
                base_url = _get_llm_setting(
                    "LLM_BASE_URL",
                    default=f"{get_provider_base_url('DASHSCOPE')}/compatible-mode/v1",
                )
                self._client = OpenAI(
                    api_key=os.getenv("DASHSCOPE_API_KEY"),
                    base_url=_normalize_openai_base_url(base_url),
                )
        return self._client

    # DashScope qwen 系列：首选 qwen3.6-plus（最新稳定），不可用时回退到 qwen-plus
    # alias（始终指向最新稳定通用版）。这里维护 fallback chain 而不是硬写一个名字，
    # 避免 DashScope 新版本上下线时整条 LLM 链断掉。
    _DASHSCOPE_MODEL_FALLBACK_CHAIN = ["qwen3.6-plus", "qwen-plus"]

    def _get_default_model(self) -> str:
        if self.provider == "openai":
            return _get_llm_setting("LLM_MODEL", "OPENAI_MODEL", default="gpt-4o")
        return self._DASHSCOPE_MODEL_FALLBACK_CHAIN[0]

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

        # 显式 model override 路径：单次尝试，失败就抛。
        if model:
            return self._chat_once(client, model, messages, response_format)

        # Provider 默认路径：DashScope 走 fallback chain，OpenAI 单次尝试。
        if self.provider == "openai":
            return self._chat_once(client, self._get_default_model(), messages, response_format)

        last_err: Optional[Exception] = None
        for idx, candidate in enumerate(self._DASHSCOPE_MODEL_FALLBACK_CHAIN):
            try:
                return self._chat_once(client, candidate, messages, response_format)
            except RuntimeError as e:
                # 仅在 "模型不存在 / 不可用" 类错误时回退；其他错误（鉴权、限流、网络）
                # 直接抛，不浪费第二次重试。判定关键字宽松匹配 DashScope 文案。
                msg = str(e).lower()
                is_model_unavailable = any(k in msg for k in (
                    "model not found", "invalidmodel", "model_not_found",
                    "no such model", "not supported", "modelnotfound", "404",
                    "does not exist",
                ))
                last_err = e
                if is_model_unavailable and idx < len(self._DASHSCOPE_MODEL_FALLBACK_CHAIN) - 1:
                    next_candidate = self._DASHSCOPE_MODEL_FALLBACK_CHAIN[idx + 1]
                    logger.warning(
                        "DashScope model %s unavailable (%s); falling back to %s",
                        candidate, e, next_candidate,
                    )
                    continue
                raise
        # 理论上不可达（最后一次失败已 raise），保留兜底
        raise last_err if last_err else RuntimeError("DashScope: no models available")

    def _chat_once(
        self,
        client,
        model: str,
        messages: List[Dict[str, str]],
        response_format: Optional[Dict[str, str]],
    ) -> str:
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
