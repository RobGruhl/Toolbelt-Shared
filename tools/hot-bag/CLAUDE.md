# hot-bag — the agent contract

## Read first

- **What:** one Bash script that holds an Apple Silicon Mac awake with the lid closed
  (`sudo pmset -a disablesleep 1`) so an unattended job runs in a backpack, plus a sudo-free
  watchdog that logs temperature, throttle, battery and tether data every 30s, and an optional
  menu-bar 🔥/⚠️ icon. macOS only.
- **Auth:** the operator's own admin rights. `sudo` prompts at the terminal; on managed Macs
  `ensure_admin` first offers a Privileges.app elevation, confirmed at `/dev/tty`. No token,
  no cache.
- **First read:** `./hot-bag status` (one ping to `PING_HOST`; no sudo, no state change).
- **Writes:** `start`/`on` — the plan is printed, a human types `yes` at `/dev/tty`, then sudo
  prompts. There is no `--yes`. From a process with no controlling terminal it **stages** and
  prints `toolbelt approve hot-bag <code>` (exit 2). `stop`/`off` and `doctor` restore sleep
  and are deliberately ungated.
- **Live here?** `bin/toolbelt doctor hot-bag` — it also reports whether the override is on
  right now and whether a watchdog owns it (wedged = warn).

```bash
./hot-bag status                 # override on/off, temps, throttle, battery, link, data this run
./hot-bag report [run.csv]       # summary + verdict for the current/latest run
./hot-bag start --explain        # the plan: exact pmset line, restore verb, worst case; changes nothing
./hot-bag start                  # you: plan + typed yes + sudo. agent: staged, exit 2
./hot-bag off                    # restore sleep, stop the watchdog, print the report — always honored
./hot-bag doctor                 # recover a wedged state (restores only what hot-bag set)
./hot-bag approve --list         # staged starts awaiting a human
```

Exit codes: `0` ok · `1` failure or declined · `2` usage, **or** `start` staged and waiting for
a human (the approve command is on stderr and as JSON on stdout).

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `status`, `report`, `chime`, `start --explain`, `approve --list`, `_indicator-state` | read | run freely |
| `start` / `on` | write-gated, `/dev/tty` | run **bare**; it stages and prints the approve command — hand that line to the user. Never pass `--yes`/`--force` (they are usage errors anyway) |
| `stop` / `off` | write, ungated | run when the user asks to end a run, or whenever you find the override on with no watchdog. sudo will prompt in the terminal; report the `Clamshell sleep re-enabled` line or its absence verbatim |
| `stop --kill-stray-caffeinate` | write, flag | only when the user named the foreign caffeinate processes `stop` reported |
| `doctor` | write, ungated | run when `status` says wedged |
| `approve <code>` | write-gated, `/dev/tty` | never — that is the user's terminal command |

The restore direction is always yours to take: leaving a Mac that will not sleep in a bag is
the failure this tool exists to prevent, so `off` and `doctor` carry no gate and you should not
hesitate to run them. The on direction is the user's: a cached sudo ticket would let a headless
call flip the override silently, which is exactly why the typed `yes` sits in front of sudo.

## The staged start

With no controlling terminal a bare `start` writes a 600-mode record to
`~/.local/state/hot-bag/pending/<code>` (dir 700; verb and timestamp only — there is no secret
in this tool), audits it, and prints:

```
staged — confirm with:  toolbelt approve hot-bag k3x9q2
```

Give the user that line. In a real terminal it shows the same plan `--explain` prints, takes
a typed `yes` at `/dev/tty`, deletes the record, and runs `start` once in-process — sudo then
prompts as usual. Records expire after 15 minutes and are pruned on every touch;
`approve --discard <code>` drops one. A headless `approve` refuses (exit 1) and keeps the
record; it never re-stages or auto-approves. Do not read the pending file back to "confirm" —
the terminal is the confirmation.

If a bare `start` previews and prompts instead of staging, your shell inherits the operator's
terminal: `/dev/tty` opened, so the tool is treating the call as a human's. Do not type the
`yes` yourself; show the plan and let the user answer.

The gate itself (`tty_has`, `tty_read`, `tty_yes`) is `lib/gate.sh`, sourced by `hot-bag`
through its resolved real path so the symlink in `~/.local/bin` loads the same tree's copy.
It opens `/dev/tty` directly; stdin is never consulted. `test/smoke.sh` asserts both facts.

## What the gate shows

`start_plan()` — the same text for `--explain`, the terminal prompt and `approve`:

1. wait for internet over any link (ping `PING_HOST`, up to 30s)
2. `sudo pmset -a disablesleep 1` — system-wide, all power sources, until restored
3. the marker `~/.local/state/hot-bag/disablesleep.on` (proof hot-bag set it)
4. the sudo-free watchdog → `runs/run-<ts>.csv`, `caffeinate -dimsu -w <watchdog>`, the
   lid-close chime watcher

plus the tier, the restore verb, and the worst case. `pmset -a` (all power sources) is
intentional: the point is running on battery.

## Restore paths, in order of preference

1. **`hot-bag off`** — restores sleep first, then kills the watchdog, caffeinate and lid
   watcher (each verified by pid *and* command line), sweeps strays owned by this script,
   reports any foreign caffeinate, prints the report. A failed sudo does not abort the cleanup;
   the exit is non-zero so the still-on override is loud.
2. **`hot-bag doctor`** — after a crash, forced reboot or cancelled sudo: restores sleep
   **only if the marker exists**, sweeps only verified-ours processes, removes stale pid/lock
   files. An override without the marker was set by something else; doctor names it and
   refuses to clear it.
3. **The traps** — `start` restores sleep if it aborts after the override was set (Ctrl-C, a
   later sudo failure). The watchdog's exit trap tries `sudo -n pmset -a disablesleep 0` on any
   exit; that succeeds only with a passwordless pmset sudoers rule, and the audit line says
   `restored` or `not-restored(no passwordless sudo)`. Without such a rule the machine reads
   **wedged** — `status` warns, the menu-bar shows ⚠️, `toolbelt doctor hot-bag` warns — and
   path 1 or 2 is the fix.
4. By hand: `sudo pmset -a disablesleep 0`.

Optional `LOW_BATT_ACTION=sleep` in the config lets the watchdog restore sleep below
`LOW_BATT_PCT` on battery, also via `sudo -n`; default `none`, so a job is never paused
uninvited.

## Audit trail

Every pmset mutation passes through `pmset_disablesleep`, which appends one line to
`~/.local/state/hot-bag/audit.log` (mode 600) and stderr:

```
[hot-bag audit] 2026-08-22T17:04:11Z verb=pmset target="disablesleep=1" result=ok
```

Staging, approve (approved/declined/discard), the low-battery safety and the watchdog's exit
attempt are audited with their own verbs. "Why is my Mac still awake" is one grep.

## Ceilings and conservative defaults

There is no run-length ceiling by design: the watchdog cannot restore sleep without a
password, so a timer that killed it would only *hide* the override (caffeinate exits with the
watchdog; disablesleep stays). The conservative defaults are in code: `INTERVAL=30`,
`WARN_C/HOT_C/CRIT_C = 80/90/95`, `LOW_BATT_ACTION=none`, chime on, Wi-Fi rejoin off until
`WIFI_SSID` is set. Numeric config is validated at load; a bad value exits 2 before anything
runs. `thermal_state` reports `UNKNOWN`, never `OK`, when no sensor reads.

## Configuration

Environment, then `~/.config/hot-bag/config` (sourced; keep it mode 600 if it holds
`WIFI_PASSWORD`), then the defaults. `config.example` lists every key. `HOTBAG_HOME`
(default `~/.local/state/hot-bag`) holds `runs/*.csv`, `watchdog.pid`, `caffeinate.pid`,
`lidwatch.pid`, `current-run`, `disablesleep.on`, `.lock`, `chime.wav`, `pending/`,
`audit.log`, `indicator.log`.

## What the install steps change outside the tree

`toolbelt setup hot-bag` (each step confirmed at the terminal):

- `~/.local/bin/hot-bag` → `tools/hot-bag/hot-bag` in this clone. A link to another checkout
  is replaced; a real file is renamed `hot-bag.pre-toolbelt`. Your shell and the menu-bar
  indicator both run whatever this resolves to, so a link to an older copy runs a script
  without the gate.
- `./indicator/install.sh` compiles `indicator/HotBagIndicator` with the Xcode CLT `swiftc`,
  renders `indicator/com.hot-bag.indicator.plist.template` with **this directory's absolute
  paths** into `~/Library/LaunchAgents/com.hot-bag.indicator.plist` (overwriting one from an
  earlier checkout), and `launchctl bootstrap`s it in `gui/<uid>`. The doctor warns while the
  plist points elsewhere. `./indicator/install.sh uninstall` removes it.

## Quirks

- **`caffeinate` alone does not survive a lid close** on Apple Silicon; `disablesleep` is the
  only override. caffeinate is kept as a secondary idle guard, lifecycled to the watchdog with
  `-w` so a second `start` cannot orphan it.
- **Admin preflight before every sudo.** `dseditgroup -o checkmember … admin` is live
  directory state (reflects a Privileges elevation that just happened); `id` is stale until
  re-login. Never call `sudo pmset` without `ensure_admin` in front.
- **Temperatures need `smctemp`** (`brew tap narugit/tap && brew install smctemp`) with the
  retry flags `-i25 -n40`; a plain `smctemp -c` returns `0.0`. Without it temps log `NA`.
- **`netstat -ibnI` column positions move between macOS releases**; `read_iface_bytes` finds
  `Ibytes`/`Obytes` by header name. `rx_bytes`/`tx_bytes` are cumulative per interface; the
  data-used figure is `max−min` per interface summed, in both `report` and `run_data_used`
  (keep them in sync).
- **`status` pings** `PING_HOST` once; `_indicator-state` does not, so it is safe to poll.
- **The chime's scoped unmute** is the one place the tool touches unrelated user state: save
  mute+volume, unmute, play in the foreground, restore exactly, every step `|| true`.
  `LID_CHIME_UNMUTE=off` never touches audio.
- **Killing the watchdog waits out its `sleep $INTERVAL`** before the exit trap runs — up to
  30s by default.
- `report` over a CSV truncated mid-write is tolerated by awk, not guarded. The verdict prose
  lives inside a single-quoted awk string: no apostrophes.
- The origin's `install.sh` also makes the `~/.local/bin` symlink (to wherever the script
  lives); `toolbelt setup hot-bag` is the belt path and the doctor checks its result.

## Testing without sudo

```bash
bash test/smoke.sh                                       # what the doctor runs
INTERVAL=20 HOTBAG_HOME=$(mktemp -d) ./hot-bag _watch /tmp/t.csv &   # a few rows, then kill %1
./hot-bag report /tmp/t.csv
```

Only `start`, `off` and `doctor` reach sudo.
