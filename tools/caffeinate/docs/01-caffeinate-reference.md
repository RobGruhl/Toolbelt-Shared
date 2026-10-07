# caffeinate Reference

macOS system utility that creates power assertions to prevent sleep.

**Location:** `/usr/bin/caffeinate`

## Synopsis

```
caffeinate [-disu] [-t timeout] [-w pid] [utility arguments...]
```

## Flags

| Flag | Assertion | What It Prevents |
|------|-----------|-----------------|
| `-d` | PreventUserIdleDisplaySleep | Display from sleeping |
| `-i` | PreventUserIdleSystemSleep | System from idle sleeping (default if no flags) |
| `-m` | PreventDiskIdleSleep | Disk from idle sleeping |
| `-s` | PreventSystemSleep | System from sleeping (AC power only) |
| `-u` | UserIsActive | Declares user active, turns on display if off (5s default timeout) |

## Options

| Option | Description |
|--------|-------------|
| `-t seconds` | Drop assertion after timeout. Ignored when wrapping a utility. |
| `-w pid` | Hold assertion until process exits. Ignored when wrapping a utility. |

## Modes of Operation

### 1. Standalone (runs until killed)
```bash
caffeinate -di          # prevent idle + display sleep forever
caffeinate -di -t 3600  # ...for 1 hour
```

### 2. Wrapping a command (runs for command duration)
```bash
caffeinate -i make                    # hold assertion while make runs
caffeinate -i sleep 3600              # keep awake for 1 hour (sleep is the utility)
caffeinate -dis -- long-running-job   # wrap any command
```

### 3. Watching a process (runs until PID exits)
```bash
caffeinate -w $(pgrep -f my-build)
```

## Notes

- `-s` only works on AC power — on battery, this flag is silently ignored
- `-u` without `-t` defaults to 5 seconds
- With no flags at all, `-i` is implied
- Multiple flags combine: `-dis` = idle + display + system sleep prevention
- Wrapping a command: caffeinate forks, execs the command, holds assertions until it exits
