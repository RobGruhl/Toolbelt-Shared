#!/usr/bin/env bash
# 01-basic-transcribe.sh — Simplest transcription invocation
#
# Transcribes an audio file to plain text using default settings.
# Requires: whisper.cpp service running on port 2022
#
# Usage: ./examples/01-basic-transcribe.sh <audio-file>

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "Usage: $0 <audio-file>"
    echo "Example: $0 ~/recording.mp3"
    exit 1
fi

AUDIO_FILE="$1"

# Check that the backend is running
poetry run transcribe check

# Transcribe to stdout (plain text, auto language detection)
poetry run transcribe run "$AUDIO_FILE"
