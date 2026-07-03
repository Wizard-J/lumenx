"""
Seedance 2.0 video generation adapter.

Default provider is Volcengine ModelArk. Set SEEDANCE_PROVIDER=modelverse to use
the Compshare/ModelVerse task API instead. Image inputs are role-tagged:
  - first_frame: exact starting keyframe
  - last_frame: exact ending keyframe
  - reference_image: identity/style/layout reference
"""

import base64
import mimetypes
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

from .base import VideoGenModel
from ..utils import get_logger
from ..utils.op_logger import enter_operation, update_operation
from ..utils.oss_utils import OSSImageUploader, is_object_key

try:
    from volcenginesdkarkruntime import Ark
except ImportError:  # pragma: no cover - tested via monkeypatching the module attr
    Ark = None

logger = get_logger(__name__)


_MODEL_ID_MAP = {
    "seedance-2.0-i2v": "dreamina-seedance-2-0-260128",
    "seedance-2.0-r2v": "dreamina-seedance-2-0-260128",
    "seedance-2.0-t2v": "dreamina-seedance-2-0-260128",
    "seedance-2.0-mini-i2v": "dreamina-seedance-2-0-lite-260128",
    "seedance-2.0-mini-r2v": "dreamina-seedance-2-0-lite-260128",
}

_MODELVERSE_MODEL_ID_MAP = {
    "seedance-2.0-i2v": "doubao-seedance-2-0-260128",
    "seedance-2.0-r2v": "doubao-seedance-2-0-260128",
    "seedance-2.0-t2v": "doubao-seedance-2-0-260128",
}


def _env(key: str, default: str = "") -> str:
    value = os.environ.get(key, default)
    if value and len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def _response_error_detail(response: requests.Response) -> str:
    try:
        return str(response.json())[:1000]
    except Exception:
        return (getattr(response, "text", "") or getattr(response, "reason", "") or "Unknown")[:1000]


def _summarize_media_value(value: Any) -> Any:
    if isinstance(value, str):
        if value.startswith("data:") and ";base64," in value:
            prefix, payload = value.split(",", 1)
            return {
                "kind": "data_uri",
                "prefix": prefix,
                "payload_chars": len(payload),
            }
        if len(value) > 4000:
            return {
                "kind": "truncated_text",
                "preview": value[:512],
                "chars": len(value),
            }
        return value
    if isinstance(value, list):
        return [_summarize_media_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _summarize_media_value(v) for k, v in value.items()}
    return value


def _safe_json_payload(payload: Any) -> Any:
    try:
        return _summarize_media_value(payload)
    except Exception:
        return str(payload)[:1000]


class SeedanceVideoModel(VideoGenModel):
    """Seedance 2.0 adapter with first/last/reference image role support."""

    def __init__(self, config: dict):
        super().__init__(config)
        params = (config or {}).get("params", {}) if isinstance(config, dict) else {}
        self.provider = (_env("SEEDANCE_PROVIDER", "ark") or "ark").strip().lower()
        if self.provider not in ("ark", "modelverse"):
            logger.warning("Unsupported SEEDANCE_PROVIDER=%s; falling back to ark", self.provider)
            self.provider = "ark"
        self.api_key = _env("ARK_API_KEY") or _env("SEEDANCE_API_KEY")
        self.base_url = _env("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
        self.model_name = params.get("model_name") or _env(
            "SEEDANCE_MODEL", "dreamina-seedance-2-0-260128"
        )
        self.modelverse_api_key = _env("SEEDANCE_API_KEY") or _env("MODELVERSE_API_KEY")
        self.modelverse_base_url = _env("SEEDANCE_BASE_URL", "https://api.modelverse.cn")
        self.modelverse_model_name = _env("SEEDANCE_MODEL", "doubao-seedance-2-0-260128")
        self.poll_interval = int(_env("SEEDANCE_POLL_INTERVAL", "5") or "5")
        self.max_wait = int(_env("SEEDANCE_MAX_WAIT", "1800") or "1800")
        self.local_serve_base_url = _env("LOCAL_SERVE_BASE_URL", "").rstrip("/")

        if self.provider == "modelverse":
            if not self.modelverse_api_key:
                logger.warning("SEEDANCE_API_KEY/MODELVERSE_API_KEY not set; ModelVerse generation may fail")
            self.client = None
            return

        if not self.api_key:
            logger.warning("ARK_API_KEY/SEEDANCE_API_KEY not set; Seedance generation may fail")
        if Ark is None:
            self.client = None
            logger.error("volcenginesdkarkruntime is not installed; Seedance generation unavailable")
        else:
            self.client = Ark(base_url=self.base_url, api_key=self.api_key)

    def _api_model_id(self, model: Optional[str]) -> str:
        if self.provider == "modelverse":
            if model and model in _MODELVERSE_MODEL_ID_MAP:
                return _MODELVERSE_MODEL_ID_MAP[model]
            if model and model.startswith("doubao-seedance-"):
                return model
            return self.modelverse_model_name
        if model and model in _MODEL_ID_MAP:
            return _MODEL_ID_MAP[model]
        if model and model.startswith("dreamina-seedance-"):
            return model
        return self.model_name

    def _encode_local_image(self, path: str) -> str:
        with open(path, "rb") as image_file:
            payload = base64.b64encode(image_file.read()).decode("utf-8")
        mime = mimetypes.guess_type(path)[0] or "image/png"
        return f"data:{mime};base64,{payload}"

    def _sign_or_upload_local_image(self, local_path: str) -> Optional[str]:
        if not local_path or not os.path.exists(local_path):
            return None
        try:
            uploader = OSSImageUploader()
            if not uploader.is_configured:
                return None
            object_key = uploader.upload_file(local_path, sub_path="temp/seedance_video")
            return uploader.sign_url_for_api(object_key) if object_key else None
        except Exception as exc:
            logger.warning("[Seedance] Failed to upload/sign local image %s: %s", local_path, exc)
            return None

    def _resolve_to_local_url(self, local_path: str) -> Optional[str]:
        if not self.local_serve_base_url or not local_path or not os.path.exists(local_path):
            return None
        abs_path = os.path.abspath(local_path)
        cwd = os.getcwd()
        try:
            rel_path = os.path.relpath(abs_path, cwd)
        except ValueError:
            return None
        if rel_path.startswith(".."):
            return None
        return f"{self.local_serve_base_url}/local-file/{rel_path}"

    def _resolve_local_image_input(self, local_path: str) -> Optional[str]:
        signed = self._sign_or_upload_local_image(local_path)
        if signed:
            return signed
        local_url = self._resolve_to_local_url(local_path)
        if local_url:
            return local_url
        return self._encode_local_image(local_path) if os.path.exists(local_path) else None

    def _resolve_local_path_candidate(self, value: str) -> Optional[str]:
        if os.path.exists(value):
            return value
        output_path = os.path.join("output", value)
        if os.path.exists(output_path):
            return output_path
        return None

    def _resolve_image(self, value: Optional[str]) -> Optional[str]:
        if not isinstance(value, str):
            return None
        candidate = value.strip()
        if not candidate:
            return None
        if candidate.startswith(("http://", "https://", "data:")):
            return candidate
        if is_object_key(candidate):
            try:
                uploader = OSSImageUploader()
                if uploader.is_configured:
                    signed = uploader.sign_url_for_api(candidate)
                    if signed:
                        return signed
            except Exception as exc:
                logger.warning("[Seedance] Failed to sign object key %s: %s", candidate, exc)
        if candidate.startswith("file://"):
            return self._resolve_local_image_input(candidate[7:])
        local_path = self._resolve_local_path_candidate(candidate)
        return self._resolve_local_image_input(local_path) if local_path else None

    def _resolve_image_list(self, values: Optional[List[str]]) -> List[str]:
        resolved: List[str] = []
        seen = set()
        for value in values or []:
            image = self._resolve_image(value)
            if image and image not in seen:
                resolved.append(image)
                seen.add(image)
        return resolved

    def _build_content(
        self,
        prompt: str,
        first_frame: Optional[str],
        ref_images: List[str],
        mode: Optional[str],
    ) -> List[Dict[str, Any]]:
        content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]

        refs = list(ref_images)
        if first_frame:
            content.append({
                "type": "image_url",
                "image_url": {"url": first_frame},
                "role": "first_frame",
            })

        if mode == "keyframes" and refs:
            if not first_frame:
                content.append({
                    "type": "image_url",
                    "image_url": {"url": refs.pop(0)},
                    "role": "first_frame",
                })
            if refs:
                content.append({
                    "type": "image_url",
                    "image_url": {"url": refs.pop(0)},
                    "role": "last_frame",
                })

        for ref in refs[:9]:
            content.append({
                "type": "image_url",
                "image_url": {"url": ref},
                "role": "reference_image",
            })
        return content

    def _build_modelverse_parameters(self, **kwargs) -> Dict[str, Any]:
        parameters: Dict[str, Any] = {
            "duration": int(kwargs.get("duration") or 5),
            "resolution": kwargs.get("resolution") or "1080p",
            "ratio": kwargs.get("ratio") or "16:9",
        }
        if kwargs.get("seed") is not None:
            parameters["seed"] = kwargs["seed"]
        if kwargs.get("watermark") is not None:
            parameters["watermark"] = bool(kwargs["watermark"])
        if kwargs.get("prompt_extend") is not None:
            parameters["prompt_extend"] = bool(kwargs["prompt_extend"])
        return parameters

    def _modelverse_headers(self) -> Dict[str, str]:
        return {
            "Authorization": self.modelverse_api_key,
            "Content-Type": "application/json",
        }

    def _submit_modelverse(
        self,
        model: str,
        content: List[Dict[str, Any]],
        parameters: Dict[str, Any],
    ) -> str:
        submit_url = f"{self.modelverse_base_url.rstrip('/')}/v1/tasks/submit"
        response = requests.post(
            submit_url,
            headers=self._modelverse_headers(),
            json={
                "model": model,
                "input": {"content": content},
                "parameters": parameters,
            },
            timeout=120,
        )
        if not response.ok:
            raise RuntimeError(
                f"Seedance ModelVerse submit failed (HTTP {response.status_code}): "
                f"{_response_error_detail(response)}"
            )
        payload = response.json()
        task_id = (
            payload.get("output", {}).get("task_id")
            or payload.get("task_id")
            or payload.get("id")
        )
        if not task_id:
            raise RuntimeError(f"Seedance ModelVerse submit returned no task_id: {payload!r}")
        return str(task_id)

    def _poll_modelverse(self, task_id: str) -> str:
        status_url = f"{self.modelverse_base_url.rstrip('/')}/v1/tasks/status"
        deadline = time.time() + self.max_wait
        while time.time() < deadline:
            response = requests.get(
                status_url,
                headers=self._modelverse_headers(),
                params={"task_id": task_id},
                timeout=120,
            )
            if not response.ok:
                raise RuntimeError(
                    f"Seedance ModelVerse status failed (HTTP {response.status_code}): "
                    f"{_response_error_detail(response)}"
                )
            payload = response.json()
            output = payload.get("output") or {}
            status = str(output.get("task_status") or payload.get("task_status") or "").lower()
            if status == "success":
                urls = output.get("urls") or payload.get("urls") or []
                if urls:
                    return str(urls[0])
                raise RuntimeError(f"Seedance ModelVerse task succeeded without urls: {payload!r}")
            if status in {"failed", "fail", "error"}:
                raise RuntimeError(f"Seedance ModelVerse task failed: {payload!r}")
            time.sleep(self.poll_interval)
        raise RuntimeError(f"Seedance ModelVerse task {task_id} timed out after {self.max_wait}s")

    def _extract_video_url(self, result: Any) -> Optional[str]:
        content = getattr(result, "content", None)
        if content is not None:
            video_url = getattr(content, "video_url", None)
            if video_url:
                return video_url
            if isinstance(content, dict):
                return content.get("video_url") or content.get("url")
        if isinstance(result, dict):
            content_dict = result.get("content") or {}
            if isinstance(content_dict, dict):
                return content_dict.get("video_url") or content_dict.get("url")
        return None

    def _download_video(self, url: str, output_path: str) -> None:
        response = requests.get(url, stream=True, timeout=300)
        response.raise_for_status()
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as file:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    file.write(chunk)

    def generate(self, prompt: str, output_path: str, **kwargs) -> Tuple[str, float]:
        model = self._api_model_id(kwargs.get("model") or kwargs.get("model_name"))
        img_url = kwargs.get("img_url")
        img_path = kwargs.get("img_path")
        first_frame = self._resolve_image(img_url) or self._resolve_image(img_path)
        ref_images = self._resolve_image_list(kwargs.get("ref_image_urls") or [])
        mode = kwargs.get("mode")
        duration = int(kwargs.get("duration") or 5)
        resolution = kwargs.get("resolution") or "1080p"
        ratio = kwargs.get("ratio") or "adaptive"

        if not first_frame and not ref_images and not prompt:
            raise ValueError("Seedance generation requires prompt or image inputs")

        content = self._build_content(prompt, first_frame, ref_images, mode)
        start = time.time()
        request_debug: Dict[str, Any] = {
            "provider": self.provider,
            "model": model,
            "mode": mode or "auto",
            "duration": duration,
            "resolution": resolution,
            "ratio": ratio,
            "image_count": max(0, len(content) - 1),
            "roles": [item.get("role") for item in content if item.get("type") == "image_url"],
            "content": _safe_json_payload(content),
        }
        op_id = enter_operation(
            "video",
            detail=(
                "Seedance submit · "
                f"provider={self.provider} · images={max(0, len(content) - 1)} · mode={mode or 'auto'}"
            ),
            model=model,
            debug=request_debug,
        )

        try:
            if self.provider == "modelverse":
                parameters = self._build_modelverse_parameters(**kwargs)
                request_debug["parameters"] = parameters
                logger.info(
                    "[Seedance ModelVerse] submit model=%s duration=%s resolution=%s images=%s mode=%s",
                    model,
                    parameters.get("duration"),
                    parameters.get("resolution"),
                    len(content) - 1,
                    mode or "auto",
                )
                task_id = self._submit_modelverse(model, content, parameters)
                video_url = self._poll_modelverse(task_id)
                self._download_video(video_url, output_path)
                elapsed = time.time() - start
                update_operation(
                    op_id,
                    "success",
                    detail="Video generated",
                    duration_ms=elapsed * 1000,
                    output_path=output_path[:200],
                    debug=request_debug,
                    provider_result=_safe_json_payload({
                        "task_id": task_id,
                        "download_url": video_url,
                    }),
                )
                return output_path, elapsed

            if not self.client:
                raise RuntimeError("Ark client not initialized. Install volcenginesdkarkruntime.")

            create_kwargs = {
                "model": model,
                "content": content,
                "duration": duration,
                "resolution": resolution,
                "ratio": ratio,
            }
            if kwargs.get("seed") is not None:
                create_kwargs["seed"] = kwargs["seed"]
            if kwargs.get("watermark") is not None:
                create_kwargs["watermark"] = bool(kwargs["watermark"])
            if kwargs.get("prompt_extend") is not None:
                create_kwargs["prompt_extend"] = bool(kwargs["prompt_extend"])
            request_debug["request_body"] = _safe_json_payload(create_kwargs)

            logger.info(
                "[Seedance] submit model=%s duration=%s resolution=%s images=%s mode=%s",
                model,
                duration,
                resolution,
                len(content) - 1,
                mode or "auto",
            )
            task = self.client.content_generation.tasks.create(**create_kwargs)
            task_id = getattr(task, "id", None) or (task.get("id") if isinstance(task, dict) else None)
            if not task_id:
                raise RuntimeError(f"Seedance task creation returned no id: {task!r}")

            deadline = time.time() + self.max_wait
            while time.time() < deadline:
                result = self.client.content_generation.tasks.get(task_id=task_id)
                status = getattr(result, "status", None) or (
                    result.get("status") if isinstance(result, dict) else None
                )
                if status == "succeeded":
                    video_url = self._extract_video_url(result)
                    if not video_url:
                        raise RuntimeError(f"Seedance task succeeded without video URL: {result!r}")
                    self._download_video(video_url, output_path)
                    elapsed = time.time() - start
                    update_operation(
                        op_id,
                        "success",
                        detail="Video generated",
                        duration_ms=elapsed * 1000,
                        output_path=output_path[:200],
                        debug=request_debug,
                        provider_result=_safe_json_payload({
                            "task_id": task_id,
                            "download_url": video_url,
                        }),
                    )
                    return output_path, elapsed
                if status == "failed":
                    error = getattr(result, "error", None) or (
                        result.get("error") if isinstance(result, dict) else None
                    )
                    raise RuntimeError(f"Seedance task failed: {error}")
                time.sleep(self.poll_interval)

            raise RuntimeError(f"Seedance task {task_id} timed out after {self.max_wait}s")
        except Exception as exc:
            update_operation(
                op_id,
                "error",
                detail=f"Error: {str(exc)[:1000]}",
                duration_ms=(time.time() - start) * 1000,
                debug=request_debug,
            )
            raise
