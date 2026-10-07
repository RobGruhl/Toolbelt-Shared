#!/usr/bin/env bash
# {{TITLE}} — Build Script
# Converts Markdown chapters to Typst, then compiles to PDF. Standalone: needs only pandoc
# and typst on PATH. Imposition (the print-ready 2-up PDF) needs pypdf; the belt's
# `spiral-book impose` verb supplies it from its own poetry env, or `poetry add pypdf` here.
#
# Usage:
#   ./build.sh          # Build the full PDF (and impose, if pypdf is importable)
#   ./build.sh clean    # Remove generated files
#   ./build.sh watch    # Watch for changes and rebuild (needs fswatch)
#   ./build.sh impose   # Only rebuild the imposed print-ready PDF

set -euo pipefail
cd "$(dirname "$0")"

OUTPUT="{{SLUG}}.pdf"
PRINT_READY="{{SLUG}}-print-ready.pdf"
SECTIONS=(
{{SECTIONS_BASH}}
)

# The interpreter that can import pypdf. SPIRAL_BOOK_PYTHON is what the belt's CLI exports;
# a project-local poetry env is the standalone alternative. Never a global pip.
PY="${SPIRAL_BOOK_PYTHON:-}"
if [[ -z "$PY" ]] && [[ -x .venv/bin/python ]]; then PY=".venv/bin/python"; fi
if [[ -z "$PY" ]]; then PY="python3"; fi

have_pypdf() { "$PY" -c "import pypdf" 2>/dev/null; }
pypdf_hint() {
  echo "pypdf not importable by $PY."
  echo "Either: toolbelt run spiral-book -- impose \"$(pwd)/..\"   (the belt's env has it)"
  echo "    or: poetry init -n && poetry add pypdf   (a project-local env; then re-run)"
}

# --- Impose only ---
if [[ "${1:-}" == "impose" ]]; then
  if ! have_pypdf; then pypdf_hint; exit 1; fi
  "$PY" impose.py "$OUTPUT" "$PRINT_READY"
  exit 0
fi

# --- Clean ---
if [[ "${1:-}" == "clean" ]]; then
  echo "Cleaning generated .typ files and PDF..."
  for sec in "${SECTIONS[@]}"; do
    rm -f "${sec}.md.typ"
  done
  rm -f "$OUTPUT" "$PRINT_READY"
  echo "Done."
  exit 0
fi

# --- Check dependencies ---
if ! command -v pandoc &>/dev/null; then
  echo "ERROR: pandoc not found. Install with: brew install pandoc"
  exit 1
fi
if ! command -v typst &>/dev/null; then
  echo "ERROR: typst not found. Install with: brew install typst"
  exit 1
fi

convert_one() {
  local sec="$1" src="$1.md" dst="$1.md.typ"
  if [[ ! -f "$src" ]]; then
    echo "  SKIP: $src (not found)"
    echo "// Placeholder — ${sec}.md not yet written" > "$dst"
    return
  fi
  echo "  $src → $dst"
  {
    echo '#import "template/layout.typ": horizontalrule'
    pandoc "$src" --from markdown --to typst --wrap=none | sed '/^<!-- tab:/d'
  } > "$dst"
}

# --- Convert Markdown to Typst ---
echo "Converting Markdown → Typst..."
for sec in "${SECTIONS[@]}"; do convert_one "$sec"; done

# --- Compile PDF ---
echo ""
echo "Compiling PDF..."
typst compile main.typ "$OUTPUT"
echo ""
echo "Done! Output: $(pwd)/$OUTPUT"

# --- Impose for print ---
if have_pypdf; then
  echo ""
  echo "Imposing for print..."
  "$PY" impose.py "$OUTPUT" "$PRINT_READY"
else
  echo ""
  echo "Skipping imposition (degraded: no pypdf)."
  pypdf_hint
fi

# --- Watch mode ---
if [[ "${1:-}" == "watch" ]]; then
  if ! command -v fswatch &>/dev/null; then
    echo "watch needs fswatch: brew install fswatch"
    exit 1
  fi
  echo ""
  echo "Watching for changes... (Ctrl+C to stop)"
  typst watch main.typ "$OUTPUT" &
  TYPST_PID=$!
  trap "kill $TYPST_PID 2>/dev/null; exit" INT TERM

  fswatch -o ./*.md 2>/dev/null | while read -r; do
    echo "Markdown changed, reconverting..."
    for sec in "${SECTIONS[@]}"; do
      [[ -f "${sec}.md" ]] && convert_one "$sec" >/dev/null
    done
  done
fi
