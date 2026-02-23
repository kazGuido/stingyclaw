#!/bin/sh
set -e

# Download piper voice model if not already cached
python /app/download_models.py "${DEFAULT_VOICE:-en_US-amy-medium}"

# Start server
exec uvicorn server:app --host 0.0.0.0 --port 8001 --workers 1
