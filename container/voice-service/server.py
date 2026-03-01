"""
Voice service — LFM2.5-Audio-1.5B
  ASR:  POST /transcribe  — audio upload → {"text": "..."}
  TTS:  POST /synthesize  — {"text":"..."} → OGG audio
  GET   /health

Model loaded once at startup, weights cached in /models via HuggingFace hub.
API follows exactly: https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B
"""

import io
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional

import torch
import torchaudio
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

HF_REPO = "LiquidAI/LFM2.5-Audio-1.5B"
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
os.environ.setdefault("HF_HOME", str(MODELS_DIR / "hf-cache"))

app = FastAPI(title="Stingyclaw Voice — LFM2.5-Audio")

_model = None
_processor = None
_lock = threading.Lock()


def get_model():
    global _model, _processor
    if _model is None:
        with _lock:
            if _model is None:
                from liquid_audio import LFM2AudioModel, LFM2AudioProcessor
                print(f"[voice] Loading {HF_REPO}...", flush=True)
                _processor = LFM2AudioProcessor.from_pretrained(HF_REPO).eval()
                _model = LFM2AudioModel.from_pretrained(HF_REPO).eval()
                print("[voice] Ready.", flush=True)
    return _model, _processor


def bytes_to_tensor(data: bytes, filename: str) -> tuple[torch.Tensor, int]:
    suffix = Path(filename).suffix or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        tmp = f.name
    try:
        wav, sr = torchaudio.load(tmp)
        return wav, sr
    finally:
        os.unlink(tmp)


def tensor_to_ogg(waveform: torch.Tensor, sr: int = 24000) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
        tmp = f.name
    try:
        torchaudio.save(tmp, waveform.cpu(), sr, format="ogg")
        return open(tmp, "rb").read()
    finally:
        os.unlink(tmp)


@app.get("/health")
def health():
    return {"status": "ok", "model": HF_REPO}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty file")

    model, processor = get_model()

    try:
        from liquid_audio import ChatState

        wav, sr = bytes_to_tensor(data, audio.filename or "audio.ogg")

        chat = ChatState(processor)
        chat.new_turn("system")
        chat.add_text("Transcribe the audio accurately. Output only the transcript text, nothing else.")
        chat.end_turn()
        chat.new_turn("user")
        chat.add_audio(wav, sr)
        chat.end_turn()
        chat.new_turn("assistant")

        text_tokens: list[torch.Tensor] = []
        with torch.no_grad():
            for t in model.generate_sequential(**chat, max_new_tokens=512):
                if t.numel() == 1:
                    text_tokens.append(t)

        transcript = ""
        if text_tokens:
            transcript = processor.text.decode(torch.stack(text_tokens, dim=1))

        return {"text": transcript.strip()}

    except Exception as e:
        raise HTTPException(500, str(e))


class SynthRequest(BaseModel):
    text: str
    voice: Optional[str] = None


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty text")

    model, processor = get_model()

    try:
        from liquid_audio import ChatState

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
                if t.numel() > 1:
                    audio_tokens.append(t)

        if not audio_tokens:
            raise HTTPException(500, "No audio generated")

        # Drop the end-of-audio sentinel (last token)
        audio_codes = torch.stack(audio_tokens[:-1], dim=1).unsqueeze(0)
        waveform = processor.decode(audio_codes)  # 24kHz

        return Response(content=tensor_to_ogg(waveform, 24000), media_type="audio/ogg")

    except Exception as e:
        raise HTTPException(500, str(e))
