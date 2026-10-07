#!/usr/bin/env bash
# caff.test.sh — exercises the gate, the ceilings and the own-process guard WITHOUT ever
# holding a power assertion: no test passes --yes to start or run. Runs against a temp
# CAFF_HOME so the real registry and audit log are untouched.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAFF="$DIR/caff"
export CAFF_HOME
CAFF_HOME=$(mktemp -d "${TMPDIR:-/tmp}/caff-test.XXXXXX")
trap 'rm -rf "$CAFF_HOME"' EXIT

fails=0
check() { # check <name> <expected-exit> <cmd...>
  local name="$1" want="$2"; shift 2
  local out; out=$("$@" 2>&1); local got=$?
  if [[ "$got" == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name: exit $got, wanted $want"; echo "$out" | sed 's/^/     /'; fails=$((fails+1)); fi
  LAST_OUT="$out"
}
expect_grep() { if grep -q -- "$1" <<<"$LAST_OUT"; then echo "ok   ... mentions '$1'"; else echo "FAIL ... missing '$1'"; fails=$((fails+1)); fi; }

before=$(pgrep -x caffeinate | sort | tr '\n' ' ')

check "help exits 0" 0 "$CAFF" --help
check "no verb is a usage error" 2 "$CAFF"
check "unknown verb is a usage error" 2 "$CAFF" frobnicate
check "status is free and exits 0 even when nothing runs" 0 "$CAFF" status

check "start previews without --yes" 0 "$CAFF" start
expect_grep "would start: caffeinate -di -t 3600"
expect_grep "Preview only"
check "start --explain previews" 0 "$CAFF" start -dis --timeout 600 --explain
expect_grep "caffeinate -dis -t 600"
expect_grep "AC power"
check "start refuses a timeout past the ceiling" 2 "$CAFF" start --timeout 99999 --yes
expect_grep "MAX_TIMEOUT_S=28800"
check "start refuses timeout 0 (forever)" 2 "$CAFF" start --timeout 0 --yes
check "start refuses an unknown caffeinate letter" 2 "$CAFF" start -dx --yes

check "run previews without --yes" 0 "$CAFF" run -i -- true
expect_grep "would run: caffeinate -i -- true"
check "run needs a command" 2 "$CAFF" run --yes

check "stop needs a target" 2 "$CAFF" stop --yes
check "stop --mine with empty registry is a no-op" 0 "$CAFF" stop --mine --yes
expect_grep "nothing to stop"

# Own-process guard: a PID this tool did not start is refused even with --yes.
sleep 30 & victim=$!
check "stop refuses a PID not in the registry" 1 "$CAFF" stop "$victim" --yes
expect_grep "not started by caff"
# ...and a registry row whose PID is not a caffeinate process is pruned, never signalled.
printf '%s\t%s\t%s\t%s\n' "$victim" "2026-01-01T00:00:00Z" "-di" "60" >> "$CAFF_HOME/pids"
check "stop --mine prunes a non-caffeinate PID instead of killing it" 0 "$CAFF" stop --mine --yes
if kill -0 "$victim" 2>/dev/null; then echo "ok   non-caffeinate PID $victim survived"; else echo "FAIL sleep process was signalled"; fails=$((fails+1)); fi
kill "$victim" 2>/dev/null; wait "$victim" 2>/dev/null

[[ -s "$CAFF_HOME/audit.log" ]] && { echo "FAIL audit log has lines but nothing was mutated"; fails=$((fails+1)); } || echo "ok   audit log empty: no mutation happened"

after=$(pgrep -x caffeinate | sort | tr '\n' ' ')
if [[ "$before" == "$after" ]]; then echo "ok   caffeinate process set unchanged by the tests"; else echo "FAIL caffeinate processes changed: '$before' -> '$after'"; fails=$((fails+1)); fi

# The manifest's verbs[] must name exactly the verbs the CLI dispatches on.
if command -v node >/dev/null; then
  want="assertions run start status stop"
  got=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.verbs.filter(v=>v.tier!=="never").map(v=>v.name).sort().join(" "))' "$DIR/toolbelt.json")
  if [[ "$got" == "$want" ]]; then echo "ok   manifest verbs[] match the CLI"; else echo "FAIL manifest verbs '$got' != CLI '$want'"; fails=$((fails+1)); fi
fi

echo; if (( fails == 0 )); then echo "all green"; else echo "$fails failure(s)"; exit 1; fi
