"""The belt's contract: key resolution, audit + rename log, undo, transcribe lookup, ceilings."""
import json
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from video_analysis import auth, cli, config, paths, transcribe

runner = CliRunner()
FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("VIDEO_RENAME_HOME", str(home))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return home


# ---------------------------------------------------------------- key resolution

def test_key_from_env(tmp_path):
    key, source = auth.resolve_api_key({"ANTHROPIC_API_KEY": "x"}, key_file=tmp_path / "none")
    assert (key, source) == ("x", "env")


def test_key_from_600_file(tmp_path):
    f = tmp_path / "video-rename.env"
    f.write_text("ANTHROPIC_API_KEY=filekey\n")
    f.chmod(0o600)
    assert auth.resolve_api_key({}, key_file=f) == ("filekey", "file")


def test_loose_key_file_refused(tmp_path):
    f = tmp_path / "video-rename.env"
    f.write_text("ANTHROPIC_API_KEY=filekey\n")
    f.chmod(0o644)
    with pytest.raises(auth.LooseKeyFile):
        auth.resolve_api_key({}, key_file=f)


def test_legacy_env_is_named_on_stderr(tmp_path, capsys):
    legacy = tmp_path / ".env"
    legacy.write_text("ANTHROPIC_API_KEY=old\n")
    legacy.chmod(0o600)
    assert auth.resolve_api_key({}, key_file=tmp_path / "none", legacy_file=legacy) == ("old", "legacy")
    assert "deprecated" in capsys.readouterr().err


def test_no_key(tmp_path):
    assert auth.resolve_api_key({}, key_file=tmp_path / "none") == (None, "none")


# ---------------------------------------------------------------- audit + rename log

def test_audit_line_lands_in_file_and_stderr(isolated_home, capsys):
    paths.audit("analyze", Path("/tmp/a.mov"), model="m", input_tokens=12)
    assert "verb=analyze" in capsys.readouterr().err
    line = paths.audit_path().read_text().strip()
    assert 'verb=analyze' in line and 'input_tokens=12' in line
    assert oct(paths.audit_path().stat().st_mode & 0o777) == "0o600"
    assert oct(isolated_home.stat().st_mode & 0o777) == "0o700"


def test_live_renames_cancel_on_undo():
    recs = [
        {"verb": "rename", "from": "/a", "to": "/b", "ts": "1"},
        {"verb": "rename", "from": "/c", "to": "/d", "ts": "2"},
        {"verb": "undo", "from": "/d", "to": "/c", "ts": "3"},
    ]
    assert [r["to"] for r in paths.live_renames(recs)] == ["/b"]


def test_plan_roundtrip(isolated_home):
    p = paths.write_plan({"tool": paths.TOOL, "entries": [{"from": "/a", "to": "/b"}]})
    assert oct(p.stat().st_mode & 0o777) == "0o600"
    assert paths.read_plan(p)["entries"][0]["to"] == "/b"
    bad = isolated_home / "bad.json"
    bad.write_text(json.dumps({"entries": []}))
    with pytest.raises(ValueError):
        paths.read_plan(bad)


# ---------------------------------------------------------------- transcribe lookup

def test_transcribe_prefers_belt_venv(tmp_path, monkeypatch):
    root = tmp_path / "belt"
    binary = transcribe.belt_transcribe_path(root)
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    assert transcribe.find_transcribe(root, path_env="") == binary


def test_transcribe_falls_back_to_path(tmp_path):
    on_path = tmp_path / "bin"
    on_path.mkdir()
    b = on_path / "transcribe"
    b.write_text("#!/bin/sh\n")
    b.chmod(0o755)
    assert transcribe.find_transcribe(tmp_path / "nobelt", path_env=str(on_path)) == b
    assert transcribe.find_transcribe(tmp_path / "nobelt", path_env="") is None


def test_toolbelt_root_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("TOOLBELT", str(tmp_path))
    assert paths.toolbelt_root() == tmp_path


# ---------------------------------------------------------------- CLI: ceilings, explain, gate

def test_cli_explain_makes_no_call_and_needs_no_key():
    r = runner.invoke(cli.app, ["analyze", str(FIXTURE), "--explain"])
    assert r.exit_code == 0, r.output
    assert "no API call made" in r.output
    assert "tiny.mp4" in r.output


def test_cli_frames_ceiling():
    r = runner.invoke(cli.app, ["analyze", str(FIXTURE), "--frames", str(config.MAX_FRAMES + 1), "--explain"])
    assert r.exit_code == 2


def test_cli_max_files_ceiling(tmp_path):
    (tmp_path / "a.mp4").write_bytes(b"0")
    (tmp_path / "b.mp4").write_bytes(b"0")
    r = runner.invoke(cli.app, ["analyze", str(tmp_path), "--max-files", "1", "--explain"])
    assert r.exit_code == 2
    r = runner.invoke(cli.app, ["analyze", str(tmp_path), "--max-files", str(config.MAX_FILES + 1), "--explain"])
    assert r.exit_code == 2


def test_cli_analyze_without_key_exits_2():
    r = runner.invoke(cli.app, ["analyze", str(FIXTURE)])
    assert r.exit_code == 2


def test_cli_rename_plan_previews_then_applies_then_undoes(tmp_path, isolated_home):
    src = tmp_path / "IMG_1.mp4"
    src.write_bytes(b"0")
    dst = tmp_path / "2024-01-01__clip.mp4"
    plan = paths.write_plan({"tool": paths.TOOL, "entries": [{"from": str(src), "to": str(dst), "summary": "s"}]})

    r = runner.invoke(cli.app, ["rename", "--plan", str(plan)])
    assert r.exit_code == 0, r.output
    assert src.exists() and not dst.exists()
    assert "--yes" in r.output

    r = runner.invoke(cli.app, ["rename", "--plan", str(plan), "--yes"])
    assert r.exit_code == 0, r.output
    assert dst.exists() and not src.exists()
    recs = paths.read_renames()
    assert recs[-1]["verb"] == "rename" and recs[-1]["to"] == str(dst)
    assert "verb=rename" in paths.audit_path().read_text()

    r = runner.invoke(cli.app, ["undo"])
    assert r.exit_code == 0 and dst.exists()
    r = runner.invoke(cli.app, ["undo", "--yes"])
    assert r.exit_code == 0, r.output
    assert src.exists() and not dst.exists()
    assert paths.live_renames(paths.read_renames()) == []

    r = runner.invoke(cli.app, ["log", "--all"])
    assert r.exit_code == 0 and "undo" in r.output


def test_cli_rename_refuses_overwrite(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"0")
    dst = tmp_path / "b.mp4"
    dst.write_bytes(b"1")
    plan = paths.write_plan({"tool": paths.TOOL, "entries": [{"from": str(src), "to": str(dst)}]})
    r = runner.invoke(cli.app, ["rename", "--plan", str(plan), "--yes"])
    assert r.exit_code == 1
    assert src.exists() and dst.read_bytes() == b"1"


def test_cli_plan_cannot_move_across_directories(tmp_path, isolated_home):
    (tmp_path / "v").mkdir()
    (tmp_path / "other").mkdir()
    src = tmp_path / "v" / "clip.mp4"
    src.write_bytes(b"0")
    dst = tmp_path / "other" / "moved.mp4"
    plan = paths.write_plan({"tool": paths.TOOL, "entries": [{"from": str(src), "to": str(dst)}]})
    r = runner.invoke(cli.app, ["rename", "--plan", str(plan), "--yes"])
    assert r.exit_code == 1
    assert src.exists() and not dst.exists()
    assert paths.read_renames() == []
    assert "verb=rename" not in (paths.audit_path().read_text() if paths.audit_path().exists() else "")


def test_cli_undo_cannot_move_across_directories(tmp_path, isolated_home):
    (tmp_path / "v").mkdir()
    (tmp_path / "other").mkdir()
    cur = tmp_path / "v" / "2024-01-01__clip.mp4"
    cur.write_bytes(b"0")
    paths.record_rename("rename", tmp_path / "other" / "orig.mp4", cur, plan="forged")
    r = runner.invoke(cli.app, ["undo", "--yes"])
    assert r.exit_code == 1
    assert cur.exists() and not (tmp_path / "other" / "orig.mp4").exists()


def test_verbs_table_matches_manifest():
    manifest = json.loads((Path(__file__).parents[1] / "toolbelt.json").read_text())
    declared = {v["name"]: v for v in manifest["verbs"] if v["tier"] != "never"}
    assert set(declared) == set(cli.VERBS)
    for name, spec in cli.VERBS.items():
        assert declared[name]["tier"] == spec["tier"]
        assert declared[name].get("gate") == spec.get("gate")
