#!/bin/sh
set -eu

ROOT="${HOME}/.lumen-x/qwen3-tts"
UV="${HOME}/.local/bin/uv"
mkdir -p "${ROOT}"
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv into ~/.local/bin ..."
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="${HOME}/.local/bin" sh
fi
"${UV}" python install 3.12
if [ ! -x "${ROOT}/.venv/bin/python" ]; then
  "${UV}" venv --python 3.12 "${ROOT}/.venv"
fi
"${UV}" pip install --python "${ROOT}/.venv/bin/python" -U qwen-tts soundfile modelscope
MODEL_DIR="${ROOT}/models/Qwen3-TTS-12Hz-0.6B-CustomVoice"
if [ ! -f "${MODEL_DIR}/model.safetensors" ] || [ ! -f "${MODEL_DIR}/speech_tokenizer/model.safetensors" ]; then
  mkdir -p "${MODEL_DIR}"
  "${ROOT}/.venv/bin/python" -m modelscope.cli.cli download \
    --model Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice \
    --local_dir "${MODEL_DIR}"
fi
echo "Local Qwen3-TTS runtime ready: ${ROOT}/.venv/bin/python"
echo "Local Qwen3-TTS model ready: ${MODEL_DIR}"
python3 scripts/prewarm_local_qwen3_tts.py
