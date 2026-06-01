"""
OpenAI-compatible Video Generation Adapter.

Supports third-party video APIs that follow OpenAI-compatible authentication
(bearer token) and JSON request/response patterns.

Configuration:
  VIDEO_PROVIDER        — "openai" (default "dashscope" falls back to WanxModel)
  VIDEO_API_KEY         — API key (no fallback to LLM or IMAGE keys)
  VIDEO_BASE_URL        — Base URL for video API
  VIDEO_MODEL           — Model name for video generation
"""

import os
import time
import base64
import mimetypes
from typing import Tuple, Optional

import requests

from .base import VideoGenModel
from ..utils import get_logger
from ..utils.op_logger import enter_operation, update_operation

logger = get_logger(__name__)


def _get_setting(*keys: str, default: str = "") -> str:
    for key in keys:
        val = os.environ.get(key, "")
        if val:
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            return val
    return default


class OpenAIVideoModel(VideoGenModel):
    """OpenAI-compatible video generation model using REST API.

    Probes multiple endpoint patterns in priority order, stopping at the
    first endpoint that returns a recognizable video response (task_id or
    video_url).  Does NOT fall through to image-only endpoints when a
    video-capable endpoint is found.
    """

    def __init__(self, config: dict):
        super().__init__(config)
        self.params = config.get("params", {})

    # ── config ────────────────────────────────────────────────────────

    @property
    def api_key(self) -> str:
        key = _get_setting("VIDEO_API_KEY", default="")
        if not key:
            logger.warning("VIDEO_API_KEY not set, video generation may fail")
        return key

    @property
    def base_url(self) -> str:
        return _get_setting("VIDEO_BASE_URL",
                            default="https://api.openai.com/v1").rstrip("/")

    @property
    def model_name(self) -> str:
        return _get_setting("VIDEO_MODEL", default="")

    def _auth_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ── image helpers ─────────────────────────────────────────────────

    def _encode_image_to_data_url(self, image_path: str) -> str:
        with open(image_path, "rb") as f:
            img_bytes = f.read()
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        return f"data:{mime};base64,{b64}"

    def _resolve_image_input(
        self, img_url: Optional[str], img_path: Optional[str]
    ) -> Optional[str]:
        if img_path and os.path.exists(img_path):
            return self._encode_image_to_data_url(img_path)
        if img_url:
            if img_url.startswith("data:") or img_url.startswith("http"):
                return img_url
            if img_url.startswith("file://"):
                local_path = img_url[7:]
                if os.path.exists(local_path):
                    return self._encode_image_to_data_url(local_path)
            if os.path.exists(img_url):
                return self._encode_image_to_data_url(img_url)
        return None

    # ── response parsing ──────────────────────────────────────────────

    def _extract_video_url(self, data: dict) -> Optional[str]:
        """Try multiple common response formats to extract video_url."""
        if not isinstance(data, dict):
            return None

        for key in ("video_url", "url", "video"):
            val = data.get(key)
            if isinstance(val, str) and val and val.startswith("http"):
                return val

        # data[0] — images/generations style
        data_list = data.get("data", [])
        if isinstance(data_list, list) and data_list:
            item = data_list[0]
            if isinstance(item, dict):
                # Only return if it looks like a video URL (not image)
                for key in ("video_url",):
                    val = item.get(key)
                    if isinstance(val, str) and val and val.startswith("http"):
                        return val

        # output.video_url
        output = data.get("output", {})
        if isinstance(output, dict):
            val = output.get("video_url")
            if isinstance(val, str) and val and val.startswith("http"):
                return val

        # data.task_result.videos[0].url (Kling-style)
        task_data = data.get("data", {})
        if isinstance(task_data, dict):
            task_result = task_data.get("task_result", {})
            if isinstance(task_result, dict):
                videos = task_result.get("videos", [])
                if videos and isinstance(videos, list):
                    url = videos[0].get("url") if isinstance(videos[0], dict) else None
                    if url and isinstance(url, str) and url.startswith("http"):
                        return url

        # choices[0].message.content — might contain a video URL
        choices = data.get("choices", [])
        if choices and isinstance(choices, list):
            msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            if isinstance(content, str) and content:
                import re
                urls = re.findall(r'https?://[^\s<>"\']+\.(?:mp4|mov|webm|avi)[^\s<>"\']*', content)
                if urls:
                    return urls[0]

        return None

    def _extract_task_id(self, data: dict) -> Optional[str]:
        """Try multiple common response formats to extract task_id."""
        if not isinstance(data, dict):
            return None
        for key in ("task_id", "id", "job_id"):
            val = data.get(key)
            if val:
                return str(val)
        task_data = data.get("data", {})
        if isinstance(task_data, dict):
            tid = task_data.get("task_id") or task_data.get("id")
            if tid:
                return str(tid)
        return None

    # ── polling ───────────────────────────────────────────────────────

    def _poll_for_video(self, task_id: str, max_wait: int = 600,
                        poll_interval: int = 5) -> Optional[str]:
        """Poll video task status until complete. Returns video_url or None."""
        # Geeknow-style: GET /videos/{task_id}
        poll_urls = [
            f"{self.base_url}/videos/{task_id}",
        ]

        elapsed = 0
        while elapsed < max_wait:
            time.sleep(poll_interval)
            elapsed += poll_interval

            for url in poll_urls:
                try:
                    resp = requests.get(url, headers=self._auth_headers(),
                                       timeout=30)
                    resp.raise_for_status()
                    data = resp.json()

                    status = data.get("status", "")
                    logger.debug(
                        f"[OpenAI Video] Poll {url}: status={status} ({elapsed}s)"
                    )

                    if status in ("succeeded", "completed", "success", "done",
                                  "SUCCESS", "SUCCEEDED"):
                        video_url = self._extract_video_url(data)
                        if video_url:
                            return video_url
                        # status says done but no video_url yet — wait one more cycle
                        logger.warning(
                            f"Task {task_id} status={status} but no video_url found"
                        )
                    elif status in ("failed", "error", "cancelled",
                                    "FAILED", "ERROR", "CANCELLED"):
                        msg = data.get("error") or data.get("message",
                                                            data.get("fail_reason", "Unknown"))
                        raise RuntimeError(f"Task {task_id} {status}: {msg}")
                    # else: queued / processing / in_progress — continue
                    break  # successful response, don't try other poll URLs
                except requests.HTTPError:
                    continue  # try next poll URL

        return None  # timed out

    # ── endpoint probing ──────────────────────────────────────────────

    def _try_post(self, url: str, body: dict, timeout: int = 120) -> Optional[dict]:
        """POST to endpoint, return JSON or None on 404."""
        try:
            resp = requests.post(
                url, headers=self._auth_headers(),
                json=body, timeout=timeout,
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return None
            raise

    def _submit_and_poll(self, model: str, prompt: str,
                         image: Optional[str], duration: int,
                         ref_image_urls: list = None,
                         ref_video_urls: list = None) -> str:
        """Try endpoints in order, first success wins. Returns video_url."""
        ref_images = ref_image_urls or []
        ref_videos = ref_video_urls or []
        has_refs = len(ref_images) > 0 or len(ref_videos) > 0
        is_i2v = image is not None or has_refs
        base = self.base_url

        # ── video endpoints (tried first, stop on first match) ────────
        video_endpoints = []

        # 1. /video/generations — geeknow and many third-party providers
        b1 = {"model": model, "prompt": prompt}
        if image:
            b1["image"] = image
        if ref_images:
            b1["reference_images"] = ref_images
        if ref_videos:
            b1["reference_videos"] = ref_videos
        if duration:
            b1["duration"] = duration
        video_endpoints.append(("video/generations", f"{base}/video/generations", b1))

        # 2. Kling-style /videos/image2video or /videos/text2video
        if is_i2v:
            b2 = {"model_name": model, "prompt": prompt, "duration": duration}
            if image:
                b2["image"] = image
            if ref_images:
                b2["reference_images"] = ref_images
            if ref_videos:
                b2["reference_videos"] = ref_videos
            b2b = {"model": model, "prompt": prompt, "duration": duration}
            if image:
                b2b["image"] = image
            if ref_images:
                b2b["reference_images"] = ref_images
            if ref_videos:
                b2b["reference_videos"] = ref_videos
            video_endpoints.append(("videos/image2video", f"{base}/videos/image2video", b2))
            video_endpoints.append(("videos/image2video(v2)", f"{base}/videos/image2video", b2b))
        else:
            b2 = {"model_name": model, "prompt": prompt, "duration": duration}
            b2b = {"model": model, "prompt": prompt, "duration": duration}
            video_endpoints.append(("videos/text2video", f"{base}/videos/text2video", b2))
            video_endpoints.append(("videos/text2video(v2)", f"{base}/videos/text2video", b2b))

        # 3. /chat/completions — multimodal chat-based
        messages = [{"role": "user", "content": []}]
        # Add reference images as image_url content parts
        if image:
            messages[0]["content"].append({
                "type": "image_url",
                "image_url": {"url": image, "detail": "high"},
            })
        for ref_img in ref_images:
            messages[0]["content"].append({
                "type": "image_url",
                "image_url": {"url": ref_img, "detail": "high"},
            })
        text_content = prompt
        if duration:
            text_content = f"Generate a {duration}-second video. {text_content}"
        messages[0]["content"].append({"type": "text", "text": text_content})
        b3 = {"model": model, "messages": messages, "max_tokens": 4096}
        video_endpoints.append(("chat/completions", f"{base}/chat/completions", b3))

        # Try video-specific endpoints first
        for label, url, body in video_endpoints:
            logger.info(f"[OpenAI Video] Trying {label}: {url}")
            logger.info(f"[OpenAI Video] Body keys: {list(body.keys())}, has_ref_images: {'reference_images' in body}, single_image: {'image' in body}")
            try:
                response_data = self._try_post(url, body)
                if response_data is None:
                    continue

                logger.info(f"[OpenAI Video] {label} responded: "
                            f"keys={list(response_data.keys()) if isinstance(response_data, dict) else '?'}")

                # Check for immediate video_url
                video_url = self._extract_video_url(response_data)
                if video_url:
                    logger.info(f"[OpenAI Video] Got video_url from {label}")
                    return video_url

                # Check for async task_id → poll
                task_id = self._extract_task_id(response_data)
                if task_id:
                    logger.info(f"[OpenAI Video] Got task_id={task_id} from {label}, polling...")
                    video_url = self._poll_for_video(task_id)
                    if video_url:
                        logger.info(f"[OpenAI Video] Poll complete from {label}")
                        return video_url
                    # Poll returned None = still processing? This shouldn't happen
                    # since _poll_for_video either returns URL or raises.
                    # But if it does, don't fall through to image endpoints.

                # Responded 200 but no recognizable video_url or task_id
                logger.warning(
                    f"[OpenAI Video] {label} returned 200 but no video_url/task_id. "
                    f"First 200 chars: {str(response_data)[:200]}"
                )

            except requests.HTTPError as e:
                status = e.response.status_code if e.response is not None else "?"
                if status == 404:
                    continue
                # Non-404 errors: the endpoint exists but rejected our request.
                # Surface the real error instead of falling through to "no endpoint found".
                body = ""
                try:
                    body = e.response.text[:500] if e.response is not None else ""
                except Exception:
                    pass
                logger.error(f"[OpenAI Video] {label} HTTP {status}: {body}")
                raise RuntimeError(
                    f"Video generation failed at {label} (HTTP {status}): {body}"
                ) from e
            except RuntimeError:
                raise
            except Exception as e:
                logger.warning(f"[OpenAI Video] {label} error: {e}")

        # ── fallback: images/generations (only if nothing else worked) ─
        b_img = {"model": model, "prompt": prompt, "n": 1}
        if image:
            b_img["image"] = image
        try:
            response_data = self._try_post(f"{base}/images/generations", b_img)
            if response_data:
                video_url = self._extract_video_url(response_data)
                if video_url:
                    # WARNING: this might be an image, not a video
                    logger.warning(
                        "[OpenAI Video] Falling back to /images/generations — "
                        "this may produce an image instead of video"
                    )
                    return video_url
        except Exception:
            pass

        raise RuntimeError(
            f"No compatible video endpoint found at {base}. "
            f"Tried: /video/generations, /videos/text2video, "
            f"/videos/image2video, /chat/completions, /images/generations."
        )

    # ── download ──────────────────────────────────────────────────────

    def _download_video(self, url: str, output_path: str):
        logger.info(f"Downloading video to {output_path}...")
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        session = requests.Session()
        retry = Retry(connect=3, backoff_factor=0.5)
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        temp_path = output_path + ".tmp"
        try:
            resp = session.get(url, stream=True, timeout=300)
            resp.raise_for_status()
            with open(temp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            os.rename(temp_path, output_path)
            logger.info("Download complete.")
        except Exception as e:
            logger.error(f"Failed to download video: {e}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise

    # ── public API ────────────────────────────────────────────────────

    def generate(
        self,
        prompt: str,
        output_path: str,
        img_url: Optional[str] = None,
        img_path: Optional[str] = None,
        model_name: Optional[str] = None,
        duration: int = 8,
        audio_url: Optional[str] = None,
        audio: bool = False,
        **kwargs,
    ) -> Tuple[str, float]:
        model = model_name or self.model_name
        if not model:
            raise ValueError(
                "VIDEO_MODEL not configured."
            )

        resolved_image = self._resolve_image_input(img_url, img_path)
        
        # Extract reference images for R2V mode
        ref_image_urls = kwargs.get('ref_image_urls', []) or []
        ref_video_urls = kwargs.get('ref_video_urls', []) or []
        
        # Normalize duration to supported values (common: 4, 6, 8 for Veo etc.)
        valid_durations = [4, 6, 8]
        if duration not in valid_durations:
            closest = min(valid_durations, key=lambda x: abs(x - duration))
            logger.info(
                f"Duration {duration}s not in supported {valid_durations}, "
                f"rounding to {closest}s"
            )
            duration = closest

        logger.info(
            f"OpenAI Video: model={model}, "
            f"has_single_image={resolved_image is not None}, "
            f"ref_images={len(ref_image_urls)}, ref_videos={len(ref_video_urls)}, "
            f"duration={duration}"
        )
        logger.info(f"Prompt: {prompt[:200]}")

        op_id = enter_operation("video", detail=prompt[:200], model=model)
        api_start_time = time.time()

        try:
            video_url = self._submit_and_poll(
                model=model,
                prompt=prompt,
                image=resolved_image,
                duration=duration,
                ref_image_urls=ref_image_urls,
                ref_video_urls=ref_video_urls,
            )

            if not video_url:
                raise RuntimeError("No video_url returned")

            self._download_video(video_url, output_path)
            api_duration = time.time() - api_start_time

            update_operation(
                op_id, "success",
                detail="Video generated",
                duration_ms=api_duration * 1000,
                output_path=output_path[:200],
            )
            return output_path, api_duration

        except Exception as e:
            import traceback
            logger.error(f"OpenAI Video generation failed: {e}")
            logger.error(traceback.format_exc())
            update_operation(
                op_id, "error",
                detail=f"Error: {str(e)[:200]}",
                duration_ms=(time.time() - api_start_time) * 1000,
            )
            raise
