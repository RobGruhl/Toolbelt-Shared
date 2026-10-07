#!/usr/bin/env bash
# 03-guarded-script.sh — Use caff_guard for auto-cleanup on exit
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/caffeinate.sh"

# caff_guard starts caffeinate and registers a trap to kill it on EXIT
# No matter how this script ends (success, error, ctrl-c), caffeinate dies too
caff_guard -dis

echo "=== Simulating work (5 seconds) ==="
echo "System won't sleep during this. Try closing the lid!"
echo ""

for i in 1 2 3 4 5; do
  echo "  Working... ($i/5)"
  sleep 1
done

echo ""
echo "=== Script done — caffeinate will auto-cleanup via trap ==="
