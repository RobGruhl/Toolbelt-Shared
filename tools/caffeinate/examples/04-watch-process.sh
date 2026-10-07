#!/usr/bin/env bash
# 04-watch-process.sh — Caffeinate until a specific process exits
set -euo pipefail

echo "=== Starting a background job ==="
sleep 5 &
JOB_PID=$!
echo "Background job PID: $JOB_PID"

echo ""
echo "=== Caffeinating until job finishes (-w flag) ==="
caffeinate -di -w "$JOB_PID" &
CAFF_PID=$!
echo "Caffeinate PID: $CAFF_PID (watching $JOB_PID)"

echo ""
echo "=== Waiting for job to finish ==="
wait "$JOB_PID"
echo "Job finished."

# Give caffeinate a moment to notice
sleep 1

echo ""
echo "=== Caffeinate should have exited ==="
if kill -0 "$CAFF_PID" 2>/dev/null; then
  echo "Still running (unexpected)"
  kill "$CAFF_PID"
else
  echo "Caffeinate exited automatically. Clean."
fi
