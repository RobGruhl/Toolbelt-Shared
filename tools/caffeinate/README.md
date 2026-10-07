# hello-caffeinate

macOS power assertion management — keep your system, display, and disk awake with `caffeinate`.

## Quick Start

```bash
bash examples/01-basic-keep-awake.sh
```

## Flags

| Flag | Prevents | Notes |
|------|----------|-------|
| `-d` | Display sleep | Keep screen on |
| `-i` | Idle sleep | Default if no flags given |
| `-s` | System sleep | AC power only |
| `-m` | Disk sleep | Keep disk spinning |
| `-u` | (User active) | Wakes display, 5s default timeout |

## Client Library

```bash
source lib/caffeinate.sh

pid=$(caff_start -dis)    # start caffeinate, get PID
caff_status               # check what's running
caff_stop "$pid"          # stop by PID
# no stop-all: the lib signals only PIDs it started (see CLAUDE.md)
caff_guard -di            # auto-cleanup on script exit
caff_run -di -- make      # wrap a command
```

## Examples

| # | File | What |
|---|------|------|
| 01 | `basic-keep-awake.sh` | Start, check status, stop |
| 02 | `wrap-command.sh` | Wrap a command with caffeinate |
| 03 | `guarded-script.sh` | Auto-cleanup via trap on exit |
| 04 | `watch-process.sh` | Caffeinate until a process exits |

## Docs

- [Caffeinate Reference](docs/01-caffeinate-reference.md) — Flags, options, modes
- [Power Assertions & pmset](docs/02-pmset-assertions.md) — Inspecting assertions
- [Common Patterns](docs/03-patterns.md) — Recipes for scripts and sessions
