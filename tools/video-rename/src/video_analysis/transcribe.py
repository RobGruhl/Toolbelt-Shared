"""Optional audio transcription via the belt's `transcribe` CLI (tools/transcription).

Lookup order: {TOOLBELT}/tools/transcription/.venv/bin/transcribe (TOOLBELT from the
environment, else resolved relative to this tool's own path), then PATH. Missing is a
degraded mode, not an error: the caller names it and continues visually-only.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .paths import toolbelt_root

MAX_TRANSCRIPT_CHARS = 2000
DEFAULT_TIMEOUT_S = 300


class TranscribeNotFound(RuntimeError):
    pass


def belt_transcribe_path(root: Path | None = None) -> Path:
    return (root or toolbelt_root()) / "tools" / "transcription" / ".venv" / "bin" / "transcribe"


def find_transcribe(root: Path | None = None, path_env: str | None = None) -> Path | None:
    """The binary the tool will shell out to, or None."""
    cand = belt_transcribe_path(root)
    if cand.is_file() and os.access(cand, os.X_OK):
        return cand
    found = shutil.which("transcribe", path=path_env)
    return Path(found) if found else None


def transcribe_video(path: Path, timeout: int = DEFAULT_TIMEOUT_S) -> str:
    """Return a truncated transcript, or raise TranscribeNotFound."""
    binary = find_transcribe()
    if binary is None:
        raise TranscribeNotFound(
            f"`transcribe` not found at {belt_transcribe_path()} or on PATH. "
            "Run `toolbelt setup transcription`, or drop --transcribe."
        )

    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
        out_path = Path(tmp.name)
    try:
        subprocess.run(
            [str(binary), "run", str(path), "-o", str(out_path)],
            check=True,
            timeout=timeout,
            capture_output=True,
        )
        text = out_path.read_text(encoding="utf-8", errors="replace").strip()
    finally:
        out_path.unlink(missing_ok=True)

    if len(text) > MAX_TRANSCRIPT_CHARS:
        text = text[:MAX_TRANSCRIPT_CHARS] + "\n…[truncated]"
    return text
