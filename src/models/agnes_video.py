"""
Agnes Video v2.0 Generation Adapter.

Supports the Agnes AI video API (https://agnes-ai.com) via Bearer-token
async task-based workflow: POST /v1/videos → poll /agnesapi?video_id=.

Configuration (picked up from env, same as existing openai_video):
  VIDEO_PROVIDER  — "openai" (detected by generator layer)
  VIDEO_API_KEY   — API key for Agnes AI
  VIDEO_BASE_URL  — Base URL (e.g. https://apihub.agnes-ai.com)
  VIDEO_MODEL     — Model name (e.g. agnes-video-v2.0)

This adapter is selected automatically when VIDEO_MODEL starts with "agnes-".
"""

import base64
import json
import mimetypes
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

from .base import VideoGenModel
from ..utils import get_logger
from ..utils.op_logger import enter_operation, update_operation
from ..utils.oss_utils import OSSImageUploader, is_object_key

logger = get_logger(__name__)


def _env(key: str, default: str = "") -> str:
    val = os.environ.get(key, default)
    if val and len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
        val = val[1:-1]
    return val


# ── Aspect ratio → width/height mappings (portrait & landscape) ──────
_ASPECT_TO_DIMS: Dict[str, Tuple[int, int]] = {
    "1:1": (1024, 1024),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
    "16:9": (1280, 768),
    "9:16": (768, 1280),
    "21:9": (1792, 768),
}


def _size_to_dims(size_str: str, aspect_ratio: Optional[str] = None) -> Tuple[int, int]:
    """Convert LumenX size string ("1280*720") or aspect ratio to (width, height)."""
    if size_str and "*" in size_str:
        parts = size_str.replace("*", "x").split("x")
        try:
            return int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            pass
    if aspect_ratio and aspect_ratio in _ASPECT_TO_DIMS:
        return _ASPECT_TO_DIMS[aspect_ratio]
    return 1280, 768  # default landscape


def _duration_to_frames(duration: int, frame_rate: int = 24) -> int:
    """Convert duration (seconds) to num_frames for Agnes Video API.

    Formula from docs: seconds = num_frames / frame_rate
    """
    duration_val = max(1, min(duration or 5, 15))
    target_frames = duration_val * frame_rate
    # Agnes requires num_frames <= 441 and, unlike most video providers,
    # strictly validates the 8n + 1 rule.  For example 2 seconds at 24 fps
    # must be submitted as 49 frames rather than 48.
    n = round((target_frames - 1) / 8)
    return min(441, max(1, n * 8 + 1))


def _response_error_detail(response: requests.Response) -> str:
    """Return the provider error body instead of requests' generic status text."""
    try:
        payload = response.json()
        detail = str(payload)
    except (ValueError, TypeError):
        detail = (response.text or "").strip()
    return detail[:1000] or response.reason or "Unknown provider error"


def _mask_sensitive_headers(headers: Dict[str, str]) -> Dict[str, str]:
    masked: Dict[str, str] = {}
    for key, value in (headers or {}).items():
        if key.lower() == "authorization" and isinstance(value, str):
            if len(value) > 18:
                masked[key] = f"{value[:10]}...{value[-4:]}"
            else:
                masked[key] = "***"
        else:
            masked[key] = value
    return masked


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
        json.dumps(payload, ensure_ascii=False)
        return _summarize_media_value(payload)
    except TypeError:
        return _summarize_media_value(str(payload))


class AgnesVideoModel(VideoGenModel):
    """Agnes Video v2.0 adapter — async create + poll."""

    def __init__(self, config: dict):
        super().__init__(config)
        self.params = config.get("params", {})

    # ── Config accessors ──────────────────────────────────────────────

    @property
    def api_key(self) -> str:
        key = _env("VIDEO_API_KEY")
        if not key:
            logger.warning("VIDEO_API_KEY not set, Agnes Video generation may fail")
        return key

    @property
    def base_url(self) -> str:
        base = _env("VIDEO_BASE_URL", "https://apihub.agnes-ai.com").rstrip("/")
        # Accept both host-only and OpenAI-style base URL configuration without
        # accidentally producing /v1/v1/videos.
        if base.endswith("/v1"):
            base = base[:-3]
        return base

    @property
    def model_name(self) -> str:
        return _env("VIDEO_MODEL", "agnes-video-v2.0")

    @property
    def frame_rate(self) -> int:
        """Default frame rate for duration→frames conversion."""
        return int(self.params.get("frame_rate", 24))

    @property
    def local_serve_base_url(self) -> str:
        """Backend's own URL for serving local files (no OSS dependency).

        Set LOCAL_SERVE_BASE_URL to your backend's public address
        (e.g. http://192.168.1.100:8000). When set, local asset files
        like ``assets/stages/xxx.png`` are served as
        ``{LOCAL_SERVE_BASE_URL}/local-file/{relpath}`` instead of
        being converted to oversized data URIs that can time out.

        Defaults to empty (disabled); falls through to data URI.
        """
        return _env("LOCAL_SERVE_BASE_URL").rstrip("/")

    @property
    def submit_timeout(self) -> int:
        """Seconds to wait for Agnes to acknowledge a create request.

        Although the documented API is asynchronous, the gateway may spend
        more than a minute accepting image-guided requests before returning the
        task ID. Keep connect timeout short while allowing a longer read wait.
        """
        raw = _env("VIDEO_SUBMIT_TIMEOUT", "180")
        try:
            return max(60, min(int(raw), 600))
        except (TypeError, ValueError):
            return 180

    def _auth_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ── Image encoding helpers ────────────────────────────────────────

    def _encode_local_image(self, path: str) -> str:
        """Encode local file to base64 data URI."""
        with open(path, "rb") as f:
            img_bytes = f.read()
        mime = mimetypes.guess_type(path)[0] or "image/png"
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        return f"data:{mime};base64,{b64}"

    def _sign_or_upload_local_image(self, local_path: str) -> Optional[str]:
        """Prefer an OSS-backed signed URL for Agnes local image inputs."""
        if not local_path or not os.path.exists(local_path):
            return None
        try:
            uploader = OSSImageUploader()
            if not uploader.is_configured:
                return None
            object_key = uploader.upload_file(local_path, sub_path="temp/agnes_video")
            if not object_key:
                logger.warning(
                    "[Agnes Video] Failed to upload local image to OSS for Agnes input: %s",
                    local_path,
                )
                return None
            signed_url = uploader.sign_url_for_api(object_key)
            if signed_url:
                return signed_url
            logger.warning(
                "[Agnes Video] Uploaded local image but failed to sign Agnes input URL: %s",
                object_key,
            )
        except Exception as exc:
            logger.warning(
                "[Agnes Video] Failed to upload/sign local image for Agnes input %s: %s",
                local_path,
                exc,
            )
        return None

    def _resolve_to_local_url(self, local_path: str) -> Optional[str]:
        """Convert local file path to a /local-file/ HTTP URL.

        Requires LOCAL_SERVE_BASE_URL to be set (e.g. http://192.168.1.100:8000).
        Returns None when the env var is not configured.
        """
        base = self.local_serve_base_url
        if not base or not local_path or not os.path.exists(local_path):
            return None
        abs_path = os.path.abspath(local_path)
        cwd = os.getcwd()
        try:
            rel_path = os.path.relpath(abs_path, cwd)
            if rel_path.startswith(".."):
                logger.warning(
                    "[Agnes Video] Local path %s is outside cwd %s, cannot serve via /local-file/",
                    local_path,
                    cwd,
                )
                return None
            url = f"{base}/local-file/{rel_path}"
            logger.info(
                "[Agnes Video] Serving local file as HTTP URL: %s",
                url,
            )
            return url
        except ValueError as exc:
            logger.warning(
                "[Agnes Video] Cannot compute relative path for %s: %s",
                local_path,
                exc,
            )
            return None

    def _resolve_local_image_input(self, local_path: str) -> Optional[str]:
        """Resolve local file to a provider-ready URL.

        Priority: OSS signed URL → local /local-file/ URL → base64 data URI.
        Returns None when the file does not exist.
        """
        if not local_path or not os.path.exists(local_path):
            return None
        # 1) OSS signed URL
        signed = self._sign_or_upload_local_image(local_path)
        if signed:
            return signed
        # 2) Local HTTP URL (no OSS dependency)
        local_url = self._resolve_to_local_url(local_path)
        if local_url:
            return local_url
        # 3) Fallback: data URI
        return self._encode_local_image(local_path)

    def _resolve_local_path_candidate(self, value: str) -> Optional[str]:
        if not isinstance(value, str) or not value:
            return None
        if os.path.exists(value):
            return value
        alt = os.path.join("output", value)
        if os.path.exists(alt):
            return alt
        return None

    def _resolve_single_image(
        self, img_url: Optional[str], img_path: Optional[str]
    ) -> Optional[str]:
        """Resolve a single image input to URL or data URI."""
        # Agnes Video requires a publicly accessible URL for image-to-video.
        # process_video_task also supplies a downloaded img_path, but converting
        # that copy to a data URI makes an otherwise valid remote image fail.
        if img_url and (
            img_url.startswith("http://") or img_url.startswith("https://")
        ):
            return img_url
        if img_path and os.path.exists(img_path):
            return self._resolve_local_image_input(img_path)
        if img_url:
            if img_url.startswith("http://") or img_url.startswith("https://"):
                return img_url
            if img_url.startswith("data:"):
                return img_url
            if is_object_key(img_url):
                uploader = OSSImageUploader()
                if uploader.is_configured:
                    signed_url = uploader.sign_url_for_api(img_url)
                    if signed_url:
                        return signed_url
                logger.warning(
                    "[Agnes Video] Object key image input could not be signed; "
                    "OSS is not configured or signing failed: %s",
                    img_url,
                )
            if img_url.startswith("file://"):
                local = img_url[7:]
                if os.path.exists(local):
                    return self._resolve_local_image_input(local)
            local_candidate = self._resolve_local_path_candidate(img_url)
            if local_candidate:
                return self._resolve_local_image_input(local_candidate)
        return None

    def _resolve_media_ref(self, ref: Optional[str]) -> Optional[str]:
        """Resolve a reference image to a provider-ready URL or data URI."""
        if not isinstance(ref, str):
            return None
        value = ref.strip()
        if not value:
            return None
        if value.startswith("http://") or value.startswith("https://"):
            return value
        if value.startswith("data:"):
            return value
        if is_object_key(value):
            uploader = OSSImageUploader()
            if uploader.is_configured:
                signed_url = uploader.sign_url_for_api(value)
                if signed_url:
                    return signed_url
            logger.warning(
                "[Agnes Video] Reference object key could not be signed; "
                "OSS is not configured or signing failed: %s",
                value,
            )
            return None
        if value.startswith("file://"):
            local = value[7:]
            if os.path.exists(local):
                return self._resolve_local_image_input(local)
            return None
        local_candidate = self._resolve_local_path_candidate(value)
        if local_candidate:
            return self._resolve_local_image_input(local_candidate)
        return None

    def _resolve_ref_images(self, ref_image_paths: Optional[List[str]]) -> List[str]:
        """Resolve reference image paths to HTTP URLs or data URIs."""
        if not ref_image_paths:
            return []
        resolved: List[str] = []
        for p in ref_image_paths:
            try:
                resolved_ref = self._resolve_media_ref(p)
                if resolved_ref:
                    resolved.append(resolved_ref)
                elif p:
                    logger.warning(f"Ref image path not found: {p}")
            except Exception as e:
                logger.warning(f"Cannot resolve ref image {p}: {e}")
        return resolved

    # ── Main entry point ──────────────────────────────────────────────

    def generate(
        self,
        prompt: str,
        output_path: str,
        img_url: Optional[str] = None,
        img_path: Optional[str] = None,
        model_name: Optional[str] = None,
        duration: int = 5,
        aspect_ratio: Optional[str] = None,
        size: Optional[str] = None,
        audio_url: Optional[str] = None,
        **kwargs,
    ) -> Tuple[str, float]:
        """Generate video via Agnes Video v2.0 API.

        Supports T2V (text-to-video), I2V (image-to-video),
        multi-image, and keyframe animation modes.
        """
        model = self.model_name or model_name or "agnes-video-v2.0"

        # ── Resolve dimensions ──────────────────────────────────────
        width, height = _size_to_dims(size or "", aspect_ratio)
        num_frames = _duration_to_frames(duration, self.frame_rate)

        # ── Resolve image input(s) ────────────────────────────────
        single_image = self._resolve_single_image(img_url, img_path)
        ref_image_urls = kwargs.get("ref_image_urls", []) or []
        ref_image_paths = kwargs.get("ref_image_paths", []) or []
        resolved_ref_urls = self._resolve_ref_images(ref_image_urls)
        # Resolve ref_image_paths to provider-ready refs too
        resolved_refs = self._resolve_ref_images(ref_image_paths)
        all_refs = resolved_ref_urls + resolved_refs

        # Detect mode
        mode = kwargs.get("mode")
        is_i2v = single_image is not None
        has_refs = len(all_refs) > 0
        is_keyframe = mode == "keyframes"

        logger.info(
            f"[Agnes Video] model={model}, "
            f"is_i2v={is_i2v}, ref_count={len(all_refs)}, "
            f"keyframe={is_keyframe}, "
            f"size={width}x{height}, frames={num_frames}, "
            f"fps={self.frame_rate}"
        )
        logger.info(f"[Agnes Video] Prompt: {prompt[:200]}")
        api_start_time = time.time()

        try:
            # ── Build request body ──────────────────────────────────
            body: dict = {
                "model": model,
                "prompt": prompt,
                "height": height,
                "width": width,
                "num_frames": num_frames,
                "frame_rate": self.frame_rate,
            }

            if is_i2v:
                body["image"] = single_image
                logger.info(f"[Agnes Video] I2V mode, image provided")
            elif is_keyframe and has_refs:
                body["extra_body"] = {
                    "image": all_refs,
                    "mode": "keyframes",
                }
                logger.info(
                    f"[Agnes Video] Keyframe mode, {len(all_refs)} ref images"
                )
            elif has_refs:
                body["extra_body"] = {
                    "image": all_refs,
                }
                logger.info(
                    f"[Agnes Video] Multi-image mode, {len(all_refs)} ref images"
                )
            else:
                logger.info("[Agnes Video] T2V mode")

            if audio_url:
                body["audio_url"] = audio_url

            # ── Submit task ─────────────────────────────────────────
            submit_url = f"{self.base_url}/v1/videos"
            request_debug = {
                "submit_url": submit_url,
                "request_headers": _mask_sensitive_headers(self._auth_headers()),
                "request_body": _safe_json_payload(body),
                "resolved_inputs": {
                    "single_image": _safe_json_payload(single_image),
                    "raw_ref_image_urls": _safe_json_payload(ref_image_urls),
                    "raw_ref_image_paths": _safe_json_payload(ref_image_paths),
                    "resolved_ref_image_urls": _safe_json_payload(resolved_ref_urls),
                    "resolved_ref_image_paths": _safe_json_payload(resolved_refs),
                    "all_refs": _safe_json_payload(all_refs),
                },
                "mode": {
                    "is_i2v": is_i2v,
                    "has_refs": has_refs,
                    "is_keyframe": is_keyframe,
                    "duration": duration,
                    "num_frames": num_frames,
                    "size": {"width": width, "height": height},
                },
            }
            op_id = enter_operation(
                "video",
                detail=f"Agnes submit · refs={len(all_refs)} · i2v={'yes' if is_i2v else 'no'}",
                model=model,
                debug=request_debug,
            )
            logger.info(f"[Agnes Video] POST {submit_url}")
            resp = requests.post(
                submit_url, headers=self._auth_headers(),
                json=body, timeout=(15, self.submit_timeout),
            )
            response_debug = {
                "status_code": getattr(resp, "status_code", None),
                "ok": bool(getattr(resp, "ok", False)),
            }
            try:
                response_debug["body"] = _safe_json_payload(resp.json())
            except Exception:
                response_debug["body_text"] = (getattr(resp, "text", "") or "")[:4000]
            if not resp.ok:
                detail = _response_error_detail(resp)
                update_operation(
                    op_id,
                    "error",
                    detail=f"Error: Agnes submit failed (HTTP {resp.status_code})",
                    duration_ms=(time.time() - api_start_time) * 1000,
                    debug=request_debug,
                    response=response_debug,
                )
                raise RuntimeError(
                    f"Agnes Video submit failed (HTTP {resp.status_code}): {detail}"
                )
            task_data = resp.json()
            logger.info(
                f"[Agnes Video] Task created: "
                f"id={task_data.get('id')}, "
                f"video_id={task_data.get('video_id')}, "
                f"status={task_data.get('status')}"
            )

            task_id = task_data.get("id") or task_data.get("task_id")
            video_id = task_data.get("video_id")
            status = task_data.get("status", "")

            # Check if already completed (synchronous response)
            if status in ("completed", "succeeded"):
                video_url = self._extract_video_url(task_data)
                if video_url:
                    self._download_video(video_url, output_path)
                    api_duration = time.time() - api_start_time
                    update_operation(
                        op_id, "success", detail="Video generated",
                        duration_ms=api_duration * 1000,
                        output_path=output_path[:200],
                        debug=request_debug,
                        response=response_debug,
                        provider_result=_safe_json_payload(task_data),
                    )
                    return output_path, api_duration

            if status in ("failed", "error", "cancelled"):
                msg = task_data.get("error") or task_data.get("message", "Unknown")
                raise RuntimeError(f"Agnes Video task {status}: {msg}")

            # ── Poll for completion ─────────────────────────────────
            if not video_id:
                video_id = task_id  # fallback
            video_url = self._poll_agnes(task_id, video_id)
            self._download_video(video_url, output_path)

            api_duration = time.time() - api_start_time
            update_operation(
                op_id, "success", detail="Video generated",
                duration_ms=api_duration * 1000,
                output_path=output_path[:200],
                debug=request_debug,
                response=response_debug,
                provider_result=_safe_json_payload({
                    "submit_task": task_data,
                    "download_url": video_url,
                }),
            )
            return output_path, api_duration

        except Exception as e:
            import traceback
            logger.error(f"[Agnes Video] generation failed: {e}")
            logger.error(traceback.format_exc())
            if 'op_id' in locals():
                extra_payload = {
                    "exception": _safe_json_payload({
                        "message": str(e),
                        "traceback": traceback.format_exc(),
                    }),
                }
                if "request_debug" in locals():
                    extra_payload["debug"] = request_debug
                if "response_debug" in locals():
                    extra_payload["response"] = response_debug
                update_operation(
                    op_id, "error",
                    detail=f"Error: {str(e)[:1000]}",
                    duration_ms=(time.time() - api_start_time) * 1000,
                    **extra_payload,
                )
            raise

    # ── Polling ───────────────────────────────────────────────────────

    def _poll_agnes(
        self, task_id: str, video_id: str,
        max_wait: int = 900, poll_interval: int = 8,
    ) -> str:
        """Poll Agnes Video task using /agnesapi?video_id= endpoint.

        Returns the video download URL string.
        """
        poll_url = f"{self.base_url}/agnesapi?video_id={video_id}"
        # Optionally append model_name for routing
        model_name = self.model_name
        if model_name and "model_name=" not in poll_url:
            poll_url += f"&model_name={model_name}"

        # Also keep fallback endpoint
        fallback_url = f"{self.base_url}/v1/videos/{task_id}"

        elapsed = 0
        while elapsed < max_wait:
            time.sleep(poll_interval)
            elapsed += poll_interval

            # Try primary endpoint first
            for url in (poll_url, fallback_url):
                try:
                    resp = requests.get(
                        url, headers=self._auth_headers(), timeout=30,
                    )
                    if resp.status_code == 404:
                        continue
                    resp.raise_for_status()
                    data = resp.json()

                    status = data.get("status", "")
                    logger.info(
                        f"[Agnes Video] Poll {url}: status={status} ({elapsed}s)"
                    )

                    if status in ("completed", "succeeded", "success", "done"):
                        video_url = self._extract_video_url(data)
                        if video_url:
                            logger.info(
                                f"[Agnes Video] Done, video: {video_url[:80]}..."
                            )
                            return video_url
                        logger.warning(
                            f"[Agnes Video] Status={status} but no video URL found"
                        )
                        continue  # wait one more cycle

                    if status in ("failed", "error", "cancelled"):
                        msg = data.get("error") or data.get("message",
                                                            data.get("fail_reason", "Unknown"))
                        raise RuntimeError(f"Agnes Video task {status}: {msg}")

                    break  # got a successful response, stop trying other URLs

                except requests.HTTPError as e:
                    sc = e.response.status_code if e.response is not None else "?"
                    if sc == 404:
                        continue
                    detail = (
                        _response_error_detail(e.response)
                        if e.response is not None else str(e)
                    )
                    raise RuntimeError(
                        f"Agnes Video poll failed (HTTP {sc}): {detail}"
                    ) from e

        raise RuntimeError(
            f"Agnes Video task {task_id} timed out after {max_wait}s"
        )

    # ── Response extraction ───────────────────────────────────────────

    def _extract_video_url(self, data: dict) -> Optional[str]:
        """Extract video URL from Agnes Video response.

        Agnes uses 'remixed_from_video_id' for the download URL
        in completed responses.
        """
        if not isinstance(data, dict):
            return None

        # Primary: remixed_from_video_id (Agnes-specific)
        val = data.get("remixed_from_video_id")
        if isinstance(val, str) and val and val.startswith("http"):
            return val

        # Fallback: video_url, url, output.video_url
        for key in ("video_url", "url", "video"):
            val = data.get(key)
            if isinstance(val, str) and val and val.startswith("http"):
                return val

        output = data.get("output", {})
        if isinstance(output, dict):
            val = output.get("video_url")
            if isinstance(val, str) and val and val.startswith("http"):
                return val

        # data[0] style
        data_list = data.get("data", [])
        if isinstance(data_list, list) and data_list:
            item = data_list[0]
            if isinstance(item, dict):
                for key in ("video_url", "url", "remixed_from_video_id"):
                    val = item.get(key)
                    if isinstance(val, str) and val and val.startswith("http"):
                        return val

        return None

    # ── Download ──────────────────────────────────────────────────────

    def _download_video(self, url: str, output_path: str):
        """Download video from URL to local path."""
        logger.info(f"[Agnes Video] Downloading to {output_path}...")
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        temp = output_path + ".tmp"
        try:
            with requests.get(url, stream=True, timeout=300) as r:
                r.raise_for_status()
                with open(temp, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        f.write(chunk)
            os.rename(temp, output_path)
            logger.info("[Agnes Video] Download complete")
        except Exception as e:
            logger.error(f"[Agnes Video] Download failed: {e}")
            if os.path.exists(temp):
                os.remove(temp)
            raise
