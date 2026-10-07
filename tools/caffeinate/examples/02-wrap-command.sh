#!/usr/bin/env bash
# 02-wrap-command.sh — Use caffeinate to wrap a long-running command
set -euo pipefail

echo "=== Running 'sleep 5' wrapped in caffeinate ==="
echo "Caffeinate will hold assertions only while sleep runs."
echo ""

# caffeinate wraps the command — assertions auto-release when it exits
caffeinate -di sleep 5

echo "Done. Caffeinate released assertions automatically."
echo ""
echo "=== Current assertions ==="
pmset -g assertions | head -15
