#!/usr/bin/env bash
# caffeinate.sh — reusable shell functions for managing caffeinate from a script.
# Source this file: source lib/caffeinate.sh
#
# Every function here starts or signals only a caffeinate process this shell launched.
# There is deliberately no "stop all" / pkill helper: a caffeinate held by another
# session (a build, a presentation) is not this tool's to kill. Use `caff stop <pid>`
# for a PID this tool started, or kill by hand what you started by hand.

# Start caffeinate in background, echo PID
# Usage: caff_start [-d] [-i] [-s] [-m] [-t timeout]
# Default flags: -di (prevent idle + display sleep)
caff_start() {
  local flags="${@:--di}"
  caffeinate $flags >/dev/null 2>&1 &
  local pid=$!
  echo "$pid"
}

# Stop a caffeinate process by PID. Refuses a PID that is not a caffeinate process,
# so a stale or reused PID never signals something else.
# Usage: caff_stop <pid>
caff_stop() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    echo "Usage: caff_stop <pid>" >&2
    return 1
  fi
  if ! caff_is_caffeinate "$pid"; then
    echo "caff_stop: PID $pid is not a running caffeinate process; nothing signalled" >&2
    return 1
  fi
  kill "$pid" 2>/dev/null
}

# True when <pid> is a live process whose command is caffeinate.
# Usage: caff_is_caffeinate <pid>
caff_is_caffeinate() {
  local pid="$1" comm
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  comm=$(ps -o comm= -p "$pid" 2>/dev/null) || return 1
  [[ "${comm##*/}" == "caffeinate" ]]
}

# Check if caffeinate is running, print PIDs
# Usage: caff_status
# Returns 0 if running, 1 if not
caff_status() {
  local pids
  pids=$(pgrep -x caffeinate)
  if [[ -n "$pids" ]]; then
    echo "caffeinate running: $(echo $pids | tr '\n' ' ')"
    pmset -g assertions 2>/dev/null | grep caffeinate
    return 0
  else
    echo "caffeinate not running"
    return 1
  fi
}

# Run a command wrapped in caffeinate; the assertion is released when the command exits
# Usage: caff_run [-flags] -- command args...
# Example: caff_run -dis -- make -j8
caff_run() {
  caffeinate "$@"
}

# Start caffeinate with automatic cleanup on script exit
# Usage: caff_guard [-d] [-i] [-s]
# Call once at top of script — registers trap to kill on EXIT
caff_guard() {
  local flags="${@:--di}"
  caffeinate $flags &
  local pid=$!
  trap "kill $pid 2>/dev/null" EXIT
  echo "caffeinate guard active (PID $pid)"
}
