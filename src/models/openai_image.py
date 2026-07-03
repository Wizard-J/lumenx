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
import os as _os
from io import BytesIO
from typing import Any, BinaryIO, Tuple, Optional, List
from http import HTTPStatus
from urllib.parse import urlparse

from .image import ImageGenModel  # type: ignore[attr-defined]
from ..utils import get_logger
from ..utils.op_logger import enter_operation, update_operation

logger = get_logger(__name__)


_GPT_IMAGE_2_MIN_PIXELS = 655_360
_GPT_IMAGE_2_MAX_DIMENSION = 3840
_GPT_IMAGE_2_RECOMMENDED_SIZES = {
    "1024x576": "2048x1152",
    "576x1024": "1152x2048",
}


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

    def supports_reference_images(self) -> bool:
        """Report I2I capability so StoryboardGenerator passes ref_image_paths."""
        return True

    def _encode_image_to_b64_json(self, image_path: str) -> str:
        """Encode a local image to base64 data URL."""
        with open(image_path, "rb") as f:
            img_bytes = f.read()
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        return f"data:{mime};base64,{b64}"

    def _uses_standard_image_edit(self, model: str, has_refs: bool) -> bool:
        """Use the official Images Edit path for GPT Image models with references."""
        if not has_refs:
            return False
        normalized = (model or "").lower()
        return normalized.startswith("gpt-image-")

    def _normalize_size_for_model(self, model: str, size: str) -> str:
        normalized_model = (model or "").lower()
        normalized_size = (size or "").replace("*", "x")
        if not normalized_model.startswith("gpt-image-2"):
            return normalized_size
        if normalized_size in _GPT_IMAGE_2_RECOMMENDED_SIZES:
            return _GPT_IMAGE_2_RECOMMENDED_SIZES[normalized_size]
        try:
            width_str, height_str = normalized_size.lower().split("x", 1)
            width = int(width_str)
            height = int(height_str)
        except Exception:
            return normalized_size

        if width <= 0 or height <= 0:
            return normalized_size
        if width % 16 == 0 and height % 16 == 0 and width * height >= _GPT_IMAGE_2_MIN_PIXELS:
            return normalized_size

        aspect = width / height
        next_width = width
        next_height = height
        while (
            next_width % 16 != 0
            or next_height % 16 != 0
            or next_width * next_height < _GPT_IMAGE_2_MIN_PIXELS
        ):
            next_width += 16
            next_height = max(16, round((next_width / aspect) / 16) * 16)
            if next_width > _GPT_IMAGE_2_MAX_DIMENSION or next_height > _GPT_IMAGE_2_MAX_DIMENSION:
                return normalized_size
        return f"{next_width}x{next_height}"

    def _resolve_reference_images_for_extra_body(self, refs: List[str]) -> List[str]:
        """Resolve refs to URLs/data URIs for OpenAI-compatible extension providers."""
        resolved_images: List[str] = []
        for p in refs:
            if isinstance(p, str) and p.startswith("data:"):
                resolved_images.append(p)
            elif isinstance(p, str) and (p.startswith("http://") or p.startswith("https://")):
                resolved_images.append(p)
            elif isinstance(p, str) and _os.path.exists(p):
                try:
                    resolved_images.append(self._encode_image_to_b64_json(p))
                except Exception as _e:
                    logger.warning(f"Cannot encode ref image {p}: {_e}")
            elif isinstance(p, str):
                alt = _os.path.join("output", p)
                if _os.path.exists(alt):
                    try:
                        resolved_images.append(self._encode_image_to_b64_json(alt))
                    except Exception as _e:
                        logger.warning(f"Cannot encode ref image {alt}: {_e}")
                else:
                    logger.warning(f"Ref image path not found: {p}")
        return resolved_images

    def _open_reference_image(self, ref: str) -> Optional[BinaryIO]:
        """Open a ref as a binary file-like object for the official Images Edit API."""
        if not isinstance(ref, str) or not ref:
            return None

        try:
            if ref.startswith("data:"):
                _, payload = ref.split(",", 1)
                return BytesIO(base64.b64decode(payload))

            if ref.startswith("http://") or ref.startswith("https://"):
                import requests

                resp = requests.get(ref, timeout=60)
                resp.raise_for_status()
                bio = BytesIO(resp.content)
                parsed = urlparse(ref)
                bio.name = _os.path.basename(parsed.path) or "reference.png"  # type: ignore[attr-defined]
                return bio

            local_path = ref if _os.path.exists(ref) else _os.path.join("output", ref)
            if _os.path.exists(local_path):
                return open(local_path, "rb")

            try:
                from ..utils.oss_utils import (
                    OSSImageUploader,
                    is_object_key,
                    object_key_to_local_display_path,
                )

                if is_object_key(ref):
                    local_display_path = object_key_to_local_display_path(ref)
                    if local_display_path:
                        candidate = _os.path.join("output", local_display_path)
                        if _os.path.exists(candidate):
                            return open(candidate, "rb")

                    uploader = OSSImageUploader()
                    if getattr(uploader, "is_configured", False):
                        signed_url = uploader.sign_url_for_api(ref)
                        if signed_url:
                            import requests

                            resp = requests.get(signed_url, timeout=60)
                            resp.raise_for_status()
                            bio = BytesIO(resp.content)
                            bio.name = _os.path.basename(ref) or "reference.png"  # type: ignore[attr-defined]
                            return bio
            except Exception as exc:
                logger.warning(f"Cannot resolve OSS ref image for edit API {ref}: {exc}")
        except Exception as exc:
            logger.warning(f"Cannot open ref image for edit API {ref}: {exc}")
        return None

    def _decode_and_save_b64_image(self, image_b64: str, output_path: str) -> None:
        raw = image_b64.split(",", 1)[1] if image_b64.startswith("data:") else image_b64
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(base64.b64decode(raw))

    def _extract_image_payload(self, response: Any) -> str:
        if not getattr(response, "data", None):
            return ""
        first = response.data[0]
        return getattr(first, "url", "") or getattr(first, "b64_json", "") or ""

    def _should_retry_edit_with_http(self) -> bool:
        hostname = (urlparse(self.base_url).hostname or "").lower()
        return hostname not in {"api.openai.com", "platform.openai.com"}

    def _images_edit_http(
        self,
        *,
        model: str,
        prompt: str,
        images: List[BinaryIO],
        size: str,
        n: int,
    ) -> Any:
        """Fallback for OpenAI-compatible gateways that differ in SDK multipart parsing."""
        import requests

        files = []
        for index, image in enumerate(images):
            try:
                image.seek(0)
            except Exception:
                pass
            filename = getattr(image, "name", None) or f"reference-{index + 1}.png"
            mime_type = mimetypes.guess_type(str(filename))[0] or "image/png"
            files.append(("image", (_os.path.basename(str(filename)), image, mime_type)))

        data = {
            "model": model,
            "prompt": prompt,
            "size": size,
            "n": str(n),
        }
        url = f"{self.base_url.rstrip('/')}/images/edits"
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            files=files,
            data=data,
            timeout=180,
        )
        if resp.status_code >= 400:
            detail = resp.text[:1000] if getattr(resp, "text", None) else ""
            raise RuntimeError(
                f"Images Edit HTTP fallback failed: {resp.status_code} {resp.reason}; {detail}"
            )
        payload = resp.json()
        first = (payload.get("data") or [{}])[0]
        return type(
            "ImageEditHTTPResponse",
            (),
            {
                "data": [
                    type(
                        "ImageEditHTTPData",
                        (),
                        {
                            "url": first.get("url", ""),
                            "b64_json": first.get("b64_json", ""),
                        },
                    )()
                ]
            },
        )()

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

        For pure T2I: uses /v1/images/generations.
        For GPT Image models with reference images: uses the official
        /v1/images/edits transport.

        Returns (output_path, duration_seconds).

        For providers that support extra_body.image (e.g. Agnes Image 2.0 Flash),
        reference images are passed as data URIs or HTTP URLs through that field.
        For pure OpenAI-compatible providers that reject extra_body, the images
        are still injected as text anchors in the prompt for consistency.
        """

        # ── Resolve reference images ───────────────────────────────────
        extra_body: dict = {}
        all_refs: List[str] = []
        if ref_image_path:
            all_refs.append(ref_image_path)
        if ref_image_paths:
            all_refs.extend(ref_image_paths)

        if all_refs:
            logger.info(
                f"Reference images detected ({len(all_refs)}), "
                "will use model-appropriate reference transport"
            )
            resolved_images = self._resolve_reference_images_for_extra_body(all_refs)
            # Only inject text anchors when we DON'T have actual images
            # (pure T2I fallback). With I2I, the images speak for themselves.
            if not resolved_images:
                prompt = f"{prompt} (Reference: character design sheet)"

        negative_prompt = kwargs.get("negative_prompt") or self.params.get("negative_prompt")
        if negative_prompt:
            prompt = (
                f"{prompt}\n\n"
                f"Negative prompt: {negative_prompt}. "
                "Do not render any logo, watermark, text, signature, username, social media handle, QR code, or UI overlay."
            )

        # Override wanx-family model names with configured IMAGE_MODEL
        if model_name and model_name.startswith("wan"):
            model_name = None
        model = model_name or self.model_name
        n = kwargs.get("n", self.params.get("n", 1))
        size = kwargs.get("size", self.params.get("size", "1024x1024"))

        # Convert DashScope-style size to OpenAI-style and apply model-specific constraints.
        size = self._normalize_size_for_model(model, size)
        use_standard_edit = self._uses_standard_image_edit(model, bool(all_refs))
        if all_refs and not use_standard_edit:
            resolved_images = self._resolve_reference_images_for_extra_body(all_refs)
            if resolved_images:
                extra_body["image"] = resolved_images

        logger.info(f"OpenAI Image generation: model={model}, size={size}, n={n}")
        logger.info(f"Prompt: {prompt[:200]}")

        op_extra = {
            "ref_count": len(all_refs),
            "resolved_ref_count": len(extra_body.get("image", [])),
            "has_reference": bool(all_refs),
            "request_mode": "edit" if use_standard_edit else ("i2i" if all_refs else "t2i"),
            "reference_transport": "images.edit" if use_standard_edit else "extra_body.image",
            "size": size,
            "n": n,
        }
        if all_refs:
            op_extra["ref_sources"] = [
                ref[:160] if isinstance(ref, str) else str(type(ref))
                for ref in all_refs[:5]
            ]
        logger.info(
            "OpenAI Image request mode=%s ref_count=%s resolved_ref_count=%s",
            op_extra["request_mode"],
            op_extra["ref_count"],
            op_extra["resolved_ref_count"],
        )
        op_id = enter_operation("image", detail=prompt[:200], model=model, **op_extra)
        api_start_time = time.time()

        try:
            client = self._get_client()
            opened_refs: List[BinaryIO] = []
            try:
                if use_standard_edit:
                    opened_refs = [
                        image for image in (self._open_reference_image(ref) for ref in all_refs) if image
                    ]
                    if not opened_refs:
                        raise RuntimeError("No usable reference images for Images Edit API")
                    op_extra["resolved_ref_count"] = len(opened_refs)
                    edit_kwargs: dict = {
                        "model": model,
                        "image": opened_refs if len(opened_refs) > 1 else opened_refs[0],
                        "prompt": prompt,
                        "n": n,
                        "size": size,
                    }
                    try:
                        response = client.images.edit(**edit_kwargs)
                    except Exception:
                        if not self._should_retry_edit_with_http():
                            raise
                        logger.warning(
                            "OpenAI SDK images.edit failed for %s; retrying via raw multipart",
                            self.base_url,
                            exc_info=True,
                        )
                        response = self._images_edit_http(
                            model=model,
                            prompt=prompt,
                            images=opened_refs,
                            size=size,
                            n=n,
                        )
                else:
                    request_kwargs: dict = {
                        "model": model,
                        "prompt": prompt,
                        "n": n,
                        "size": size,
                    }
                    if extra_body:
                        request_kwargs["extra_body"] = extra_body
                    if urlparse(self.base_url).hostname in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
                        request_kwargs["response_format"] = "b64_json"
                    response = client.images.generate(**request_kwargs)
            finally:
                for image in opened_refs:
                    try:
                        image.close()
                    except Exception:
                        pass

            api_duration = time.time() - api_start_time

            image_url = self._extract_image_payload(response)

            if not image_url:
                raise RuntimeError("No image URL or b64_json in response")

            logger.info(f"OpenAI Image generated: {image_url[:100]}")

            update_operation(
                op_id, "success",
                detail=f"Image: {image_url[:100]}",
                duration_ms=api_duration * 1000,
                output_path=output_path[:200],
                **op_extra,
            )

            # Download image
            import requests
            if image_url.startswith("data:"):
                # b64_json data URL — decode and save
                self._decode_and_save_b64_image(image_url, output_path)
            elif image_url.startswith("http://") or image_url.startswith("https://"):
                resp = requests.get(image_url, timeout=60)
                resp.raise_for_status()
                os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(resp.content)
            else:
                # Raw b64_json from local OpenAI-compatible providers such as Ollama.
                self._decode_and_save_b64_image(image_url, output_path)

            return output_path, api_duration

        except Exception as e:
            import traceback
            logger.error(f"OpenAI Image generation failed: {e}")
            logger.error(traceback.format_exc())
            update_operation(
                op_id, "error",
                detail=f"Error: {str(e)[:200]}",
                duration_ms=(time.time() - api_start_time) * 1000,
                **op_extra,
            )
            raise
