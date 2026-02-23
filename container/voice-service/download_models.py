"""
Download piper voice models on first run.
Called by the container entrypoint before starting the server.
"""
import os
import sys
import urllib.request
from pathlib import Path

PIPER_DIR = Path(os.environ.get("MODELS_DIR", "/models")) / "piper"

VOICES = {
    "en_US-amy-medium": {
        "onnx": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
        "json": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json",
    },
    "en_US-ryan-high": {
        "onnx": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx",
        "json": "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json",
    },
}

DEFAULT_VOICE = os.environ.get("DEFAULT_VOICE", "en_US-amy-medium")


def download(url: str, dest: Path) -> None:
    print(f"  Downloading {dest.name}...", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    try:
        urllib.request.urlretrieve(url, str(tmp))
        tmp.rename(dest)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download {url}: {e}") from e


def ensure_voice(name: str) -> None:
    urls = VOICES.get(name)
    if not urls:
        print(f"[download_models] Unknown voice '{name}', skipping.", flush=True)
        return

    onnx_path = PIPER_DIR / f"{name}.onnx"
    json_path = PIPER_DIR / f"{name}.onnx.json"

    if onnx_path.exists() and json_path.exists():
        print(f"[download_models] Voice '{name}' already present.", flush=True)
        return

    print(f"[download_models] Downloading voice '{name}'...", flush=True)
    if not onnx_path.exists():
        download(urls["onnx"], onnx_path)
    if not json_path.exists():
        download(urls["json"], json_path)
    print(f"[download_models] Voice '{name}' ready.", flush=True)


if __name__ == "__main__":
    voice = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VOICE
    ensure_voice(voice)
