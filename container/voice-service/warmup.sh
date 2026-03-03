#!/bin/bash
# Warm up the TTS model so first user request doesn't hit cold-load 500.
# Runs a minimal synthesis to pre-load; subsequent requests benefit from OS cache.
set -e
MODELS_DIR="${MODELS_DIR:-/models}"
cd "$MODELS_DIR"
CLI="$MODELS_DIR/llama-liquid-audio-cli"
CKPT="$MODELS_DIR"
if [ -x "$CLI" ] && [ -f "$CKPT/LFM2.5-Audio-1.5B-Q4_0.gguf" ]; then
  echo "[voice] Warming up model..."
  WAV=$(mktemp -u).wav
  "$CLI" -m "$CKPT/LFM2.5-Audio-1.5B-Q4_0.gguf" \
    -mm "$CKPT/mmproj-LFM2.5-Audio-1.5B-Q4_0.gguf" \
    -mv "$CKPT/vocoder-LFM2.5-Audio-1.5B-Q4_0.gguf" \
    --tts-speaker-file "$CKPT/tokenizer-LFM2.5-Audio-1.5B-Q4_0.gguf" \
    -sys "Perform TTS. Use the US male voice." \
    -p "Hi" --output "$WAV" 2>/dev/null || true
  rm -f "$WAV" 2>/dev/null || true
  echo "[voice] Warmup done."
fi
