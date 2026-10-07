#!/usr/bin/env bash
# hot-bag smoke test — no network, no sudo, no side effect outside a temp HOTBAG_HOME.
# Proves: the script parses; --explain is a pure pre-flight; --yes is refused; a
# headless `start` STAGES (exit 2, 600-mode record, approve command printed) and a
# headless `approve` refuses and keeps the record; report renders a fixture CSV.
set -euo pipefail
cd "$(dirname "$0")/.."
export HOTBAG_HOME; HOTBAG_HOME="$(mktemp -d "${TMPDIR:-/tmp}/hot-bag-smoke.XXXXXX")"
trap 'rm -rf "$HOTBAG_HOME"' EXIT
fail() { echo "smoke FAIL: $*" >&2; exit 1; }

bash -n hot-bag || fail "syntax"
# Contract-vs-code drift: the manifest claims a /dev/tty gate on start and approve. The gate
# must read the controlling terminal, never stdin, and start must refuse --yes.
grep -q 'read -r line </dev/tty' lib/gate.sh || fail "tty_read must read /dev/tty, not stdin"
grep -q '^\. "\$HB_DIR/lib/gate.sh"' hot-bag || fail "hot-bag must source lib/gate.sh"
grep -q '_HB_APPROVED=0' hot-bag || fail "the in-process approval marker must be reset at load"
./hot-bag start --explain | grep -q 'sudo pmset -a disablesleep 1' || fail "--explain did not print the plan"
[ ! -e "$HOTBAG_HOME/disablesleep.on" ] || fail "--explain touched state"

rc=0; ./hot-bag start --yes >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "start --yes should exit 2 (got $rc)"

# Headless: a new session has no controlling terminal, so /dev/tty cannot open.
out="$(node -e '
const {spawnSync}=require("child_process");
const r=spawnSync("./hot-bag",["start"],{detached:true,stdio:["ignore","pipe","pipe"],encoding:"utf8"});
process.stdout.write(String(r.status)+"\n"+r.stdout);')"
rc="${out%%$'\n'*}"; json="${out#*$'\n'}"
[ "$rc" = 2 ] || fail "headless start should exit 2 (got $rc)"
code="$(printf '%s' "$json" | sed -n 's/.*"code":"\([a-z0-9]*\)".*/\1/p')"
[ -n "$code" ] || fail "no staged code in: $json"
[ -f "$HOTBAG_HOME/pending/$code" ] || fail "staged record missing"
[ "$(stat -f %Lp "$HOTBAG_HOME/pending/$code")" = 600 ] || fail "staged record not mode 600"
[ ! -e "$HOTBAG_HOME/disablesleep.on" ] || fail "headless start changed state"
grep -q "verb=start target=\"staged=$code\"" "$HOTBAG_HOME/audit.log" || fail "no audit line for the staged start"

rc=0; node -e '
const {spawnSync}=require("child_process");
process.exit(spawnSync("./hot-bag",["approve",process.argv[1]],{detached:true,stdio:["ignore","pipe","pipe"]}).status);' "$code" || rc=$?
[ "$rc" = 1 ] || fail "headless approve should refuse with exit 1 (got $rc)"
[ -f "$HOTBAG_HOME/pending/$code" ] || fail "headless approve must keep the record"
./hot-bag approve --list | grep -q "^$code " || fail "approve --list did not show $code"
./hot-bag approve --discard "$code" >/dev/null 2>&1 || fail "discard failed"
[ ! -e "$HOTBAG_HOME/pending/$code" ] || fail "discard left the record"

# report over a fixture CSV (the writer's schema, two samples).
csv="$HOTBAG_HOME/runs/run-fixture.csv"
cat > "$csv" <<CSV
epoch,iso,cpu_c,gpu_c,state,cpu_speed_limit,battery_pct,power_source,net_iface,net_status,rx_bytes,tx_bytes
1700000000,2023-11-14T22:13:20,61.0,55.2,OK,100,90,Battery Power,en6,up,1000,500
1700000030,2023-11-14T22:13:50,71.5,60.0,OK,100,88,Battery Power,en6,up,3000,900
CSV
./hot-bag report "$csv" | grep -q 'samples      : 2' || fail "report did not render the fixture"
./hot-bag _indicator-state | grep -Eq '^(on|off|wedged)$' || fail "_indicator-state"
echo "smoke OK: explain is pure, --yes refused, headless start staged ($code) + approve refused, report renders"
