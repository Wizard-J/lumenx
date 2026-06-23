"""Local Qwen3-TTS client backed by an isolated persistent worker process."""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


LOCAL_VOICES: Dict[str, Dict[str, Any]] = {
    "Vivian": {"model_id": "Vivian", "name": "Vivian · 明亮年轻女声（本地）", "gender": "Female"},
    "Serena": {"model_id": "Serena", "name": "Serena · 温柔女声（本地）", "gender": "Female"},
    "Uncle_Fu": {"model_id": "Uncle_Fu", "name": "Uncle Fu · 沉稳大叔（本地）", "gender": "Male"},
    "Dylan": {"model_id": "Dylan", "name": "Dylan · 北京男声（本地）", "gender": "Male"},
    "Eric": {"model_id": "Eric", "name": "Eric · 四川男声（本地）", "gender": "Male"},
    "Ryan": {"model_id": "Ryan", "name": "Ryan · 英语男声（本地）", "gender": "Male"},
    "Aiden": {"model_id": "Aiden", "name": "Aiden · 清晰男声（本地）", "gender": "Male"},
    "Ono_Anna": {"model_id": "Ono_Anna", "name": "Ono Anna · 日语女声（本地）", "gender": "Female"},
    "Sohee": {"model_id": "Sohee", "name": "Sohee · 韩语女声（本地）", "gender": "Female"},
}

LOCAL_PREVIEW_TEXT = "你好，欢迎使用 LumenX。这是一段本地音色试听，请选择最适合角色的声音。"


class LocalQwen3TTSProcessor:
    def __init__(self, python_path: Optional[str] = None, model_path: Optional[str] = None):
        home = Path.home() / ".lumen-x" / "qwen3-tts"
        self.python_path = os.path.expanduser(python_path or os.getenv("LOCAL_QWEN3_TTS_PYTHON") or str(home / ".venv" / "bin" / "python"))
        self.model_path = os.path.expanduser(model_path or os.getenv("LOCAL_QWEN3_TTS_MODEL") or str(home / "models" / "Qwen3-TTS-12Hz-0.6B-CustomVoice"))
        self._process: Optional[subprocess.Popen[str]] = None
        self._lock = threading.Lock()
        self._worker = str(Path(__file__).resolve().parents[2] / "scripts" / "qwen3_tts_worker.py")

    @staticmethod
    def list_voices() -> Dict[str, Dict[str, Any]]:
        return {key: {**value, "model": "local/Qwen3-TTS-12Hz-0.6B-CustomVoice", "family": "qwen3", "supports_instruction": True, "preview_text": LOCAL_PREVIEW_TEXT} for key, value in LOCAL_VOICES.items()}

    def _ensure_worker(self) -> subprocess.Popen[str]:
        if self._process and self._process.poll() is None:
            return self._process
        if not os.path.isfile(self.python_path):
            raise RuntimeError(f"本地 Qwen3-TTS 运行时未安装：{self.python_path}。请运行 scripts/setup_local_qwen3_tts.sh")
        if not os.path.isdir(self.model_path):
            raise RuntimeError(f"本地 Qwen3-TTS 模型未下载：{self.model_path}。请运行 scripts/setup_local_qwen3_tts.sh")
        self._process = subprocess.Popen(
            [self.python_path, self._worker, "--model", self.model_path],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, text=True, bufsize=1,
        )
        return self._process

    def synthesize(self, text: str, output_path: str, voice: Optional[str] = None,
                   speech_rate: float = 1.0, pitch_rate: float = 1.0, volume: int = 50,
                   instructions: Optional[str] = None, model_override: Optional[str] = None,
                   family_override: Optional[str] = None) -> Tuple[str, float, str]:
        del pitch_rate, volume, model_override, family_override
        started = time.time()
        payload = {
            "id": f"local-{time.time_ns()}", "text": text, "output_path": os.path.abspath(output_path),
            "speaker": voice or "Uncle_Fu", "language": "Auto", "instruct": instructions or "",
            "speech_rate": speech_rate,
        }
        with self._lock:
            process = self._ensure_worker()
            assert process.stdin and process.stdout
            process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n"); process.stdin.flush()
            line = process.stdout.readline()
        if not line:
            code = process.poll()
            self._process = None
            raise RuntimeError(f"本地 Qwen3-TTS worker 异常退出（code={code}）")
        response = json.loads(line)
        if not response.get("ok"):
            raise RuntimeError(response.get("error") or "本地 Qwen3-TTS 生成失败")
        return output_path, (time.time() - started) * 1000, payload["id"]

    def close(self) -> None:
        if self._process and self._process.poll() is None:
            self._process.terminate()
        self._process = None
