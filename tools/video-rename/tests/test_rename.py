import os
import time
from datetime import datetime
from pathlib import Path

import pytest

from video_analysis.discover import looks_renamed
from video_analysis.rename import apply_rename, build_new_name


def _touch(path: Path, mtime: float | None = None) -> Path:
    path.write_bytes(b"0")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def test_build_new_name_basic(tmp_path):
    video = _touch(tmp_path / "IMG_1234.mov", mtime=time.mktime((2024, 6, 12, 12, 0, 0, 0, 0, -1)))
    new = build_new_name(video, "dog playing fetch beach")
    assert new.parent == tmp_path
    assert new.name == "2024-06-12__dog_playing_fetch_beach.mov"


def test_build_new_name_uses_mtime_date(tmp_path):
    target = time.mktime((2025, 1, 5, 8, 0, 0, 0, 0, -1))
    video = _touch(tmp_path / "clip.mp4", mtime=target)
    new = build_new_name(video, "sunset drive")
    assert new.name.startswith("2025-01-05__")


def test_build_new_name_collision(tmp_path):
    date = datetime.fromtimestamp(time.time()).strftime("%Y-%m-%d")
    existing = _touch(tmp_path / f"{date}__already_here.mov")
    _touch(tmp_path / f"{date}__already_here_2.mov")
    candidate = _touch(tmp_path / "new_video.mov")
    new = build_new_name(candidate, "already here")
    assert new.name == f"{date}__already_here_3.mov"
    # Original collisions stay in place
    assert existing.exists()


def test_build_new_name_empty_title_fallback(tmp_path):
    video = _touch(tmp_path / "clip.mov")
    new = build_new_name(video, "")
    assert "untitled" in new.name


def test_build_new_name_lowercases_extension(tmp_path):
    video = _touch(tmp_path / "CLIP.MOV")
    new = build_new_name(video, "whatever")
    assert new.suffix == ".mov"


def test_apply_rename_success(tmp_path):
    src = _touch(tmp_path / "a.mov")
    dst = tmp_path / "b.mov"
    out = apply_rename(src, dst)
    assert out == dst
    assert dst.exists()
    assert not src.exists()


def test_apply_rename_refuses_overwrite(tmp_path):
    src = _touch(tmp_path / "a.mov")
    dst = _touch(tmp_path / "b.mov")
    import pytest
    with pytest.raises(FileExistsError):
        apply_rename(src, dst)


def test_looks_renamed():
    assert looks_renamed(Path("2024-06-12__dog_playing.mov"))
    assert not looks_renamed(Path("IMG_1234.mov"))
    assert not looks_renamed(Path("2024-6-12__bad.mov"))  # not zero-padded


def test_apply_rename_refuses_cross_directory(tmp_path):
    (tmp_path / "v").mkdir()
    (tmp_path / "other").mkdir()
    src = tmp_path / "v" / "clip.mp4"
    src.write_bytes(b"x")
    with pytest.raises(ValueError):
        apply_rename(src, tmp_path / "other" / "moved.mp4")
    with pytest.raises(ValueError):
        apply_rename(src, tmp_path / "v" / ".." / "other" / "moved.mp4")
    (tmp_path / "v" / "sub").mkdir()
    with pytest.raises(ValueError):
        apply_rename(src, tmp_path / "v" / "sub")
    assert src.exists()
    assert not (tmp_path / "other" / "moved.mp4").exists()
