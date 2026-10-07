#!/usr/bin/env bash
# 02-with-options.sh — Transcription with preset, language, and custom vocabulary
#
# Shows how to use presets, force a language, add domain vocabulary,
# and save output to a file.
# Requires: whisper.cpp service running on port 2022
#
# Usage: ./examples/02-with-options.sh <audio-file>

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "Usage: $0 <audio-file>"
    echo "Example: $0 ~/meeting.m4a"
    exit 1
fi

AUDIO_FILE="$1"
OUTPUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/tmp"
mkdir -p "$OUTPUT_DIR"

echo "=== List available presets ==="
poetry run transcribe presets

echo ""
echo "=== Transcribe with gaming preset (TTRPG vocabulary) ==="
poetry run transcribe run "$AUDIO_FILE" --preset gaming

echo ""
echo "=== Transcribe with explicit language + custom vocabulary ==="
poetry run transcribe run "$AUDIO_FILE" \
    --language en \
    --prompt "Anthropic, Claude, MCP, whisper.cpp, Metal"

echo ""
echo "=== Save output to file ==="
poetry run transcribe run "$AUDIO_FILE" \
    --output "$OUTPUT_DIR/transcript.txt"

echo "Saved to: $OUTPUT_DIR/transcript.txt"
