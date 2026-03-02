#!/bin/bash
# Download LFM2.5-Audio-1.5B GGUF model and llama-liquid-audio runner
# See: https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-GGUF

set -e
HF_REPO="LiquidAI/LFM2.5-Audio-1.5B-GGUF"
BASE="https://huggingface.co/${HF_REPO}/resolve/main"
MODELS_DIR="${MODELS_DIR:-/models}"
mkdir -p "$MODELS_DIR"
cd "$MODELS_DIR"

echo "[voice] Downloading llama-liquid-audio runner..."
wget -q "${BASE}/runners/llama-liquid-audio-ubuntu-x64.zip" -O runner.zip
unzip -o -j runner.zip -d "$MODELS_DIR"
rm runner.zip
chmod +x "$MODELS_DIR"/llama-liquid-audio-cli 2>/dev/null || true

echo "[voice] Downloading Q4_0 model files (~1.1GB total)..."
for f in LFM2.5-Audio-1.5B-Q4_0.gguf mmproj-LFM2.5-Audio-1.5B-Q4_0.gguf vocoder-LFM2.5-Audio-1.5B-Q4_0.gguf tokenizer-LFM2.5-Audio-1.5B-Q4_0.gguf; do
  if [ ! -f "$f" ]; then
    wget -q "${BASE}/${f}" -O "$f"
  fi
done

echo "[voice] GGUF model ready."
