"""Audit line on every paid call and every write (SENSIBILITIES #7).

One line to stderr and appended to a 600-mode log file, so "what did the agent spend last
Tuesday" is one grep. Never the key, never the spoken text in full.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LOG = Path.home() / ".local" / "state" / "agent-voice" / "audit.log"


def audit_log_path() -> Path:
    return Path(os.environ.get("AGENT_VOICE_AUDIT_LOG") or DEFAULT_LOG).expanduser()


def format_line(verb: str, **fields) -> str:
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    parts = [f"[agent-voice audit] {ts} verb={verb}"]
    for k, v in fields.items():
        s = str(v)
        if any(ch.isspace() for ch in s) or not s:
            s = '"' + s.replace('"', '\\"') + '"'
        parts.append(f"{k}={s}")
    return " ".join(parts)


def audit(verb: str, **fields) -> str:
    line = format_line(verb, **fields)
    print(line, file=sys.stderr, flush=True)
    try:
        path = audit_log_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(line + "\n")
    except OSError as e:  # the stderr line already went out; never block the call on the file
        print(f"[agent-voice] audit log unwritable: {e}", file=sys.stderr)
    return line
