# Voice service: LFM2.5-Audio-1.5B (GGUF, CPU)
# One model handles both ASR (transcription) and TTS (synthesis).
# GGUF backbone via llama-cpp-python; audio codec via PyTorch (CPU only).
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg cmake build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch + torchaudio from same index (must match to avoid .so mismatch)
ARG TORCH_INDEX="https://download.pytorch.org/whl/cpu"
RUN pip install --no-cache-dir torch torchaudio --index-url "${TORCH_INDEX}"

# llama-cpp-python — CPU build — for GGUF backbone inference
RUN pip install --no-cache-dir llama-cpp-python

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./

# Model weights downloaded on first request; persist them via volume
VOLUME ["/models"]

EXPOSE 8001

ENTRYPOINT ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
