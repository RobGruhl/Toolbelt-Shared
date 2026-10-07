# lib/gate.sh — the human gate for hot-bag. Sourced by ../hot-bag; not executable alone.
#
# Why /dev/tty and not stdin: whoever spawned the process owns its stdin and can pipe
# "yes" into it. The controlling terminal cannot be forged from a child process — either
# a human is at it or it does not open — so a gate that reads /dev/tty is a gate only a
# human can pass, and a failure to open it is a reliable "no human here" signal that the
# caller turns into staging, never a default yes.

# tty_has: could a human be asked right now?
tty_has() { { : </dev/tty; } 2>/dev/null; }

# tty_read <prompt>: prompt on stderr, one line typed at /dev/tty on stdout.
# Non-zero (and empty) when there is no terminal or on EOF.
tty_read() {
  local line=""
  tty_has || return 1
  printf '%s' "$1" >&2
  IFS= read -r line </dev/tty || line=""
  printf '%s' "$line"
}

# tty_yes <answer>: the accepted spellings of consent. Anything else declines.
tty_yes() { case "${1:-}" in yes|y|Y|YES|Yes) return 0 ;; *) return 1 ;; esac; }
