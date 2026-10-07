#!/bin/bash
# Agent voice narration hook for Claude Code
# Receives hook JSON on stdin, extracts transcript_summary, sends to voice server.
# Always exits 0. Server down = silent no-op.

AGENT_VOICE_PORT="${AGENT_VOICE_PORT:-7888}"
AGENT_VOICE_URL="http://127.0.0.1:${AGENT_VOICE_PORT}/speak"

# Read JSON from stdin
input=$(cat)

# Extract summary text using python3 (always available)
text=$(echo "$input" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    summary = data.get('transcript_summary', '')
    if not summary:
        sys.exit(0)
    # Use last non-empty line, capped at 200 chars
    lines = [l.strip() for l in summary.strip().split('\n') if l.strip()]
    if lines:
        print(lines[-1][:200])
except Exception:
    pass
" 2>/dev/null)

# Only speak if we got text
if [ -n "$text" ]; then
    # JSON-encode the text safely
    json_payload=$(python3 -c "
import sys, json
text = sys.argv[1]
print(json.dumps({'text': text, 'agent_type': 'default'}))
" "$text" 2>/dev/null)

    # Fire and forget
    curl -s -X POST "$AGENT_VOICE_URL" \
        -H "Content-Type: application/json" \
        -d "$json_payload" \
        --max-time 2 \
        > /dev/null 2>&1 &
fi

exit 0
