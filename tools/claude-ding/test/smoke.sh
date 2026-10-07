#!/bin/bash
# Smoke: scripts parse, every sound they reference exists, muted run picks a real file. No audio.
set -eu
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for s in "$here"/sounds/play-random.sh "$here"/sounds/play-random-question.sh; do
  bash -n "$s"
  [ -x "$s" ] || { echo "not executable: $s"; exit 1; }
done
n=$(ls "$here"/sounds/*.wav 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -ge 1 ] || { echo "no .wav in sounds/"; exit 1; }
for s in play-random.sh play-random-question.sh; do
  out=$(CLAUDE_DING_MUTE=1 "$here/sounds/$s")
  f=${out#muted: }
  [ -f "$f" ] || { echo "$s picked a missing file: $f"; exit 1; }
done
echo "ok: 2 scripts parse, $n wav files, muted picks resolve"
