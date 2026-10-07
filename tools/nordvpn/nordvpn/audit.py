"""Audit trail for every mutation (SENSIBILITIES #7).

One line per write, to stderr *and* appended to ``data/audit.log`` inside the tool directory
(gitignored; the file is created mode 600, the directory 700). Timestamp, verb, target,
result — never a credential. "What did the agent change last Tuesday" is one grep::

    grep 'verb=connect' tools/nordvpn/data/audit.log
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent.parent
AUDIT_FILE = Path(os.environ.get("NORDVPN_AUDIT_FILE") or TOOL_DIR / "data" / "audit.log")


def format_line(verb: str, target: str, result: str, when: datetime | None = None) -> str:
    stamp = (when or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"[nordvpn audit] {stamp} verb={verb} target={target} result={result}"


def audit(verb: str, target: str, result: str, path: Path = AUDIT_FILE) -> str:
    """Emit the line to stderr and the log file; returns the line. Never raises on I/O."""
    line = format_line(verb, target, result)
    print(line, file=sys.stderr)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(line + "\n")
    except OSError as e:
        print(f"[nordvpn audit] could not append to {path}: {e}", file=sys.stderr)
    return line
