# Power Assertions & pmset

`caffeinate` works by creating IOKit power assertions. You can inspect these with `pmset`.

## Viewing Assertions

```bash
pmset -g assertions    # list all active power assertions (who's preventing sleep)
pmset -g               # current power settings (shows sleep prevention sources)
pmset -g log           # power event log (verbose)
```

## Assertion Types

| Assertion | Created By | Effect |
|-----------|-----------|--------|
| PreventUserIdleDisplaySleep | `-d` | Display stays on |
| PreventUserIdleSystemSleep | `-i` | System won't idle sleep |
| PreventDiskIdleSleep | `-m` | Disk stays spinning |
| PreventSystemSleep | `-s` | System won't sleep at all (AC only) |
| UserIsActive | `-u` | Simulates user activity, wakes display |

## Reading pmset Output

```
pid 12345(caffeinate): [0x000...] 00:05:30 PreventUserIdleSystemSleep
    Details: caffeinate asserting forever
```

- **pid**: Process holding the assertion
- **time**: How long the assertion has been held
- **Details**: "forever" (no timeout) or "for N secs" (with `-t`)

## Checking if Sleep is Prevented

```bash
# Quick check: is anything preventing sleep?
pmset -g assertions | grep "PreventUserIdleSystemSleep\|PreventSystemSleep"

# Who's keeping the system awake?
pmset -g assertions | grep "caffeinate"
```

## Common Power Settings

```bash
pmset -g | grep sleep
#  sleep         0 (sleep prevented by caffeinate)
#  displaysleep  20 (display sleep prevented by caffeinate)
#  disksleep     10
```

A value of `0` for sleep means "never sleep" (or prevented by assertion).
