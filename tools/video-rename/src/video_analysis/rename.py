"""Build safe, collision-free new filenames and apply renames."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from slugify import slugify


def date_prefix(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")


def build_new_name(original: Path, title: str) -> Path:
    """Return a new Path in the same directory as `original` with YYYY-MM-DD__slug.ext.

    Falls back to a literal "untitled" slug if the title slugifies to an empty
    string. Resolves collisions by appending _2, _3, ... before the extension.
    """
    date = date_prefix(original)
    slug = slugify(title, separator="_", max_length=60) or "untitled"
    ext = original.suffix.lower()
    parent = original.parent
    base = f"{date}__{slug}"

    candidate = parent / f"{base}{ext}"
    if not candidate.exists() or candidate.resolve() == original.resolve():
        return candidate

    i = 2
    while True:
        candidate = parent / f"{base}_{i}{ext}"
        if not candidate.exists() or candidate.resolve() == original.resolve():
            return candidate
        i += 1


class CrossDirectoryRename(ValueError):
    """Raised when a rename would leave the source file's own directory."""


def check_same_directory(src: Path, dst: Path) -> None:
    """Refuse any rename whose destination is not a plain name in src's directory.

    This is the only guard between a hand-written plan file and a move-anywhere
    path, so it compares the *resolved* parents (symlinks and `..` collapsed)
    and requires the destination to be a single path component.
    """
    if dst.name in ("", ".", ".."):
        raise CrossDirectoryRename(f"{dst!s} is not a plain filename")
    if dst.parent.resolve(strict=False) != src.parent.resolve(strict=False):
        raise CrossDirectoryRename(f"{dst} is outside {src.parent}: rename never moves a file across directories")
    if dst.is_symlink() or dst.is_dir():
        raise CrossDirectoryRename(f"{dst} is a directory or symlink, not a plain file")


def apply_rename(src: Path, dst: Path) -> Path:
    """Rename src → dst within src's own directory. Never overwrite an existing different file."""
    check_same_directory(src, dst)
    if src.resolve() == dst.resolve():
        return src
    if dst.exists():
        raise FileExistsError(f"Target {dst} already exists")
    src.rename(dst)
    return dst
