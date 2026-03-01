# Voice service: Whisper (ASR) + Qwen3-TTS (TTS)
# Qwen3-TTS replaces Piper for more natural-sounding speech
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch to keep image smaller (omit for GPU hosts)
ARG TORCH_INDEX="https://download.pytorch.org/whl/cpu"
RUN pip install --no-cache-dir torch --index-url "${TORCH_INDEX}" || \
    pip install --no-cache-dir torch

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt requests

# Whisper and Qwen3-TTS download on first request; volume persists them
COPY server.py ./
RUN chmod +x server.py 2>/dev/null || true

VOLUME ["/models"]

EXPOSE 8001

ENTRYPOINT ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
