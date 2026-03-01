# Voice service: LFM2.5-Audio-1.5B (liquid-audio, CPU)
# Single model for ASR + TTS. Weights download from HuggingFace on first use.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU torch + torchaudio from the same index to avoid .so mismatch
ARG TORCH_INDEX="https://download.pytorch.org/whl/cpu"
RUN pip install --no-cache-dir torch torchaudio --index-url "${TORCH_INDEX}"

# LiquidAI's package — pip install liquid-audio as documented on the model page
RUN pip install --no-cache-dir liquid-audio

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./

VOLUME ["/models"]

EXPOSE 8001

ENTRYPOINT ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
