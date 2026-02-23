"""
Voice service for Stingyclaw.

ASR:  POST /transcribe  — accepts OGG/WebM/WAV audio, returns {"text": "..."}
TTS:  POST /synthesize  — accepts {"text": "..."}, returns OGG Opus audio
      Query param ?voice=en_US-amy-medium or any installed piper voice name.
GET   /health           — liveness check
GET   /voices           — list installed piper voices
"""

import io
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from faster_whisper import WhisperModel
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
PIPER_DIR = MODELS_DIR / "piper"
PIPER_BIN = "/usr/local/piper/piper"
DEFAULT_VOICE = os.environ.get("DEFAULT_VOICE", "en_US-amy-medium")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Stingyclaw Voice Service")

# Lazy-loaded Whisper model (thread-safe init)
_whisper: Optional[WhisperModel] = None
_whisper_lock = threading.Lock()


def get_whisper() -> WhisperModel:
    global _whisper
    if _whisper is None:
        with _whisper_lock:
            if _whisper is None:
                print(f"[voice] Loading whisper-{WHISPER_MODEL_SIZE}...", flush=True)
                _whisper = WhisperModel(
                    WHISPER_MODEL_SIZE,
                    device="cpu",
                    compute_type="int8",
                    download_root=str(MODELS_DIR / "whisper"),
                )
                print("[voice] Whisper ready.", flush=True)
    return _whisper


def list_piper_voices() -> list[str]:
    """Return basenames of installed piper voices (without .onnx suffix)."""
    if not PIPER_DIR.exists():
        return []
    return [p.stem for p in PIPER_DIR.glob("*.onnx")]


def piper_model_path(voice: str) -> Path:
    return PIPER_DIR / f"{voice}.onnx"


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"status": "ok", "whisper_model": WHISPER_MODEL_SIZE}


@app.get("/voices")
def voices():
    return {"voices": list_piper_voices(), "default": DEFAULT_VOICE}


class SynthRequest(BaseModel):
    text: str
    voice: Optional[str] = None


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """Transcribe an audio file (OGG/Opus, WAV, MP3, etc.) to text."""
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio file")

    suffix = Path(audio.filename or "audio.ogg").suffix or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        tmp_path = f.name

    try:
        model = get_whisper()
        segments, info = model.transcribe(
            tmp_path,
            beam_size=5,
            language=None,  # auto-detect
            vad_filter=True,  # skip silence
        )
        text = " ".join(s.text for s in segments).strip()
        return {
            "text": text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.post("/synthesize")
async def synthesize(
    req: SynthRequest,
    format: str = Query("ogg", pattern="^(ogg|wav)$"),
):
    """Convert text to speech. Returns OGG Opus (default) or WAV audio."""
    voice = req.voice or DEFAULT_VOICE
    model_path = piper_model_path(voice)

    if not model_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Voice '{voice}' not found. Available: {list_piper_voices()}",
        )

    if not Path(PIPER_BIN).exists():
        raise HTTPException(status_code=503, detail="Piper binary not found")

    # Run piper: stdin → WAV bytes on stdout
    try:
        piper_result = subprocess.run(
            [PIPER_BIN, "--model", str(model_path), "--output-raw"],
            input=req.text.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Piper TTS timed out")

    if piper_result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"Piper failed: {piper_result.stderr.decode()[:200]}",
        )

    raw_pcm = piper_result.stdout  # raw s16le PCM at 22050 Hz mono

    if format == "wav":
        # Wrap raw PCM in a proper WAV container via ffmpeg
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "s16le", "-ar", "22050", "-ac", "1", "-i", "pipe:0",
                "-f", "wav", "pipe:1",
            ],
            input=raw_pcm,
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail="WAV conversion failed")
        return Response(content=result.stdout, media_type="audio/wav")

    # Default: OGG Opus — what WhatsApp PTT expects
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "s16le", "-ar", "22050", "-ac", "1", "-i", "pipe:0",
            "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1",
        ],
        input=raw_pcm,
        capture_output=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail="OGG conversion failed")

    return Response(content=result.stdout, media_type="audio/ogg")
