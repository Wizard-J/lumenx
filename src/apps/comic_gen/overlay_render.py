"""Pixel-accurate HUD/subtitle rendering for generated clips.

The media model always produces text-free footage.  Pillow draws transparent
RGBA layers at the clip's real dimensions and FFmpeg composites them without
re-encoding the source audio.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

HUD_BLUE = "#4A90D9"
WARNING_RED = "#D93838"


def probe_video_size(video_path: str, ffprobe: str = "ffprobe") -> Tuple[int, int]:
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", video_path],
        check=True, capture_output=True, text=True,
    )
    stream = json.loads(result.stdout)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                pass
    return ImageFont.load_default()


def _hex(value: str, alpha: int = 255) -> Tuple[int, int, int, int]:
    value = (value or "#FFFFFF").lstrip("#")
    if len(value) != 6:
        value = "FFFFFF"
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def render_hud_layer(size: Tuple[int, int], state: Dict[str, Any], payload: Dict[str, Any], output: str) -> str:
    width, height = size
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scale = max(0.65, width / 1920)
    font = _font(round(26 * scale)); small = _font(round(20 * scale)); title = _font(round(34 * scale))
    pad, gap = round(34 * scale), round(8 * scale)
    blue = _hex(HUD_BLUE); panel = _hex("#071522", 165)

    # left status panel
    health = state.get("health")
    if health is not None:
        box = (pad, pad, pad + round(310 * scale), pad + round(105 * scale))
        draw.rounded_rectangle(box, radius=round(5 * scale), fill=panel, outline=blue, width=max(1, round(2 * scale)))
        draw.text((box[0] + gap * 2, box[1] + gap), f"生命  {health}%", font=font, fill=blue)
        bx, by = box[0] + gap * 2, box[1] + round(60 * scale)
        bw = round(270 * scale)
        draw.rectangle((bx, by, bx + bw, by + round(12 * scale)), fill=_hex("#FFFFFF", 35))
        draw.rectangle((bx, by, bx + round(bw * max(0, min(100, int(health))) / 100), by + round(12 * scale)), fill=blue)

    # right day and resource panel
    day = state.get("day")
    if day is not None:
        label = f"DAY {day}"
        bbox = draw.textbbox((0, 0), label, font=title)
        draw.text((width - pad - (bbox[2] - bbox[0]), pad), label, font=title, fill=blue)
    resources = [("木材", "wood"), ("石材", "stone"), ("食物", "food"), ("金币", "gold")]
    lines = [f"{label}  {state[key]}" for label, key in resources if state.get(key) is not None]
    if lines:
        x, y = width - pad - round(265 * scale), height - pad - round((len(lines) * 34 + 24) * scale)
        draw.rounded_rectangle((x, y, width - pad, height - pad), radius=round(5 * scale), fill=panel, outline=blue)
        for index, line in enumerate(lines):
            draw.text((x + gap * 2, y + gap + index * round(34 * scale)), line, font=small, fill=blue)

    warnings = state.get("warnings") or payload.get("warnings") or []
    if warnings:
        warning = "  ·  ".join(str(item) for item in warnings)
        bbox = draw.textbbox((0, 0), warning, font=font)
        x = max(pad, (width - (bbox[2] - bbox[0])) // 2 - gap * 2)
        y = height - pad - round(80 * scale)
        draw.rounded_rectangle((x, y, width - x, y + round(48 * scale)), radius=3, fill=_hex(WARNING_RED, 215))
        draw.text((x + gap * 2, y + gap), warning, font=font, fill="white")
    achievements = state.get("achievements") or payload.get("achievements") or []
    if achievements:
        achievement = str(achievements[0])
        bbox = draw.textbbox((0, 0), achievement, font=title)
        draw.text(((width - bbox[2] + bbox[0]) // 2, round(height * .35)), achievement, font=title, fill=_hex("#E8C35A"), stroke_width=2, stroke_fill=_hex("#3A2A00"))
    image.save(output)
    return output


def render_subtitle_layer(size: Tuple[int, int], template: Dict[str, Any], output: str) -> str:
    width, height = size
    image = Image.new("RGBA", size, (0, 0, 0, 0)); draw = ImageDraw.Draw(image)
    text = str(template.get("text") or "")
    font = _font(int(template.get("font_size") or 42))
    bbox = draw.multiline_textbbox((0, 0), text, font=font, align="center", stroke_width=2)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    position = template.get("position", "bottom")
    y = round(height * .12) if position == "top" else (height - th) // 2 if position == "center" else height - th - round(height * .08)
    draw.multiline_text(((width - tw) // 2, y), text, font=font, align="center", fill=_hex(template.get("color", "#FFFFFF")), stroke_width=2, stroke_fill=_hex(template.get("stroke", "#000000")))
    image.save(output)
    return output


def overlay_video(video_path: str, output_path: str, *, hud_template: Optional[Dict[str, Any]] = None,
                  episode_state: Optional[Dict[str, Any]] = None, hud_payload: Optional[Dict[str, Any]] = None,
                  subtitle_template: Optional[Dict[str, Any]] = None, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe") -> str:
    size = probe_video_size(video_path, ffprobe)
    work = Path(output_path).with_suffix("")
    inputs, filters, current, index = [], [], "[0:v]", 1
    hud = hud_template or {}
    if hud.get("mode") in ("overlay", "featured"):
        path = f"{work}.hud.png"; render_hud_layer(size, episode_state or {}, hud_payload or {}, path); inputs += ["-loop", "1", "-i", path]
        start, end = float(hud.get("start_time", 0)), hud.get("end_time")
        enable = f"between(t,{start},{float(end)})" if end is not None else f"gte(t,{start})"
        out = f"[v{index}]"; filters.append(f"{current}[{index}:v]overlay=0:0:enable='{enable}'{out}"); current = out; index += 1
    subtitle = subtitle_template or {}
    if subtitle.get("text"):
        path = f"{work}.subtitle.png"; render_subtitle_layer(size, subtitle, path); inputs += ["-loop", "1", "-i", path]
        start, end = float(subtitle.get("start_time", 0)), subtitle.get("end_time")
        enable = f"between(t,{start},{float(end)})" if end is not None else f"gte(t,{start})"
        out = f"[v{index}]"; filters.append(f"{current}[{index}:v]overlay=0:0:enable='{enable}'{out}"); current = out; index += 1
    if not filters:
        return video_path
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    subprocess.run([ffmpeg, "-y", "-i", video_path, *inputs, "-filter_complex", ";".join(filters), "-map", current, "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", output_path], check=True)
    return output_path
