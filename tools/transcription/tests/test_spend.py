"""Spend discipline: ceilings, estimate, audit line, key resolution — no network."""

import os
from pathlib import Path

import pytest

from hello_transcription import spend
from hello_transcription.backends.openai_api import MODELS, OpenAIBackend

FIXTURE = Path(__file__).parent / "fixtures" / "silence-1s.wav"


def test_ceilings_are_code_constants():
    assert spend.DEFAULT_MAX_USD == 1.00
    assert spend.OPENAI_MAX_UPLOAD_BYTES == 25 * 1024 * 1024
    assert spend.DEFAULT_OPENAI_MODEL == "gpt-transcribe"
    assert spend.RATES_AS_OF == "2026-08-22"
    assert set(MODELS) == set(spend.RATES_USD_PER_MIN)


def test_estimate_rounds_up_to_whole_minutes():
    assert spend.billed_minutes(1.0) == 1
    assert spend.billed_minutes(60.0) == 1
    assert spend.billed_minutes(61.0) == 2
    assert spend.estimate_usd("gpt-transcribe", 3600.0) == pytest.approx(0.27)
    assert spend.estimate_usd("whisper-1", 0.5) == pytest.approx(0.006)
    assert spend.estimate_usd("gpt-transcribe", None) is None
    assert spend.estimate_usd("not-a-model", 10.0) is None


def test_key_resolution_env_wins_and_never_prints(tmp_path):
    key, src = spend.resolve_openai_key(env={"OPENAI_API_KEY": "sk-test-abcd1234"}, key_file=tmp_path / "nope")
    assert key == "sk-test-abcd1234" and src == "env:OPENAI_API_KEY"
    assert spend.key_fingerprint(key) == "last4=1234"
    assert spend.key_fingerprint(None) == "none"


def test_key_file_refused_when_loose(tmp_path, monkeypatch):
    # Keychain lookup must not rescue this test on a machine that has the item.
    monkeypatch.setattr(spend.shutil, "which", lambda _: None)
    kf = tmp_path / "transcription.key"
    kf.write_text("sk-file-9999\n")
    kf.chmod(0o644)
    with pytest.raises(PermissionError):
        spend.resolve_openai_key(env={}, key_file=kf)
    kf.chmod(0o600)
    assert spend.resolve_openai_key(env={}, key_file=kf) == ("sk-file-9999", f"file:{kf}")
    assert spend.resolve_openai_key(env={"OPENAI_API_KEY": "  "}, key_file=tmp_path / "absent") == (None, "none")


def test_audit_line_and_month_total(tmp_path, monkeypatch):
    log = tmp_path / "state" / "transcribe.log"
    monkeypatch.setenv("TRANSCRIBE_AUDIT_LOG", str(log))
    rec = spend.AuditRecord(backend="openai", model="gpt-transcribe", file=FIXTURE, bytes=16044,
                            duration_s=1.0, principal="last4=1234", billed_min=1, est_usd=0.0045,
                            request_id="req_x", sha256="ab" * 32)
    line = rec.line()
    assert "endpoint=openai" in line and "est_usd=0.0045" in line and "sk-" not in line
    assert "principal=last4=1234" in line and "request_id=req_x" in line and "chunk=1/1" in line
    p = spend.append_audit(rec)
    assert p == log and (log.stat().st_mode & 0o777) == 0o600
    spend.append_audit(spend.AuditRecord(backend="local", model="ggml-large-v3-turbo", file=FIXTURE,
                                         bytes=1, duration_s=1.0, principal="local", est_usd=0.0))
    total, n = spend.month_total_usd()
    assert n == 1 and total == pytest.approx(0.0045)
    assert spend.month_total_usd("1999-01") == (0.0, 0)


def test_ffprobe_duration_on_fixture():
    d = spend.ffprobe_duration(FIXTURE)
    if d is None:
        pytest.skip("ffprobe not installed")
    assert d == pytest.approx(1.0, abs=0.05)


def test_openai_request_plan_matches_model_capabilities():
    b = OpenAIBackend("sk-x", model="gpt-transcribe")
    assert b.request_plan(FIXTURE, language="en", prompt=None, timestamps=True)["response_format"] == "json"
    w = OpenAIBackend("sk-x", model="whisper-1")
    assert w.request_plan(FIXTURE, language=None, prompt="Claude", timestamps=True) == {
        "model": "whisper-1", "response_format": "verbose_json", "prompt": "Claude"}
    d = OpenAIBackend("sk-x", model="gpt-4o-transcribe-diarize")
    plan = d.request_plan(FIXTURE, language=None, prompt=None, timestamps=False)
    assert plan["response_format"] == "diarized_json" and plan["chunking_strategy"] == "auto"
