# Voice service: LFM2.5-Audio-1.5B GGUF (llama-liquid-audio-cli, CPU)
# No PyTorch — uses GGUF runner binary. Model downloaded at first run.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY download-gguf.sh warmup.sh server.py ./
RUN chmod +x download-gguf.sh warmup.sh

VOLUME ["/models"]
ENV MODELS_DIR=/models

EXPOSE 8001

# Download model on first run, warm up (pre-load model), then start server
ENTRYPOINT ["/bin/sh", "-c", "MODELS_DIR=/models /app/download-gguf.sh && /app/warmup.sh 2>/dev/null || true && exec uvicorn server:app --host 0.0.0.0 --port 8001 --workers 1"]
