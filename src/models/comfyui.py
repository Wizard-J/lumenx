"""
ComfyUI Image/Video Generation Adapter.

Connects to a remote ComfyUI server and executes user-uploaded workflows
for text-to-image, image-to-image, text-to-video, and image-to-video.

Workflow files live in output/workflows/{t2i,i2i,t2v,i2v}.json and use
{{placeholder}} syntax for dynamic parameter injection.

Configuration:
  COMFYUI_BASE_URL     — ComfyUI server URL (default http://localhost:8188)
  COMFYUI_API_KEY      — Optional API key for authenticated instances
  IMAGE_PROVIDER       — set to "comfyui" to route image gen to ComfyUI
  VIDEO_PROVIDER       — set to "comfyui" to route video gen to ComfyUI
"""

import os
import re
import json
import time
import uuid
import base64
import mimetypes
import logging
from typing import Tuple, Optional, Dict, Any, List
from urllib.parse import urljoin
from pathlib import Path
from copy import deepcopy

import requests

from .image import ImageGenModel
from .base import VideoGenModel
from ..utils import get_logger
from ..utils.op_logger import enter_operation, update_operation
import json

logger = get_logger(__name__)


def _get_setting(*keys: str, default: str = "") -> str:
    for key in keys:
        val = os.environ.get(key, "")
        if val:
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            return val
    return default



# ── Blank Placeholder Image ─────────────────────────────────────────

_BLANK_PNG: Optional[bytes] = None

def _blank_image_bytes() -> bytes:
    """Return a minimal 1×1 black PNG as placeholder for unused inputs."""
    global _BLANK_PNG
    if _BLANK_PNG is None:
        import struct, zlib
        def chunk(ctype: bytes, data: bytes) -> bytes:
            c = ctype + data
            return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        raw = b'\x00'  # single black pixel (R=0,G=0,B=0)
        def filter_none(scanline: bytes) -> bytes:
            return b'\x00' + scanline
        filtered = filter_none(raw)
        compressed = zlib.compress(filtered)
        _BLANK_PNG = (
            b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', compressed) +
            chunk(b'IEND', b'')
        )
    return _BLANK_PNG

# ── Workflow Loader ─────────────────────────────────────────────────

def _load_workflow(mode: str) -> dict:
    """Load a user-uploaded workflow from output/workflows/{mode}.json."""
    path = Path("output/workflows") / f"{mode}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"No workflow found for mode '{mode}'. "
            f"Upload a workflow JSON via Settings → ComfyUI Provider."
        )
    with open(path) as f:
        return json.load(f)


def _inject_params(workflow: dict, params: Dict[str, Any]) -> dict:
    """Deep-replace {{placeholder}} strings in a workflow dict with actual values.

    Supported placeholders:
      {{prompt}}           — positive prompt text
      {{negative_prompt}}  — negative prompt text
      {{width}}            — image width (int)
      {{height}}           — image height (int)
      {{seed}}             — random seed (int, -1 = random)
      {{steps}}            — sampling steps (int)
      {{cfg}}              — CFG scale (float)
      {{input_image}}      — uploaded image filename in ComfyUI (single ref, legacy)
      {{input_image_N}}    — N-th reference image (1-indexed: input_image_1, input_image_2, …)
    """
    def _replace(value):
        if isinstance(value, str):
            # Replace known placeholders
            for key, val in params.items():
                placeholder = "{{" + key + "}}"
                if placeholder in value:
                    # If the value IS exactly the placeholder, replace with typed value
                    if value.strip() == placeholder:
                        return val
                    # Otherwise string-replace inside the text
                    value = value.replace(placeholder, str(val))
            return value
        elif isinstance(value, dict):
            return {k: _replace(v) for k, v in value.items()}
        elif isinstance(value, list):
            return [_replace(v) for v in value]
        else:
            return value

    return _replace(deepcopy(workflow))


# ── ComfyUI HTTP Client ─────────────────────────────────────────────

class ComfyUIClient:
    """Low-level ComfyUI API client."""

    def __init__(self, base_url: str, api_key: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._session = requests.Session()
        if api_key:
            self._session.headers["Authorization"] = f"Bearer {api_key}"

    def _url(self, path: str) -> str:
        return urljoin(self.base_url + "/", path.lstrip("/"))

    def queue_prompt(self, prompt_workflow: dict) -> str:
        """Submit a workflow and return the prompt_id."""
        resp = self._session.post(
            self._url("/prompt"),
            json={"prompt": prompt_workflow},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"No prompt_id in response: {data}")
        
        # Check for node errors reported at submission time
        node_errors = data.get("node_errors", {})
        if node_errors:
            for nid, err_info in node_errors.items():
                errors = err_info.get("errors", [])
                for e in errors:
                    logger.error(f"[ComfyUI] Node {nid} error: {e.get('message', str(e))} - {e.get('details', '')}")
        
        logger.info(f"[ComfyUI] Prompt queued: {prompt_id}")
        return prompt_id

    def get_history(self, prompt_id: str) -> dict:
        """Get execution history for a prompt."""
        resp = self._session.get(
            self._url(f"/history/{prompt_id}"),
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def get_global_history(self) -> dict:
        """Fetch global /history endpoint (all completed prompts)."""
        resp = self._session.get(self._url("/history"), timeout=15)
        resp.raise_for_status()
        return resp.json()

    def poll_until_done(
        self, prompt_id: str, timeout: int = 600, interval: float = 3.0
    ) -> dict:
        """Poll global /history until the prompt completes.

        Uses global /history because some ComfyUI reverse-proxy setups
        don't populate the per-prompt /history/{prompt_id} endpoint.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                global_history = self.get_global_history()
            except Exception:
                time.sleep(interval)
                continue

            if prompt_id in global_history:
                entry = global_history[prompt_id]
                status = entry.get("status", {})
                logger.info(f"[ComfyUI] Found in history: completed={status.get('completed')}, outputs={list(entry.get('outputs',{}).keys())}")
                if status.get("completed", False):
                    # Re-fetch after a short delay for async output writes
                    time.sleep(1.5)
                    try:
                        global_history2 = self.get_global_history()
                        if prompt_id in global_history2:
                            entry2 = global_history2[prompt_id]
                            logger.info(f"[ComfyUI] Re-fetch outputs: {list(entry2.get('outputs',{}).keys())}")
                            outputs2 = entry2.get("outputs", {})
                            if outputs2:
                                logger.info("[ComfyUI] Got outputs from global /history")
                                return entry2
                    except Exception as e:
                        logger.warning(f"[ComfyUI] Re-fetch failed: {e}")
                    return entry
                if status.get("status_str") == "error":
                    # Check for error messages
                    messages = status.get("messages", [])
                    error_details = ""
                    for msg in messages:
                        if isinstance(msg, list) and len(msg) >= 2:
                            if msg[0] == "execution_error":
                                error_details += str(msg[1])[:300]
                    raise RuntimeError(
                        f"ComfyUI execution failed. "
                        f"Messages: {error_details if error_details else json.dumps(messages[-2:] if len(messages)>=2 else messages, default=str)[:300]}"
                    )
            time.sleep(interval)
        raise TimeoutError(f"ComfyUI prompt {prompt_id} timed out after {timeout}s")

    def upload_image(self, image_path: str, subfolder: str = "") -> dict:
        """Upload an image to ComfyUI and return filename info."""
        with open(image_path, "rb") as f:
            files = {"image": (os.path.basename(image_path), f, "image/png")}
            data = {}
            if subfolder:
                data["subfolder"] = subfolder
            resp = self._session.post(
                self._url("/upload/image"),
                files=files,
                data=data,
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json()

    def download_output(
        self, filename: str, subfolder: str = "", output_type: str = "output"
    ) -> bytes:
        """Download a generated output file from ComfyUI."""
        params = {"filename": filename, "type": output_type}
        if subfolder:
            params["subfolder"] = subfolder
        resp = self._session.get(
            self._url("/view"),
            params=params,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.content


def _extract_output_media(history_entry: dict) -> Optional[dict]:
    """Extract the first output (image or video) info from a history entry."""
    outputs = history_entry.get("outputs", {})
    for node_id, node_output in outputs.items():
        # Check for videos (gifs from VHS nodes, mp4/webm etc.)
        # ComfyUI VHS_VideoCombine stores output under "gifs" key
        gifs = node_output.get("gifs", [])
        if gifs:
            g = gifs[0]
            return {
                "type": "video",
                "filename": g["filename"],
                "subfolder": g.get("subfolder", ""),
                "output_type": g.get("type", "output"),
            }
        # Check for images
        images = node_output.get("images", [])
        if images:
            img = images[0]
            return {
                "type": "image",
                "filename": img["filename"],
                "subfolder": img.get("subfolder", ""),
                "output_type": img.get("type", "output"),
            }
    return None



MAX_REF_IMAGES = 9  # practical upper bound for ComfyUI workflows

def _collect_all_refs(
    ref_image_path: Optional[str] = None,
    ref_image_paths: Optional[List[str]] = None,
) -> List[str]:
    """Merge single + list ref paths, de-duplicate, return ordered list."""
    all_refs: List[str] = []
    if ref_image_path:
        all_refs.append(ref_image_path)
    if ref_image_paths:
        all_refs.extend(ref_image_paths)
    # de-duplicate while preserving order
    seen = set()
    ordered = []
    for r in all_refs:
        if r and r not in seen:
            seen.add(r)
            ordered.append(r)
    return ordered


def _upload_ref_images(
    client: "ComfyUIClient",
    ref_paths: List[str],
    mode: str,
) -> Dict[str, str]:
    """Upload up to MAX_REF_IMAGES images to ComfyUI and return param dict.

    Populates ``input_image_1`` through ``input_image_N``. Slots without a
    corresponding reference image are filled with a blank placeholder PNG
    so ComfyUI LoadImage nodes always pass validation.
    """
    params: Dict[str, str] = {}
    blank_data = _blank_image_bytes()

    # Create temp placeholder if we don't have enough refs
    blank_path = None
    needs_blank = len(ref_paths) < MAX_REF_IMAGES
    if needs_blank:
        blank_dir = os.path.join("output", "comfyui_temp")
        os.makedirs(blank_dir, exist_ok=True)
        blank_path = os.path.join(blank_dir, "_blank_placeholder.png")
        if not os.path.exists(blank_path):
            with open(blank_path, "wb") as bf:
                bf.write(blank_data)

    for i in range(1, MAX_REF_IMAGES + 1):
        key = f"input_image_{i}"
        # Use real ref if available, otherwise blank placeholder
        if i <= len(ref_paths) and ref_paths[i - 1] and os.path.exists(ref_paths[i - 1]):
            try:
                uploaded = client.upload_image(ref_paths[i - 1])
                params[key] = uploaded.get("name", os.path.basename(ref_paths[i - 1]))
                logger.info(f"[ComfyUI] {mode} ref {i}/{len(ref_paths)}: {params[key]}")
            except Exception as e:
                logger.warning(f"[ComfyUI] Failed to upload ref {i}: {e}, using placeholder")
                if blank_path:
                    uploaded = client.upload_image(blank_path)
                    params[key] = uploaded.get("name", os.path.basename(blank_path))
        elif blank_path:
            uploaded = client.upload_image(blank_path)
            params[key] = uploaded.get("name", os.path.basename(blank_path))
        else:
            params[key] = ""

    # Backward compat: set legacy "input_image" to the first one
    if len(ref_paths) >= 1:
        params["input_image"] = params.get("input_image_1", "")

    return params

# ── Image Generation Model ──────────────────────────────────────────

class ComfyUIImageModel(ImageGenModel):
    """ComfyUI-based image generation using user-uploaded workflows."""

    def __init__(self, config):
        super().__init__(config)
        self.params = config.get("params", {})
        self._client: Optional[ComfyUIClient] = None

    @property
    def base_url(self) -> str:
        return _get_setting("COMFYUI_BASE_URL", default="http://localhost:8188")

    @property
    def api_key(self) -> str:
        return _get_setting("COMFYUI_API_KEY", default="")

    def _get_client(self) -> ComfyUIClient:
        if self._client is None:
            self._client = ComfyUIClient(self.base_url, self.api_key)
        return self._client

    def generate(
        self,
        prompt: str,
        output_path: str,
        ref_image_path: Optional[str] = None,
        ref_image_paths: Optional[List[str]] = None,
        model_name: Optional[str] = None,
        **kwargs,
    ) -> Tuple[str, float]:
        """Generate image via user-uploaded ComfyUI workflow.

        Loads output/workflows/i2i.json if reference images are present,
        otherwise output/workflows/t2i.json.
        """
        negative_prompt = kwargs.get("negative_prompt", "")
        size = kwargs.get("size", "1024*1024")
        try:
            w_str, h_str = size.split("*")
            width, height = int(w_str), int(h_str)
        except (ValueError, AttributeError):
            width, height = 1024, 1024

        seed = kwargs.get("seed", -1)
        if seed == -1 or seed == 0:
            seed = int(time.time() * 1000) % (2**32)
        steps = kwargs.get("steps", 20)
        cfg = kwargs.get("cfg_scale", 7.0)

        has_ref = bool(ref_image_path or ref_image_paths)
        mode = "i2i" if has_ref else "t2i"

        logger.info(f"ComfyUI Image ({mode}): prompt={prompt[:100]}, size={width}x{height}")
        op_id = enter_operation("image", detail=prompt[:200], model="comfyui")
        api_start_time = time.time()

        try:
            client = self._get_client()

            # Load and inject workflow
            workflow = _load_workflow(mode)
            params = {
                "prompt": prompt,
                "negative_prompt": negative_prompt or "low quality, blurry",
                "width": width,
                "height": height,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
            }

            # If I2I with reference images, upload the first one
            ref_path = ref_image_path or (ref_image_paths[0] if ref_image_paths else None)
            if ref_path and os.path.exists(ref_path):
                uploaded = client.upload_image(ref_path)
                params["input_image"] = uploaded.get("name", os.path.basename(ref_path))
                logger.info(f"[ComfyUI] Uploaded ref image: {params['input_image']}")

            workflow = _inject_params(workflow, params)

            # Submit and poll
            prompt_id = client.queue_prompt(workflow)
            history_entry = client.poll_until_done(prompt_id)

            # Extract and download output
            media = _extract_output_media(history_entry)
            if not media:
                raise RuntimeError("No output found in ComfyUI response")
            if media["type"] != "image":
                raise RuntimeError(f"Expected image output, got {media['type']}")

            img_data = client.download_output(
                media["filename"], media["subfolder"], media["output_type"]
            )
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(img_data)

            api_duration = time.time() - api_start_time
            update_operation(
                op_id, "success",
                detail=f"ComfyUI: {media['filename']}",
                duration_ms=api_duration * 1000,
            )
            return output_path, api_duration

        except Exception as e:
            import traceback
            logger.error(f"ComfyUI Image failed: {e}")
            logger.error(traceback.format_exc())
            update_operation(
                op_id, "error",
                detail=f"Error: {str(e)[:200]}",
                duration_ms=(time.time() - api_start_time) * 1000,
            )
            raise


# ── Video Generation Model ──────────────────────────────────────────

class ComfyUIVideoModel(VideoGenModel):
    """ComfyUI-based video generation using user-uploaded workflows."""

    def __init__(self, config):
        super().__init__(config)
        self.params = config.get("params", {})
        self._client: Optional[ComfyUIClient] = None

    @property
    def base_url(self) -> str:
        return _get_setting("COMFYUI_BASE_URL", default="http://localhost:8188")

    @property
    def api_key(self) -> str:
        return _get_setting("COMFYUI_API_KEY", default="")

    def _get_client(self) -> ComfyUIClient:
        if self._client is None:
            self._client = ComfyUIClient(self.base_url, self.api_key)
        return self._client

    def generate(
        self,
        prompt: str,
        output_path: str,
        img_url: Optional[str] = None,
        img_path: Optional[str] = None,
        duration: int = 5,
        **kwargs,
    ) -> Tuple[str, float]:
        """Generate video via user-uploaded ComfyUI workflow.

        Loads output/workflows/i2v.json if an input image is present,
        otherwise output/workflows/t2v.json.
        """
        negative_prompt = kwargs.get("negative_prompt", "")
        seed = kwargs.get("seed", -1)
        if seed == -1 or seed == 0:
            seed = int(time.time() * 1000) % (2**32)
        steps = kwargs.get("steps", 20)
        cfg = kwargs.get("cfg_scale", 7.0)
        width = kwargs.get("width", 1024)
        height = kwargs.get("height", 576)

        # R2V mode: reference images come via reference_image_urls kwarg
        ref_image_urls = kwargs.get("reference_image_urls") or kwargs.get("ref_image_urls") or []
        if not img_path and not img_url and isinstance(ref_image_urls, list) and ref_image_urls:
            img_url = ref_image_urls[0]
            logger.info(f"[ComfyUI] Using R2V reference image as input: {img_url[:80]}...")

        has_input = bool(img_path or img_url)
        mode = "i2v" if has_input else "t2v"
        logger.info(f"[ComfyUI] Mode={mode}, has_input={has_input}")

        logger.info(f"ComfyUI Video ({mode}): prompt={prompt[:100]}, duration={duration}s")
        op_id = enter_operation("video", detail=prompt[:200], model="comfyui")
        api_start_time = time.time()

        try:
            client = self._get_client()

            workflow = _load_workflow(mode)

            params = {
                "prompt": prompt,
                "negative_prompt": negative_prompt or "low quality, blurry",
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "width": width,
                "height": height,
                "duration": duration,
            }

            # Multi-reference support for video (I2V mode)
            ref_paths: List[str] = []
            # Collect local paths from img_path / img_url
            if img_path and os.path.exists(img_path):
                ref_paths.append(img_path)
            elif img_url:
                if img_url.startswith("data:"):
                    _, b64 = img_url.split(",", 1)
                    tmp_path = os.path.join("output", "video_inputs", f"comfyui_input_{uuid.uuid4().hex[:8]}.png")
                    os.makedirs(os.path.dirname(tmp_path), exist_ok=True)
                    with open(tmp_path, "wb") as f:
                        f.write(base64.b64decode(b64))
                    ref_paths.append(tmp_path)
                elif img_url.startswith("http"):
                    resp = requests.get(img_url, timeout=30)
                    tmp_path = os.path.join("output", "video_inputs", f"comfyui_input_{uuid.uuid4().hex[:8]}.png")
                    os.makedirs(os.path.dirname(tmp_path), exist_ok=True)
                    with open(tmp_path, "wb") as f:
                        f.write(resp.content)
                    ref_paths.append(tmp_path)
                elif os.path.exists(os.path.join("output", img_url)):
                    ref_paths.append(os.path.join("output", img_url))

            # Also collect R2V reference_image_urls
            ref_image_urls = kwargs.get("reference_image_urls") or kwargs.get("ref_image_urls") or []
            for riu in ref_image_urls:
                if isinstance(riu, str):
                    if riu.startswith("http"):
                        try:
                            resp = requests.get(riu, timeout=30)
                            tmp_path = os.path.join("output", "video_inputs", f"comfyui_ref_{uuid.uuid4().hex[:8]}.png")
                            os.makedirs(os.path.dirname(tmp_path), exist_ok=True)
                            with open(tmp_path, "wb") as f:
                                f.write(resp.content)
                            ref_paths.append(tmp_path)
                        except Exception as e:
                            logger.warning(f"[ComfyUI] Failed to download ref URL {riu[:60]}: {e}")
                    elif os.path.exists(os.path.join("output", riu)):
                        ref_paths.append(os.path.join("output", riu))

            # De-duplicate
            seen = set()
            ref_paths = [p for p in ref_paths if p and not (p in seen or seen.add(p))]

            if mode == "i2v" and ref_paths:
                logger.info(f"[ComfyUI] I2V with {len(ref_paths)} reference images")
                ref_params = _upload_ref_images(client, ref_paths, "I2V")
                params.update(ref_params)

            workflow = _inject_params(workflow, params)

            prompt_id = client.queue_prompt(workflow)
            history_entry = client.poll_until_done(prompt_id, timeout=900)

            # Debug
            outputs = history_entry.get("outputs", {})
            logger.info(f"[ComfyUI] Output nodes: {list(outputs.keys())}")
            media = _extract_output_media(history_entry)
            if not media:
                raise RuntimeError("No output found in ComfyUI response")

            output_data = client.download_output(
                media["filename"], media["subfolder"], media["output_type"]
            )
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(output_data)

            api_duration = time.time() - api_start_time
            update_operation(
                op_id, "success",
                detail=f"ComfyUI: {media['filename']}",
                duration_ms=api_duration * 1000,
            )
            return output_path, api_duration

        except Exception as e:
            import traceback
            logger.error(f"ComfyUI Video failed: {e}")
            logger.error(traceback.format_exc())
            update_operation(
                op_id, "error",
                detail=f"Error: {str(e)[:200]}",
                duration_ms=(time.time() - api_start_time) * 1000,
            )
            raise
