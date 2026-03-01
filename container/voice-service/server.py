"""
Voice service for Stingyclaw — powered by LFM2.5-Audio-1.5B (GGUF, CPU).

One model handles both:
  ASR:  POST /transcribe  — audio bytes → {"text": "..."}
  TTS:  POST /synthesize  — {"text": "..."} → OGG audio bytes
  GET   /health           — liveness check

Model: LiquidAI/LFM2.5-Audio-1.5B
  - GGUF backbone (llama-cpp-python) for CPU-efficient LM inference
  - FastConformer audio encoder + Mimi detokenizer for audio I/O
  - Single model, no separate Whisper or TTS component needed
"""

import io
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional

import soundfile as sf
import torch
import torchaudio
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

HF_REPO = os.environ.get("LFM_REPO", "LiquidAI/LFM2.5-Audio-1.5B")
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
# Use GGUF quantized model for CPU — Q4_K_M is a good balance of size/quality
# Override with LFM_GGUF_FILE env var if you want a different quant
GGUF_FILE = os.environ.get("LFM_GGUF_FILE", None)  # None = auto-detect

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Stingyclaw Voice Service (LFM2.5-Audio)")

_model = None
_processor = None
_model_lock = threading.Lock()


def get_model():
    global _model, _processor
    if _model is None:
        with _model_lock:
            if _model is None:
                from liquid_audio import LFM2AudioModel, LFM2AudioProcessor

                print(f"[voice] Loading LFM2.5-Audio from {HF_REPO}...", flush=True)
                cache_dir = str(MODELS_DIR / "lfm2-audio")

                _processor = LFM2AudioProcessor.from_pretrained(
                    HF_REPO,
                    cache_dir=cache_dir,
                ).eval()

                load_kwargs: dict = {
                    "cache_dir": cache_dir,
                }
                # Load GGUF if specified or auto-detected
                if GGUF_FILE:
                    load_kwargs["gguf_file"] = GGUF_FILE
                    print(f"[voice] Using GGUF: {GGUF_FILE}", flush=True)

                _model = LFM2AudioModel.from_pretrained(
                    HF_REPO,
                    **load_kwargs,
                ).eval()

                print("[voice] LFM2.5-Audio ready.", flush=True)
    return _model, _processor


# ── Audio helpers ──────────────────────────────────────────────────────────────


def bytes_to_tensor(audio_bytes: bytes, filename: str = "audio.ogg") -> tuple[torch.Tensor, int]:
    """Convert raw audio bytes to (waveform_tensor, sample_rate)."""
    suffix = Path(filename).suffix or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name
    try:
        wav, sr = torchaudio.load(tmp_path)
        return wav, sr
    finally:
        os.unlink(tmp_path)


def tensor_to_ogg(waveform: torch.Tensor, sample_rate: int = 24000) -> bytes:
    """Convert waveform tensor to OGG Opus bytes."""
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
        tmp_path = f.name
    try:
        torchaudio.save(tmp_path, waveform.cpu(), sample_rate, format="ogg")
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(tmp_path)


# ── Routes ─────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"status": "ok", "model": HF_REPO}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """Transcribe an audio file to text using LFM2.5-Audio ASR."""
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio file")

    model, processor = get_model()

    try:
        from liquid_audio import ChatState, LFMModality

        wav, sr = bytes_to_tensor(data, audio.filename or "audio.ogg")

        chat = ChatState(processor)
        chat.new_turn("system")
        chat.add_text("Transcribe the following audio to text. Output only the transcript, nothing else.")
        chat.end_turn()
        chat.new_turn("user")
        chat.add_audio(wav, sr)
        chat.end_turn()
        chat.new_turn("assistant")

        text_tokens: list[torch.Tensor] = []
        with torch.no_grad():
            for t in model.generate_sequential(**chat, max_new_tokens=512):
                if t.numel() == 1:  # text token
                    text_tokens.append(t)

        transcript = processor.text.decode(torch.stack(text_tokens, dim=1)) if text_tokens else ""
        return {"text": transcript.strip()}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SynthRequest(BaseModel):
    text: str
    voice: Optional[str] = None  # reserved for future voice selection


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
    """Synthesize speech from text using LFM2.5-Audio TTS. Returns OGG audio."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty text")

    model, processor = get_model()

    try:
        from liquid_audio import ChatState, LFMModality

        chat = ChatState(processor)
        chat.new_turn("system")
        chat.add_text("Respond with audio only.")
        chat.end_turn()
        chat.new_turn("user")
        chat.add_text(req.text)
        chat.end_turn()
        chat.new_turn("assistant")

        audio_tokens: list[torch.Tensor] = []
        with torch.no_grad():
            for t in model.generate_sequential(**chat, max_new_tokens=2048):
                if t.numel() > 1:  # audio token (multi-dim)
                    audio_tokens.append(t)

        if not audio_tokens:
            raise HTTPException(status_code=500, detail="Model produced no audio output")

        # Last token is end-of-audio sentinel — drop it
        audio_codes = torch.stack(audio_tokens[:-1], dim=1).unsqueeze(0)
        waveform = processor.decode(audio_codes)  # 24kHz mono

        ogg_bytes = tensor_to_ogg(waveform, sample_rate=24000)
        return Response(content=ogg_bytes, media_type="audio/ogg")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
