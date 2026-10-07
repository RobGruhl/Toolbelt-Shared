#!/bin/sh
# vendor.sh — copy a tool's git-tracked files into the Toolbelt with provenance + secret gate.
#
# Usage:
#   bin/vendor.sh <source-path> <dest-dir> [subdir]
#
#   <source-path>  path to the upstream working copy (must be a git repo)
#   <dest-dir>     destination inside this repo, e.g. tools/<name>
#   [subdir]       optional: vendor only this subtree of the source repo
#
# What it does (see docs/VENDORING.md):
#   1. warns if the source tree is dirty
#   2. `git archive HEAD` — tracked files ONLY (secrets are gitignored upstream → excluded)
#   3. prints a provenance block to paste into the dest's toolbelt.json
#   4. detect-secrets gate: refuses to finish if anything is flagged
#
# Single files / non-repos: copy by hand and record file_sha256 in toolbelt.json instead.

set -eu

SRC=${1:?usage: vendor.sh <source-path> <dest-dir> [subdir]}
DEST=${2:?usage: vendor.sh <source-path> <dest-dir> [subdir]}
SUBDIR=${3:-}

TOOLBELT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST_ABS="$TOOLBELT_DIR/$DEST"

DETECT_SECRETS=""
for candidate in detect-secrets "$HOME/.local/bin/detect-secrets"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    DETECT_SECRETS=$(command -v "$candidate")
    break
  fi
done
if [ -z "$DETECT_SECRETS" ]; then
  echo "vendor.sh: detect-secrets not found — refusing to vendor without the secret gate." >&2
  echo "  Fix:  pipx install detect-secrets" >&2
  exit 1
fi

if ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  echo "vendor.sh: $SRC is not a git repository." >&2
  echo "For single files / non-repos: copy by hand, record file_sha256 in toolbelt.json." >&2
  exit 1
fi

DIRTY=false
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  DIRTY=true
  echo "⚠️  WARNING: $SRC has uncommitted changes. Vendoring HEAD (committed state) only." >&2
  echo "    Uncommitted work will NOT be vendored. Set \"dirty\": true in toolbelt.json." >&2
fi

COMMIT=$(git -C "$SRC" rev-parse --short HEAD)
REMOTE=$(git -C "$SRC" remote get-url origin 2>/dev/null || echo "null")
TODAY=$(date +%Y-%m-%d)

mkdir -p "$DEST_ABS"

if [ -n "$SUBDIR" ]; then
  # archive only the subtree, stripping its path prefix
  DEPTH=$(printf '%s' "$SUBDIR" | awk -F/ '{print NF}')
  git -C "$SRC" archive HEAD "$SUBDIR" | tar -x --strip-components "$DEPTH" -C "$DEST_ABS"
else
  git -C "$SRC" archive HEAD | tar -x -C "$DEST_ABS"
fi

echo ""
echo "Vendored $SRC${SUBDIR:+ ($SUBDIR)} -> $DEST"
echo ""
# Toolbelt owns what it vendors, from this moment on. The origin is recorded as provenance —
# and as something to glance at later with `toolbelt inspire` — never as a sync target.
echo "Origin block for toolbelt.json (provenance only; Toolbelt owns the copy):"
echo "  \"origin\": {"
if [ "$REMOTE" = "null" ]; then
  echo "    \"repo\": \"$SRC\","
else
  echo "    \"repo\": \"$REMOTE\","
fi
[ -n "${COMMIT:-}" ] && echo "    \"vendored_commit\": \"$COMMIT\","
echo "    \"vendored_at\": \"$TODAY\""
echo "  }"
[ -n "${DIRTY:-}" ] && echo "  (source tree was dirty=$DIRTY at copy time — only committed files were taken)"
echo ""

# --- Secret gate -------------------------------------------------------------
echo "Running secret gate (detect-secrets)..."
SCAN=$("$DETECT_SECRETS" scan "$DEST_ABS" 2>/dev/null)
# portable check without jq: results object is empty when clean -> '"results": {}'
if printf '%s' "$SCAN" | grep -q '"results": {}'; then
  echo "✅ Secret gate clean."
else
  echo "" >&2
  echo "❌ SECRET GATE FAILED — potential secrets detected in $DEST:" >&2
  printf '%s\n' "$SCAN" | grep -A2 '"filename"' >&2 || printf '%s\n' "$SCAN" >&2
  echo "" >&2
  echo "Removing vendored tree. Investigate upstream, fix, and re-run." >&2
  rm -rf "$DEST_ABS"
  exit 1
fi

echo ""
echo "Next steps:"
echo "  1. Write $DEST/toolbelt.json (schema: docs/MANIFEST.md) using the provenance above"
echo "  2. Python tool? Add $DEST/poetry.toml with [virtualenvs] in-project = true"
echo "  3. ./bin/toolbelt doctor ${DEST##*/}"
