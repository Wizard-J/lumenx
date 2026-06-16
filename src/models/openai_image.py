"""
OpenAI-compatible Image Generation Adapter.

Supports any OpenAI-compatible image API endpoint (/v1/images/generations).

Configuration:
  IMAGE_PROVIDER        — "openai" (default "dashscope" falls back to WanxImageModel)
  IMAGE_API_KEY         — API key (falls back to LLM_API_KEY > OPENAI_API_KEY)
  IMAGE_BASE_URL        — Base URL (falls back to LLM_BASE_URL > https://api.openai.com/v1)
  IMAGE_MODEL           — Model name (falls back to LLM_MODEL > dall-e-3)
"""

import os
import time
import base64
import mimetypes
import logging
from typing import Tuple, Optional, List
from http import HTTPStatus
from urllib.parse import urlparse

from .image import ImageGenModel  # type: ignore[attr-defined]
from ..utils import get_logger
from ..utils.op_logger import enter_operation, update_operation

logger = get_logger(__name__)


def _get_setting(*keys: str, default: str = "") -> str:
    """Resolve config by checking env vars in priority order."""
    for key in keys:
        val = os.environ.get(key, "")
        if val:
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            return val
    return default


class OpenAIImageModel(ImageGenModel):
    """OpenAI-compatible image generation model."""

    def __init__(self, config):
        super().__init__(config)
        self.params = config.get("params", {})
        self._client = None

    @property
    def api_key(self) -> str:
        # Priority: IMAGE_API_KEY only (no fallback to LLM)
        key = _get_setting("IMAGE_API_KEY", default="")
        if not key:
            parsed = urlparse(self.base_url)
            if parsed.hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
                return "ollama"
        if not key:
            logger.warning("IMAGE_API_KEY not set, image generation may fail")
        return key

    @property
    def base_url(self) -> str:
        raw = _get_setting("IMAGE_BASE_URL", default="https://api.openai.com/v1").rstrip("/")
        parsed = urlparse(raw)
        if parsed.hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"} and parsed.path in ("", "/"):
            return raw + "/v1"
        return raw

    @property
    def model_name(self) -> str:
        return _get_setting("IMAGE_MODEL", default="dall-e-3")

    def _get_client(self):
        if self._client is None:
            try:
                from openai import OpenAI
            except ImportError:
                raise RuntimeError("openai package not installed. Run: pip install openai>=1.0.0")
            self._client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    def _encode_image_to_b64_json(self, image_path: str) -> str:
        """Encode a local image to base64 data URL."""
        with open(image_path, "rb") as f:
            img_bytes = f.read()
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        return f"data:{mime};base64,{b64}"

    def generate(
        self,
        prompt: str,
        output_path: str,
        ref_image_path: Optional[str] = None,
        ref_image_paths: Optional[List[str]] = None,
        model_name: Optional[str] = None,
        **kwargs,
    ) -> Tuple[str, float]:
        """Generate image via OpenAI-compatible Images API.

        For pure T2I: uses /v1/images/generations
        For I2I (with ref images): falls back to DashScope via WanxImageModel.
        OpenAI's standard Images API doesn't support reference images, so if
        reference images are provided we delegate to the DashScope adapter.

        Returns (output_path, duration_seconds).
        """
        # Collect all reference paths
        all_refs: List[str] = []
        if ref_image_path:
            all_refs.append(ref_image_path)
        if ref_image_paths:
            all_refs.extend(ref_image_paths)

        # Note: Reference images are appended to prompt as descriptive context
        # since OpenAI Images API doesn't support reference image input natively.
        if all_refs:
            logger.info(f"Reference images detected ({len(all_refs)}), will append context to prompt")
            prompt = f"{prompt} (Reference: character design sheet)"

        # Override wanx-family model names with configured IMAGE_MODEL
        if model_name and model_name.startswith("wan"):
            model_name = None
        model = model_name or self.model_name
        n = kwargs.get("n", self.params.get("n", 1))
        size = kwargs.get("size", self.params.get("size", "1024x1024"))

        # Convert DashScope-style size to OpenAI-style
        if "*" in size:
            size = size.replace("*", "x")

        logger.info(f"OpenAI Image generation: model={model}, size={size}, n={n}")
        logger.info(f"Prompt: {prompt[:200]}")

        op_id = enter_operation("image", detail=prompt[:200], model=model)
        api_start_time = time.time()

        try:
            client = self._get_client()
            request_kwargs = {
                "model": model,
                "prompt": prompt,
                "n": n,
                "size": size,
            }
            if urlparse(self.base_url).hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
                request_kwargs["response_format"] = "b64_json"
            response = client.images.generate(**request_kwargs)

            api_duration = time.time() - api_start_time

            image_url = response.data[0].url if response.data else ""
            if not image_url:
                # Try b64_json
                image_url = response.data[0].b64_json if response.data else ""

            if not image_url:
                raise RuntimeError("No image URL or b64_json in response")

            logger.info(f"OpenAI Image generated: {image_url[:100]}")

            update_operation(
                op_id, "success",
                detail=f"Image: {image_url[:100]}",
                duration_ms=api_duration * 1000,
                output_path=output_path[:200],
            )

            # Download image
            import requests
            if image_url.startswith("data:"):
                # b64_json data URL — decode and save
                _, b64_data = image_url.split(",", 1)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(b64_data))
            elif image_url.startswith("http://") or image_url.startswith("https://"):
                resp = requests.get(image_url, timeout=60)
                resp.raise_for_status()
                os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(resp.content)
            else:
                # Raw b64_json from local OpenAI-compatible providers such as Ollama.
                os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(image_url))

            return output_path, api_duration

        except Exception as e:
            import traceback
            logger.error(f"OpenAI Image generation failed: {e}")
            logger.error(traceback.format_exc())
            update_operation(
                op_id, "error",
                detail=f"Error: {str(e)[:200]}",
                duration_ms=(time.time() - api_start_time) * 1000,
            )
            raise
