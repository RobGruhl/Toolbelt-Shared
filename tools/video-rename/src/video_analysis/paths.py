"""Where this tool keeps its state, and the audit + rename logs (SENSIBILITIES #7, #11).

Everything lives under $VIDEO_RENAME_HOME (default ~/.local/share/video-rename/), never in
the tree: the dir is 700, every file 600. Two append-only logs:

  audit.log      one line per paid call and per rename — timestamp, verb, target, fields
  renames.jsonl  one JSON record per rename or undo — the data `undo` replays

The same audit line is also written to stderr so it survives a redirected stdout.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

TOOL = "video-rename"


def toolbelt_root() -> Path:
    """The belt this tool lives in: $TOOLBELT, else four levels above this file."""
    env = os.environ.get("TOOLBELT")
    if env:
        return Path(env).expanduser()
    # <root>/tools/video-rename/src/video_analysis/paths.py
    return Path(__file__).resolve().parents[4]


def tool_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def home() -> Path:
    env = os.environ.get("VIDEO_RENAME_HOME")
    return Path(env).expanduser() if env else Path.home() / ".local" / "share" / TOOL


def ensure_home() -> Path:
    h = home()
    h.mkdir(parents=True, exist_ok=True, mode=0o700)
    return h


def audit_path() -> Path:
    return home() / "audit.log"


def renames_path() -> Path:
    return home() / "renames.jsonl"


def plans_dir() -> Path:
    return home() / "plans"


def display(p: Path | str) -> str:
    s = str(p)
    h = str(Path.home())
    return "~" + s[len(h):] if s.startswith(h + os.sep) else s


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _append(path: Path, line: str) -> None:
    ensure_home()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def audit(verb: str, target: Path | str, **fields: object) -> str:
    """Write one grep-able audit line to stderr and to audit.log. Never a key, never a frame."""
    parts = [f"[{TOOL} audit]", _now_iso(), f"verb={verb}", f"target={json.dumps(display(target))}"]
    parts += [f"{k}={json.dumps(v) if isinstance(v, str) else v}" for k, v in fields.items()]
    line = " ".join(parts)
    print(line, file=sys.stderr)
    _append(audit_path(), line)
    return line


def record_rename(verb: str, src: Path, dst: Path, **extra: object) -> dict:
    """Append one rename/undo record; `undo` reads these back."""
    rec = {"ts": _now_iso(), "verb": verb, "from": str(src), "to": str(dst), **extra}
    _append(renames_path(), json.dumps(rec))
    return rec


def read_renames() -> list[dict]:
    p = renames_path()
    if not p.exists():
        return []
    out: list[dict] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def live_renames(records: list[dict]) -> list[dict]:
    """Renames not yet undone, oldest first. An `undo` record cancels the latest rename whose
    `to` is the undo's `from`."""
    live: list[dict] = []
    for r in records:
        if r.get("verb") == "undo":
            for i in range(len(live) - 1, -1, -1):
                if live[i]["to"] == r["from"] and live[i]["from"] == r["to"]:
                    del live[i]
                    break
        elif r.get("verb") == "rename":
            live.append(r)
    return live


def write_plan(plan: dict) -> Path:
    d = plans_dir()
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    ensure_home()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = d / f"{stamp}.json"
    n = 2
    while path.exists():
        path = d / f"{stamp}-{n}.json"
        n += 1
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=2)
        f.write("\n")
    return path


def read_plan(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("tool") != TOOL or not isinstance(data.get("entries"), list):
        raise ValueError(f"{path} is not a {TOOL} plan file")
    return data
