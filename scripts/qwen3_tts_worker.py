#!/usr/bin/env python3
"""JSON-lines worker for the isolated qwen-tts Python 3.12 environment."""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import traceback


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--model", required=True); args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        model = Qwen3TTSModel.from_pretrained(
            args.model, device_map=device, dtype=torch.float32,
            attn_implementation="eager",
        )
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                wavs, sample_rate = model.generate_custom_voice(
                    text=request["text"], language=request.get("language", "Auto"),
                    speaker=request.get("speaker", "Uncle_Fu"),
                    instruct=request.get("instruct") or None,
                )
            output = request["output_path"]; os.makedirs(os.path.dirname(output), exist_ok=True)
            output_format = "MP3" if output.lower().endswith(".mp3") else "WAV"
            sf.write(output, wavs[0], sample_rate, format=output_format)
            response = {"ok": True, "id": request["id"], "sample_rate": sample_rate}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            response = {"ok": False, "id": request.get("id"), "error": str(exc)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
