# Voice service: NeuTTS Air Q4-GGUF (TTS only)
# https://huggingface.co/neuphonic/neutts-air-q4-gguf
# Requires espeak-ng for phonemizer; models downloaded at first run via Hugging Face cache.

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    ffmpeg \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
# neutts (no [llama] here to avoid pulling source build)
RUN pip install --no-cache-dir -r requirements.txt
# Pre-built CPU wheel — no gcc/cmake, no compile (fast)
RUN pip install --no-cache-dir llama-cpp-python \
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu

# Reference voices: English (dave), French (juliette). If wget fails, mount /app/samples at run.
RUN mkdir -p /app/samples \
    && (wget -q -O /app/samples/dave.wav "https://github.com/neuphonic/neutts/raw/main/samples/dave.wav" && \
        wget -q -O /app/samples/dave.txt "https://raw.githubusercontent.com/neuphonic/neutts/main/samples/dave.txt") \
    || true \
    && (wget -q -O /app/samples/juliette.wav "https://github.com/neuphonic/neutts/raw/main/samples/juliette.wav" && \
        wget -q -O /app/samples/juliette.txt "https://raw.githubusercontent.com/neuphonic/neutts/main/samples/juliette.txt") \
    || true

COPY server.py ./

# Optional: pre-download models at build time (increases image size; else downloaded on first run)
# ENV HF_HOME=/models
# RUN python -c "
# from neutts import NeuTTS
# tts = NeuTTS(backbone_repo='neuphonic/neutts-air-q4-gguf', backbone_device='cpu', codec_repo='neuphonic/neucodec', codec_device='cpu')
# " 2>/dev/null || true

EXPOSE 8001

ENV HF_HOME=/models
VOLUME ["/models"]

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
