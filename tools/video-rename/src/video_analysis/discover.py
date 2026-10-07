"""Walk input paths and yield video files."""
from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

from .config import RENAMED_PATTERN, VIDEO_EXTS

_renamed_re = re.compile(RENAMED_PATTERN)


def is_video(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in VIDEO_EXTS


def looks_renamed(path: Path) -> bool:
    """True if the filename already matches the YYYY-MM-DD__... pattern."""
    return bool(_renamed_re.match(path.name))


def iter_videos(
    inputs: list[Path],
    recursive: bool,
    force: bool,
) -> Iterator[Path]:
    """Yield video files from a mix of files and directories."""
    for root in inputs:
        if root.is_file():
            if is_video(root) and (force or not looks_renamed(root)):
                yield root
            continue
        if not root.is_dir():
            continue
        walker = root.rglob("*") if recursive else root.iterdir()
        for p in walker:
            if is_video(p) and (force or not looks_renamed(p)):
                yield p
