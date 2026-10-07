# caffeinate (`caff`) — the agent contract

## Read first

- **What:** a bash CLI (`./caff`) and a sourceable lib (`lib/caffeinate.sh`) over macOS `/usr/bin/caffeinate`, which holds IOKit power assertions so the Mac, its display, or its disk will not sleep. Local machine only; nothing leaves the host.
- **Auth:** none. `caffeinate` and `pmset` run as the operator; there is no credential, cache, or network.
- **First read:** `./caff status` — every caffeinate PID on the machine, which of them this tool started, and the `pmset` assertion lines. `./caff assertions` is `pmset -g assertions` verbatim.
- **Writes:** `start`, `stop`, `run` — flag tier. Each prints the exact `caffeinate` invocation and exits 0 until re-run with `--yes`. `--yes` is always honored. Every mutation writes `[caff audit] <utc> verb=… target=…` to stderr and `data/audit.log`.
- **Ceilings:** every `start` has a timeout — default 3600 s, ceiling `MAX_TIMEOUT_S=28800` (8 h) as a code constant in `caff`; `--timeout 0` (forever) and anything past the ceiling exit 2. `run` has no timeout because the wrapped command bounds it.
- **Own process only:** `stop` signals a PID only if this tool's registry (`data/pids`) recorded it *and* `ps` still reports it as `caffeinate`. There is no stop-all verb; `caff_stop_all` was removed from the lib.
- **Live here?** `bin/toolbelt doctor caffeinate --smoke`. macOS only (`platforms: ["darwin"]`).

```bash
./caff status                              # free
./caff start                               # preview: caffeinate -di -t 3600
./caff start -dis --timeout 7200 --yes     # start; prints "undo: caff stop <pid> --yes"
./caff stop <pid> --yes                    # only a pid from ./caff status marked "started by caff"
./caff stop --mine --yes                   # all of them
./caff run -i -- make -j8                  # preview; --yes runs make under an assertion
```

Exit codes: `0` done or previewed · `1` failure (a PID this tool did not start, caffeinate exited at once) · `2` usage (bad letter, timeout past the ceiling, missing target).

## What you may do on your own

| Verb | Tier | You may |
|---|---|---|
| `status`, `assertions` | read | run freely |
| `start`, `stop`, `run` without `--yes` | preview | run freely — nothing changes; show the user the `would …` line |
| `start … --yes` | write-gated, flag | run when the user asked to keep the machine awake; choose the smallest timeout that covers the task and report the `undo:` line |
| `stop <pid> --yes` / `stop --mine --yes` | write-gated, flag | run when the user asked, or to release an assertion you started once the task it covered is done |
| `run … --yes -- <cmd>` | write-gated, flag | run when the user asked for *that command* to run without the machine sleeping; the command is whatever you pass, so name it to the user first |

`--yes` is honored from anyone; the code cannot tell you from the user. The contract is: pass it only for an assertion the user asked for or that covers work the user asked for, and always leave the undo line in your reply. Never hold an assertion "just in case" — a laptop that cannot sleep in a bag is the naive mistake the preview exists to prevent.

## Flags and what they prevent

`-FLAGS` is one token of caffeinate's letters (`-di`, `-dis`, `-m`); default `-di`.

| Letter | Assertion | Prevents |
|---|---|---|
| `d` | PreventUserIdleDisplaySleep | display sleep |
| `i` | PreventUserIdleSystemSleep | idle system sleep (caffeinate's own default when no letter is given) |
| `s` | PreventSystemSleep | all system sleep — **AC power only; silently ignored on battery** |
| `m` | PreventDiskIdleSleep | disk sleep |
| `u` | UserIsActive | declares the user active and wakes the display |

Multiple caffeinate processes stack; each holds independent assertions, which is why `status` lists every PID and marks which are this tool's.

## Own-process guard

`start` records `pid, utc, flags, timeout` in `data/pids` (mode 600, `CAFF_HOME` overrides the dir). `status` and `stop` prune rows whose PID is no longer a `caffeinate` process, so a timed-out start disappears on the next read. `stop <pid>` refuses — exit 1, nothing signalled — when the PID is not in the registry or `ps -o comm=` is not `caffeinate`, so a reused PID can never be hit. A caffeinate another session holds (a build, a presentation) is not this tool's to kill: tell the user the PID and let them stop it where it was started.

`start` reads back: after the fork it greps `pmset -g assertions` for the new PID and says whether the assertion is actually held. The fork is the claim, pmset is the evidence.

## The lib, for scripts

`source lib/caffeinate.sh` gives `caff_start [flags]` (echoes the PID), `caff_stop <pid>` (refuses a non-caffeinate PID), `caff_is_caffeinate <pid>`, `caff_status`, `caff_run [flags] -- cmd`, and `caff_guard [flags]` (starts caffeinate and traps EXIT to kill it — the right shape for a long script). The lib functions carry no preview and no audit line: they are for a script the operator wrote, where the script is the consent. Agents use `./caff`. `examples/01-04` demonstrate each pattern; `docs/01-03` are the caffeinate/pmset reference.

## Quirks

- `-s` on battery is accepted and does nothing; the preview says so.
- `-u` without a timeout would default to 5 s in raw caffeinate; through `start` it carries the normal timeout.
- `caffeinate` exiting immediately after `start --yes` (exit 1, "nothing is held") means the letters were rejected by the binary; re-check them against the table.
- `run` passes the command through `caffeinate -- <cmd>`; the command's own exit code is returned.
