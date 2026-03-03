"""
Voice service — NeuTTS (TTS only): English + French
  Models loaded at startup (warm); no lazy loading.
  TTS:  POST /synthesize  — {"text": "...", "voice": "..."} → OGG audio (speed 1.02)
  ASR:  POST /transcribe  — 501 (not supported)
  GET   /health

Env: TTS_SPEED — playback speed (default 1.02)
"""

import asyncio
import os
import subprocess
import tempfile
from pathlib import Path

from contextlib import asynccontextmanager
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

TTS_SPEED = float(os.environ.get("TTS_SPEED", "1.02"))

APP_DIR = Path(__file__).resolve().parent
SAMPLES_DIR = APP_DIR / "samples"

# Per-language config: (ref_audio, ref_text_file, backbone_repo, default_ref_text)
_LANG_CONFIG = {
    "en": (
        SAMPLES_DIR / "dave.wav",
        SAMPLES_DIR / "dave.txt",
        "neuphonic/neutts-air-q4-gguf",
        "My name is Dave, and I'm from London.",
    ),
    "fr": (
        SAMPLES_DIR / "juliette.wav",
        SAMPLES_DIR / "juliette.txt",
        "neuphonic/neutts-nano-french-q8-gguf",
        "Je m'appelle Juliette. J'ai vingt-cinq ans et je viens de m'installer à Londres.",
    ),
}

# Pre-loaded at startup: lang -> (tts, ref_codes, ref_text)
_tts_cache: dict[str, tuple] = {}


def _load_tts_sync(lang: str):
    from neutts import NeuTTS

    ref_audio, ref_text_file, backbone, default_ref_text = _LANG_CONFIG[lang]
    ref_text = ref_text_file.read_text().strip() if ref_text_file.exists() else default_ref_text
    if not ref_audio.exists():
        raise RuntimeError(f"Reference audio for {lang} not found: {ref_audio}")

    tts = NeuTTS(
        backbone_repo=backbone,
        backbone_device="cpu",
        codec_repo="neuphonic/neucodec",
        codec_device="cpu",
    )
    ref_codes = tts.encode_reference(str(ref_audio))
    return tts, ref_codes, ref_text


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load both EN and FR models at startup so first request is fast."""
    loop = asyncio.get_event_loop()
    for lang in ("en", "fr"):
        try:
            loaded = await loop.run_in_executor(None, lambda l=lang: _load_tts_sync(l))
            _tts_cache[lang] = loaded
            print(f"[voice] Loaded {lang} TTS (warm)", flush=True)
        except Exception as e:
            print(f"[voice] Failed to load {lang}: {e}", flush=True)
    yield
    _tts_cache.clear()


app = FastAPI(title="Stingyclaw Voice — NeuTTS (EN + FR)", lifespan=lifespan)


def _normalize_language(voice: str | None, language: str | None) -> str:
    """Resolve to 'en' or 'fr'. Voice 'French' or language 'fr' → French."""
    if language and language.strip().lower() in ("fr", "french"):
        return "fr"
    if voice and voice.strip().lower() in ("french", "fr"):
        return "fr"
    return "en"


def _load_tts_sync(lang: str):
    from neutts import NeuTTS

    ref_audio, ref_text_file, backbone, default_ref_text = _LANG_CONFIG[lang]
    ref_text = ref_text_file.read_text().strip() if ref_text_file.exists() else default_ref_text
    if not ref_audio.exists():
        raise RuntimeError(f"Reference audio for {lang} not found: {ref_audio}")

    tts = NeuTTS(
        backbone_repo=backbone,
        backbone_device="cpu",
        codec_repo="neuphonic/neucodec",
        codec_device="cpu",
    )
    ref_codes = tts.encode_reference(str(ref_audio))
    return tts, ref_codes, ref_text


def _get_tts(lang: str):
    """Return pre-loaded TTS for language (must be loaded at startup)."""
    if lang not in _tts_cache:
        raise HTTPException(503, f"TTS for language '{lang}' not loaded (check startup logs)")
    return _tts_cache[lang]


def _wav_to_ogg(wav_path: Path, ogg_path: Path, speed: float = TTS_SPEED) -> None:
    args = ["ffmpeg", "-y", "-i", str(wav_path)]
    if speed != 1.0:
        args += ["-filter:a", f"atempo={speed}"]
    args += ["-c:a", "libopus", str(ogg_path)]
    subprocess.run(args, check=True, capture_output=True)


@app.get("/health")
def health():
    return {"status": "ok", "models": ["neuphonic/neutts-air-q4-gguf", "neuphonic/neutts-nano-french-q8-gguf"], "languages": ["en", "fr"]}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """ASR not supported with NeuTTS Air backend."""
    raise HTTPException(501, "Transcribe not available with NeuTTS backend. Use a separate ASR service.")


class SynthRequest(BaseModel):
    text: str
    voice: str | None = None
    language: str | None = None  # "en" | "fr" — or use voice="French" for French


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty text")

    lang = _normalize_language(req.voice, req.language)
    tts, ref_codes, ref_text = _get_tts(lang)

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "output.wav"
        ogg_path = Path(tmp) / "output.ogg"

        def _infer():
            import soundfile as sf
            wav = tts.infer(req.text.strip(), ref_codes, ref_text)
            sf.write(str(wav_path), wav, 24000)

        loop = asyncio.get_event_loop()
        try:
            await asyncio.wait_for(
                loop.run_in_executor(None, _infer),
                timeout=120.0,
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, "Synthesis timed out")

        if not wav_path.exists():
            raise HTTPException(500, "TTS failed to produce audio")

        _wav_to_ogg(wav_path, ogg_path, TTS_SPEED)
        return Response(content=ogg_path.read_bytes(), media_type="audio/ogg")
