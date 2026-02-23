FROM python:3.11-slim

# System deps: ffmpeg for audio conversion, wget for piper download
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install piper TTS binary (static build — no extra deps)
ARG PIPER_VERSION=2023.11.14-2
RUN wget -q "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
        -O /tmp/piper.tar.gz \
    && mkdir -p /usr/local/piper \
    && tar xzf /tmp/piper.tar.gz -C /usr/local/piper --strip-components=1 \
    && rm /tmp/piper.tar.gz \
    && ln -sf /usr/local/piper/piper /usr/local/bin/piper \
    && piper --help > /dev/null 2>&1 || true

WORKDIR /app

# Install Python deps
# requests is pulled in transitively by faster-whisper for model downloads,
# but we pre-bake the model into the image so it never runs at runtime.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt requests

# Pre-download whisper-small into the image so there is zero network
# dependency at runtime and requests is never imported after startup.
RUN python -c "\
from faster_whisper import WhisperModel; \
WhisperModel('small', device='cpu', compute_type='int8', download_root='/models/whisper')" \
    && echo "Whisper model cached."

COPY server.py download_models.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# /models/piper is populated by download_models.py on first entrypoint run,
# then persisted in the named volume so it survives container rebuilds.
VOLUME ["/models/piper"]

EXPOSE 8001

ENTRYPOINT ["/app/entrypoint.sh"]
