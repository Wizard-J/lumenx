#!/usr/bin/env python3
"""Generate the fixed local preview clip for every bundled Qwen3 speaker."""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.audio.local_qwen3_tts import LOCAL_PREVIEW_TEXT, LOCAL_VOICES, LocalQwen3TTSProcessor


def cache_path(voice_id: str) -> Path:
    key = hashlib.md5(f"{voice_id}|{LOCAL_PREVIEW_TEXT}|1.0|1.0|50|".encode("utf-8")).hexdigest()
    return Path("output/cache/voice_preview") / f"{key}.mp3"


def main() -> None:
    processor = LocalQwen3TTSProcessor()
    try:
        for index, (voice_id, meta) in enumerate(LOCAL_VOICES.items(), 1):
            output = cache_path(voice_id)
            if output.exists() and output.stat().st_size > 0:
                print(f"[{index}/{len(LOCAL_VOICES)}] cached {voice_id}: {output}")
                continue
            print(f"[{index}/{len(LOCAL_VOICES)}] generating {voice_id} ({meta['name']}) ...", flush=True)
            processor.synthesize(LOCAL_PREVIEW_TEXT, str(output), voice=voice_id)
    finally:
        processor.close()
    print("Local Qwen3-TTS preview cache is ready.")


if __name__ == "__main__":
    main()
