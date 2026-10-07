"""ANTHROPIC_API_KEY resolution (SENSIBILITIES #6, #11).

Order: the environment, then ~/.config/toolbelt/video-rename.env (a dotenv file, mode 600
enforced — a group/world-readable file is refused, not read), then the tool's own in-tree
.env as a deprecated fallback that is named on stderr. The key never goes on argv, into a
log line, or to stdout.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import dotenv_values

KEY_VAR = "ANTHROPIC_API_KEY"
KEY_FILE = Path.home() / ".config" / "toolbelt" / "video-rename.env"


class LooseKeyFile(RuntimeError):
    pass


def _read_key_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    if os.name != "nt" and (path.stat().st_mode & 0o077):
        raise LooseKeyFile(f"{path} is group/world readable — chmod 600 it first")
    value = (dotenv_values(path).get(KEY_VAR) or "").strip()
    return value or None


def resolve_api_key(
    env: dict[str, str] | None = None,
    key_file: Path = KEY_FILE,
    legacy_file: Path | None = None,
) -> tuple[str | None, str]:
    """Return (key, source). source is "env" | "file" | "legacy" | "none"."""
    env = os.environ if env is None else env
    value = (env.get(KEY_VAR) or "").strip()
    if value:
        return value, "env"
    value = _read_key_file(key_file)
    if value:
        return value, "file"
    if legacy_file is not None:
        value = _read_key_file(legacy_file)
        if value:
            print(
                f"[video-rename] {KEY_VAR} read from {legacy_file} — deprecated in-tree fallback; "
                f"move it to {key_file} (chmod 600)",
                file=sys.stderr,
            )
            return value, "legacy"
    return None, "none"


def describe_source(source: str, key_file: Path = KEY_FILE) -> str:
    return {
        "env": f"${KEY_VAR}",
        "file": f"{key_file} (mode 600)",
        "legacy": "in-tree .env (deprecated)",
        "none": f"not set — export {KEY_VAR} or write {KEY_VAR}=... to {key_file} (chmod 600)",
    }[source]
