#!/usr/bin/env bash
# 03-subtitle-export.sh — Generate subtitles in SRT and VTT formats
#
# Transcribes with timestamps enabled and exports as SRT or VTT
# subtitle files, suitable for video players and editors.
# Requires: whisper.cpp service running on port 2022
#
# Usage: ./examples/03-subtitle-export.sh <audio-or-video-file>

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "Usage: $0 <audio-or-video-file>"
    echo "Example: $0 ~/video.mp4"
    exit 1
fi

AUDIO_FILE="$1"
BASENAME="$(basename "${AUDIO_FILE%.*}")"
OUTPUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/tmp"
mkdir -p "$OUTPUT_DIR"

echo "=== Generate SRT subtitles ==="
poetry run transcribe run "$AUDIO_FILE" \
    --timestamps \
    --format srt \
    --output "$OUTPUT_DIR/${BASENAME}.srt"

echo ""
echo "=== Generate VTT subtitles ==="
poetry run transcribe run "$AUDIO_FILE" \
    --timestamps \
    --format vtt \
    --output "$OUTPUT_DIR/${BASENAME}.vtt"

echo ""
echo "=== Generate timestamped JSON (high_quality preset) ==="
poetry run transcribe run "$AUDIO_FILE" \
    --preset high_quality \
    --output "$OUTPUT_DIR/${BASENAME}.json"

echo ""
echo "Generated files:"
ls -la "$OUTPUT_DIR/${BASENAME}".*
