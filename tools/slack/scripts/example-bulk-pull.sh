#!/bin/bash
#
# Example: bulk-pull a list of Slack channels as JSON, with per-channel
# delta watermarks and a probe pre-flight check.
#
# This is the pattern downstream ingest consumers use — copy it into your
# own repo and adapt it; don't run it from here. Consumers own their variants.
#
# What it demonstrates:
#   - probe pre-flight (cheap auth/health check before the bulk pull)
#   - JSON output (-f json) for machine-readable downstream processing
#   - per-channel watermark file (data/.watermark) for delta pulls
#   - off-hours guard, same window as the CLI (override with FORCE=1)
#   - telemetry footer parsing for caller-side circuit breaking
#
# Usage:
#   cp scripts/channels.conf.example scripts/channels.conf  # edit channels
#   ./scripts/example-bulk-pull.sh                          # outside business hours
#   FORCE=1 ./scripts/example-bulk-pull.sh                  # override the off-hours guard
#
# Output:
#   data/<channel-name>.json   — accumulating per-channel JSON file
#   data/.watermark            — per-channel last-pull date (gitignored)
#   logs/pull-<date>.log       — per-run log (gitignored)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CLI="$REPO_ROOT/cli.js"
CHANNELS_FILE="$SCRIPT_DIR/channels.conf"
OUTPUT_DIR="data"
LOG_DIR="logs"
FALLBACK_AFTER="${DATE_AFTER:-2025-01-01}"
WATERMARK_FILE="$OUTPUT_DIR/.watermark"
PROBE_CHANNEL="${PROBE_CHANNEL:-general}"
PAGE_DELAY="${PAGE_DELAY:-250}"      # ms between pages within a channel
CHANNEL_DELAY="${CHANNEL_DELAY:-5}"  # seconds between channels

mkdir -p "$OUTPUT_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/pull-$(date +%Y-%m-%d).log"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" >&2
    echo "$msg" >> "$LOG_FILE"
}

# --- Watermark helpers -----------------------------------------------------
read_watermark() {
    local channel_name="$1"
    if [ -f "$WATERMARK_FILE" ]; then
        local wm
        wm=$(grep "^${channel_name} " "$WATERMARK_FILE" 2>/dev/null | awk '{print $2}')
        if [[ "$wm" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
            echo "$wm"
            return
        fi
    fi
    echo "$FALLBACK_AFTER"
}

write_watermark() {
    local channel_name="$1"
    local date_str="$2"
    if [ ! -f "$WATERMARK_FILE" ]; then
        echo "$channel_name $date_str" > "$WATERMARK_FILE"
        return
    fi
    local tmp="${WATERMARK_FILE}.tmp"
    grep -v "^${channel_name} " "$WATERMARK_FILE" > "$tmp" 2>/dev/null || true
    echo "$channel_name $date_str" >> "$tmp"
    mv "$tmp" "$WATERMARK_FILE"
}

# --- Validation ------------------------------------------------------------
if [ ! -f "$CLI" ]; then
    log "ERROR: cli.js not found at $CLI"
    exit 1
fi
if [ ! -f "$CHANNELS_FILE" ]; then
    log "ERROR: $CHANNELS_FILE not found."
    log "Copy channels.conf.example to channels.conf and configure your channels."
    exit 1
fi

# --- Probe pre-flight ------------------------------------------------------
# Catch auth/rate-limit problems with a single API call instead of N failures.
log "Probing Slack health (channel: #$PROBE_CHANNEL)..."
PROBE_ARGS=("probe" "$PROBE_CHANNEL")
if [ "$FORCE" = "1" ]; then PROBE_ARGS=("--force" "${PROBE_ARGS[@]}"); fi
if ! node "$CLI" "${PROBE_ARGS[@]}" >/dev/null 2>>"$LOG_FILE"; then
    log "Probe failed — auth expired, rate-limited, or unreachable. Aborting."
    exit 1
fi
log "Probe OK."

# --- Off-hours guard -------------------------------------------------------
# The CLI enforces this for each `channel` invocation, but check up-front
# too so we don't pass the probe and then bail at the first channel. Same
# knobs as the CLI: SLACK_BUSINESS_HOURS "HH-HH" (default 06-18) and
# SLACK_BUSINESS_TZ (default: this machine's zone).
BH="${SLACK_BUSINESS_HOURS:-06-18}"
BH_START=$((10#${BH%-*}))
BH_END=$((10#${BH#*-}))
if [ -n "$SLACK_BUSINESS_TZ" ]; then
    HOUR=$((10#$(TZ="$SLACK_BUSINESS_TZ" date +%H)))
    DOW=$(TZ="$SLACK_BUSINESS_TZ" date +%u)
else
    HOUR=$((10#$(date +%H)))
    DOW=$(date +%u)
fi
if [ "$DOW" -le 5 ] && [ "$HOUR" -ge "$BH_START" ] && [ "$HOUR" -lt "$BH_END" ]; then
    if [ "$FORCE" != "1" ]; then
        log "BLOCKED: business hours (Mon-Fri ${BH} ${SLACK_BUSINESS_TZ:-local time}). Set FORCE=1 to override."
        exit 1
    fi
    log "WARNING: running during business hours (FORCE=1)"
fi

# --- SIGINT trap: finish the in-flight channel, then stop ------------------
INTERRUPTED=0
trap 'INTERRUPTED=1; log "SIGINT — finishing current channel then exiting..."' INT

# --- Pull ------------------------------------------------------------------
log "============================================================"
log "Bulk pull: fallback=$FALLBACK_AFTER page-delay=${PAGE_DELAY}ms channel-delay=${CHANNEL_DELAY}s"
log "Output: $OUTPUT_DIR/   Log: $LOG_FILE"
log "============================================================"

TOTAL=0
SUCCESS=0
FAILED=0

while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [ "$INTERRUPTED" -eq 1 ]; then break; fi

    channel_input=$(echo "$line" | awk '{print $1}')
    channel_name=$(echo "$line" | awk '{print $2}')
    [ -z "$channel_input" ] || [ -z "$channel_name" ] && continue

    TOTAL=$((TOTAL + 1))
    OUTPUT_FILE="$OUTPUT_DIR/${channel_name}.json"
    AFTER=$(read_watermark "$channel_name")

    log "[$TOTAL] #$channel_name ($channel_input) since $AFTER"

    CLI_ARGS=(channel "$channel_input" --after "$AFTER" --delay "$PAGE_DELAY" -f json -o "$OUTPUT_FILE")
    if [ "$FORCE" = "1" ]; then CLI_ARGS+=(--force); fi

    if node "$CLI" "${CLI_ARGS[@]}" 2>>"$LOG_FILE"; then
        # Update watermark to today only on success.
        # NOTE: this script overwrites the output file each run rather than
        # merging deltas. A real consumer should dedup-merge the new pull into
        # the existing file keyed by message `ts` (unique per channel).
        write_watermark "$channel_name" "$(date +%Y-%m-%d)"
        SUCCESS=$((SUCCESS + 1))
    else
        log "[$TOTAL] FAILED #$channel_name — leaving watermark unchanged"
        FAILED=$((FAILED + 1))
    fi

    sleep "$CHANNEL_DELAY"
done < "$CHANNELS_FILE"

log "============================================================"
log "Done. total=$TOTAL ok=$SUCCESS failed=$FAILED"
log "============================================================"

# Surface the CLI's telemetry footer (rateLimitHits, retries, etc.) — a
# caller-side circuit breaker can grep this in the log.
tail -n 20 "$LOG_FILE" | grep -E "telemetry:" || true

[ "$FAILED" -gt 0 ] && exit 1
exit 0
