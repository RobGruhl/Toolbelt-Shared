#!/bin/bash
# Offline contract tests for bin/codex-fleet: no codex, no jq, no network, no spend.
# Every assertion here is something the manifest claims; if one fails the manifest lies.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"; CF="$HERE/bin/codex-fleet"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
check() { if [ "$1" -eq "$2" ]; then echo "ok   $3"; else echo "FAIL $3 (exit $1, wanted $2)"; fail=1; fi; }

# Hide codex and jq behind a PATH that has neither: proves preview/explain never need the
# runtime and that nothing can launch from this test.
mkdir -p "$T/bin"; export PATH="$T/bin:/usr/bin:/bin"

"$CF" --help >/dev/null 2>&1; check $? 0 "--help exits 0"
"$CF" --version | grep -q '^codex-fleet ' ; check $? 0 "--version prints a version"

out="$("$CF" -C "$T" -n 2 --explain 'Run true. Acceptance check: exit status.' 2>&1)"; rc=$?
check $rc 0 "--explain exits 0"
echo "$out" | grep -q 'tier:      read'; check $? 0 "--explain names the read tier for a read-only fleet"
[ ! -e "$T/.fleet" ]; check $? 0 "--explain creates no results dir"

out="$("$CF" -C "$T" -s workspace-write 'x' 2>&1)"; rc=$?
check $rc 0 "-s workspace-write without --yes previews (exit 0)"
echo "$out" | grep -q 'Preview only'; check $? 0 "…and says so"
[ ! -e "$T/.fleet" ]; check $? 0 "…and launches nothing"

out="$("$CF" -C "$T" -w 'x' 2>&1)"; echo "$out" | grep -q 'Preview only'; check $? 0 "-w without --yes previews"
out="$("$CF" -C "$T" --net 'x' 2>&1)"; echo "$out" | grep -q 'Preview only'; check $? 0 "--net without --yes previews"

# With --yes the gate opens and the next wall is the missing codex binary (exit 1), never a launch.
"$CF" -C "$T" -s workspace-write --yes 'x' >/dev/null 2>&1; check $? 1 "--yes is honored (falls through to the codex dependency check)"
[ ! -e "$T/.fleet" ]; check $? 0 "…and still nothing was created before the dependency check"

"$CF" -C "$T" -n 51 'x' >/dev/null 2>&1; check $? 2 "51 jobs exceeds MAX_JOBS=50 → exit 2"
"$CF" -C "$T" -j 17 'x' >/dev/null 2>&1; check $? 2 "-j 17 exceeds MAX_CONCURRENCY=16 → exit 2"
"$CF" -C "$T" -s nope 'x' >/dev/null 2>&1; check $? 2 "invalid sandbox → exit 2"
"$CF" -C "$T" --bogus 'x' >/dev/null 2>&1; check $? 2 "unknown flag → exit 2"
"$CF" -C "$T" >/dev/null 2>&1; check $? 2 "no prompt → exit 2"
"$CF" -C "$T" --explain -f "$T/none.txt" >/dev/null 2>&1; check $? 2 "unreadable jobs file → exit 2"

exit $fail
