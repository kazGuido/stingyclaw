"""
Voice service for Stingyclaw.

ASR:  POST /transcribe  — accepts OGG/WebM/WAV audio, returns {"text": "..."}
TTS:  POST /synthesize  — accepts {"text": "..."}, returns OGG Opus audio
      Uses Qwen3-TTS (LLM-based) for natural-sounding speech.
      Query param ?voice=Ryan or speaker name (Ryan, Aiden, Vivian, Serena, etc.)
GET   /health           — liveness check
GET   /voices           — list available speakers
"""

import io
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
TTS_MODEL = os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
DEFAULT_SPEAKER = os.environ.get("DEFAULT_SPEAKER", "Ryan")

# Qwen3-TTS CustomVoice speakers (English-friendly: Ryan, Aiden)
SPEAKERS = ["Ryan", "Aiden", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ono_Anna", "Sohee"]

# ── App ────────────────────────────────────────────────────────────────────

app = FastAPI(title="Stingyclaw Voice Service")

# Lazy-loaded models (thread-safe init)
_whisper: Optional[WhisperModel] = None
_whisper_lock = threading.Lock()
_tts_model = None
_tts_lock = threading.Lock()


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


def get_tts():
    """Lazy-load Qwen3-TTS model. Uses CPU by default; set CUDA_VISIBLE_DEVICES for GPU."""
    global _tts_model
    if _tts_model is None:
        with _tts_lock:
            if _tts_model is None:
                import torch
                from qwen_tts import Qwen3TTSModel

                print(f"[voice] Loading Qwen3-TTS ({TTS_MODEL})...", flush=True)
                device = "cuda:0" if torch.cuda.is_available() else "cpu"
                dtype = torch.bfloat16 if device != "cpu" else torch.float32
                load_kwargs = {
                    "device_map": device,
                    "torch_dtype": dtype,
                    "cache_dir": str(MODELS_DIR / "qwen-tts"),
                }
                if device != "cpu":
                    load_kwargs["attn_implementation"] = "flash_attention_2"

                _tts_model = Qwen3TTSModel.from_pretrained(TTS_MODEL, **load_kwargs)
                print(f"[voice] Qwen3-TTS ready on {device}.", flush=True)
    return _tts_model


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "status": "ok",
        "whisper_model": WHISPER_MODEL_SIZE,
        "tts_model": TTS_MODEL,
    }


@app.get("/voices")
def voices():
    return {"speakers": SPEAKERS, "default": DEFAULT_SPEAKER}


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
            language=None,
            vad_filter=True,
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
    """Convert text to speech via Qwen3-TTS. Returns OGG Opus (default) or WAV."""
    speaker = (req.voice or DEFAULT_SPEAKER).strip()
    if speaker not in SPEAKERS:
        speaker = DEFAULT_SPEAKER

    model = get_tts()
    wavs, sr = model.generate_custom_voice(
        text=req.text,
        language="Auto",
        speaker=speaker,
        instruct=None,
    )

    # wavs is list of numpy arrays, sr is sample rate (e.g. 24000)
    import numpy as np
    import soundfile as sf

    wav = wavs[0] if isinstance(wavs[0], np.ndarray) else np.array(wavs[0])

    if format == "wav":
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV")
        buf.seek(0)
        return Response(content=buf.read(), media_type="audio/wav")

    # Default: OGG Opus for WhatsApp PTT
    # soundfile doesn't write OGG/Opus directly; use ffmpeg
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        sf.write(f.name, wav, sr)
        wav_path = f.name

    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", wav_path,
                "-c:a", "libopus", "-b:a", "32k",
                "-f", "ogg", "pipe:1",
            ],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"OGG conversion failed: {result.stderr.decode()[:200]}",
            )
        return Response(content=result.stdout, media_type="audio/ogg")
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass
