#!/usr/bin/env bash
# 01-basic-keep-awake.sh — Start caffeinate, check status, stop it
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/caffeinate.sh"

echo "=== Starting caffeinate (idle + display) ==="
pid=$(caff_start -di)
echo "Started with PID: $pid"

echo ""
echo "=== Checking status ==="
caff_status

echo ""
echo "=== Sleeping 3 seconds to prove it's running ==="
sleep 3

echo ""
echo "=== Stopping caffeinate ==="
caff_stop "$pid"
echo "Stopped."

echo ""
echo "=== Final status ==="
caff_status || true
