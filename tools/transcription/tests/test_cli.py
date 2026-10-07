"""CLI gates, exercised with no network and no real key."""

from pathlib import Path

from typer.testing import CliRunner

from hello_transcription import spend
from hello_transcription.cli import app

FIXTURE = str(Path(__file__).parent / "fixtures" / "silence-1s.wav")
runner = CliRunner()


def _no_key(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(spend, "resolve_openai_key", lambda env=None, key_file=None: (None, "none"))
    monkeypatch.setenv("TRANSCRIBE_AUDIT_LOG", str(tmp_path / "transcribe.log"))


def test_explain_openai_makes_no_call_and_needs_no_key(monkeypatch, tmp_path):
    _no_key(monkeypatch, tmp_path)
    r = runner.invoke(app, ["run", FIXTURE, "--backend", "openai", "--explain"])
    assert r.exit_code == 0, r.output
    assert "Pre-flight" in r.output and "Bearer ***" in r.output and "gpt-transcribe" in r.output
    assert not (tmp_path / "transcribe.log").exists()


def test_openai_without_key_refuses_before_upload(monkeypatch, tmp_path):
    _no_key(monkeypatch, tmp_path)
    r = runner.invoke(app, ["run", FIXTURE, "--backend", "openai"])
    assert r.exit_code == 1
    assert "no OpenAI key" in r.output
    assert not (tmp_path / "transcribe.log").exists()


def test_ceiling_refuses_without_yes(monkeypatch, tmp_path):
    monkeypatch.setattr(spend, "resolve_openai_key", lambda env=None, key_file=None: ("sk-test-0000", "env:OPENAI_API_KEY"))
    monkeypatch.setenv("TRANSCRIBE_AUDIT_LOG", str(tmp_path / "transcribe.log"))
    monkeypatch.setattr(spend, "ffprobe_duration", lambda _p: 7200.0)  # 2 h → $0.54
    r = runner.invoke(app, ["run", FIXTURE, "--backend", "openai", "--max-usd", "0.10"])
    assert r.exit_code == 2, r.output
    assert "Cost ceiling" in r.output and "--yes" in r.output
    assert not (tmp_path / "transcribe.log").exists()


def test_unknown_duration_requires_yes(monkeypatch, tmp_path):
    monkeypatch.setattr(spend, "resolve_openai_key", lambda env=None, key_file=None: ("sk-test-0000", "env:OPENAI_API_KEY"))
    monkeypatch.setenv("TRANSCRIBE_AUDIT_LOG", str(tmp_path / "transcribe.log"))
    monkeypatch.setattr(spend, "ffprobe_duration", lambda _p: None)
    r = runner.invoke(app, ["run", FIXTURE, "--backend", "openai"])
    assert r.exit_code == 2 and "cannot estimate" in r.output


def test_model_flag_is_openai_only():
    r = runner.invoke(app, ["run", FIXTURE, "--model", "whisper-1", "--explain"])
    assert r.exit_code == 2


def test_local_explain(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSCRIBE_AUDIT_LOG", str(tmp_path / "transcribe.log"))
    r = runner.invoke(app, ["run", FIXTURE, "--explain"])
    assert r.exit_code == 0 and "127.0.0.1:2022" in r.output and "$0 (local)" in r.output


def test_spend_verb_reads_log(monkeypatch, tmp_path):
    monkeypatch.setenv("TRANSCRIBE_AUDIT_LOG", str(tmp_path / "transcribe.log"))
    r = runner.invoke(app, ["spend", "--month", "2000-01"])
    assert r.exit_code == 0 and "$0.0000" in r.output
