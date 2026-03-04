# Voice service (NeuTTS) — what the build does

**First build** is slow (~5–15 min) because `neutts` pulls PyTorch and many deps. **Rebuilds** are much faster: the Dockerfile uses a pip cache mount so changing only `server.py` (or the last steps) reuses downloaded wheels.

1. **Base**: `python:3.12-slim`
2. **Apt**: `espeak-ng` (phonemizer for TTS), `ffmpeg` (WAV↔OGG), `wget`, `ca-certificates`
3. **Pip (requirements.txt)**: FastAPI, uvicorn, python-multipart, **neutts** (pulls PyTorch, transformers, phonemizer, neucodec, etc. — large).
4. **Pip (Dockerfile)**: **llama-cpp-python==0.3.2** from the CPU wheel index only (no gcc/cmake; pre-built wheel). Required by NeuTTS GGUF backends.
5. **Samples**: wget dave.wav/txt and juliette.wav/txt from neuphonic/neutts (reference voices for EN/FR).
6. **Copy**: `server.py` (FastAPI app: /health, /synthesize, /transcribe→501).
7. **Runtime**: Models (neutts-air-q4-gguf, neutts-nano-french-q8-gguf, neucodec) are downloaded on first run into `HF_HOME` (volume `/models`).

First container start loads EN + FR TTS at startup (warm); first synthesis may still trigger Hugging Face downloads if not cached.
