"""
Voice service — LFM2.5-Audio-1.5B GGUF (llama-liquid-audio-cli)
  ASR:  POST /transcribe  — audio upload → {"text": "..."}
  TTS:  POST /synthesize  — {"text":"..."} → OGG audio
  GET   /health

Uses GGUF runner; no PyTorch. Model in /models via download-gguf.sh.
API: https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B-GGUF

Tunables (env vars):
  TTS_SPEED       Playback speed. 1.0 = natural, <1 = slower, >1 = faster (default: 1.0)
  TTS_TEMPERATURE Sampling temp. Higher = more varied/expressive (default: 0.95)
  TTS_TOP_P       Nucleus sampling (default: 0.95)
"""

import asyncio
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
CKPT = str(MODELS_DIR)
CLI = MODELS_DIR / "llama-liquid-audio-cli"

# Tunables — set via env or override here
TTS_SPEED = float(os.environ.get("TTS_SPEED", "1.0"))
TTS_TEMPERATURE = float(os.environ.get("TTS_TEMPERATURE", "0.95"))
TTS_TOP_P = float(os.environ.get("TTS_TOP_P", "0.95"))

app = FastAPI(title="Stingyclaw Voice — LFM2.5-Audio GGUF")
CLI_LOCK = asyncio.Lock()


def _cli_args():
    return [
        str(CLI),
        "-m", f"{CKPT}/LFM2.5-Audio-1.5B-Q4_0.gguf",
        "-mm", f"{CKPT}/mmproj-LFM2.5-Audio-1.5B-Q4_0.gguf",
        "-mv", f"{CKPT}/vocoder-LFM2.5-Audio-1.5B-Q4_0.gguf",
        "--tts-speaker-file", f"{CKPT}/tokenizer-LFM2.5-Audio-1.5B-Q4_0.gguf",
    ]


def _ogg_to_wav(ogg_path: Path, wav_path: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(ogg_path), "-ar", "16000", "-ac", "1", str(wav_path)],
        check=True,
        capture_output=True,
    )


def _wav_to_ogg(wav_path: Path, ogg_path: Path, speed: float | None = None) -> None:
    s = speed if speed is not None else TTS_SPEED
    filters = f"atempo={s}" if s != 1.0 else ""
    args = ["ffmpeg", "-y", "-i", str(wav_path)]
    if filters:
        args += ["-filter:a", filters]
    args += ["-c:a", "libopus", str(ogg_path)]
    subprocess.run(args, check=True, capture_output=True)


@app.get("/health")
def health():
    return {"status": "ok", "model": "LiquidAI/LFM2.5-Audio-1.5B-GGUF"}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty file")

    with tempfile.TemporaryDirectory() as tmp:
        ogg_path = Path(tmp) / "input.ogg"
        wav_path = Path(tmp) / "input.wav"
        ogg_path.write_bytes(data)
        _ogg_to_wav(ogg_path, wav_path)

        cmd = _cli_args() + ["-sys", "Perform ASR.", "--audio", str(wav_path)]
        try:
            # The GGUF runner is memory-heavy; serialize invocations to avoid transient
            # failures when ASR/TTS requests overlap under load.
            async with CLI_LOCK:
                out = subprocess.run(
                    cmd,
                    capture_output=True,
                    timeout=120,
                    cwd=str(MODELS_DIR),
                )
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "Transcription timed out")
        except FileNotFoundError:
            raise HTTPException(503, "llama-liquid-audio-cli not found; model may still be downloading")

        if out.returncode != 0:
            err = (out.stderr or out.stdout or b"").decode("utf-8", errors="replace")
            raise HTTPException(500, err or "ASR failed")

        text = (out.stdout or b"").decode("utf-8", errors="replace").strip()
        return {"text": text}


class SynthRequest(BaseModel):
    text: str
    voice: str | None = None


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty text")

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "output.wav"
        ogg_path = Path(tmp) / "output.ogg"

        cmd = _cli_args() + [
            "-sys", "Perform TTS. Use the US male voice.",
            "-p", req.text,
            "--output", str(wav_path),
            "--temp", str(TTS_TEMPERATURE),
            "--top-p", str(TTS_TOP_P),
        ]
        try:
            # The GGUF runner is memory-heavy; serialize invocations to avoid transient
            # failures when ASR/TTS requests overlap under load.
            async with CLI_LOCK:
                out = subprocess.run(
                    cmd,
                    capture_output=True,
                    timeout=120,
                    cwd=str(MODELS_DIR),
                )
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "Synthesis timed out")
        except FileNotFoundError:
            raise HTTPException(503, "llama-liquid-audio-cli not found; model may still be downloading")

        if out.returncode != 0 or not wav_path.exists():
            err = (out.stderr or out.stdout or b"").decode("utf-8", errors="replace")
            raise HTTPException(500, err or "TTS failed")

        _wav_to_ogg(wav_path, ogg_path)
        return Response(content=ogg_path.read_bytes(), media_type="audio/ogg")
