"""Spend discipline for the paid backend: rates, pre-call estimate, ceiling, audit line.

SENSIBILITIES #3 (ceiling in code), #5 (estimate before the call), #7 (audit line on
spend), #11 (the key never reaches a log or stdout).
"""

from __future__ import annotations

import hashlib
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# --- Rate table (SENSIBILITIES #3) ----------------------------------------------------------
# USD per billed minute. Source: https://developers.openai.com/api/docs/pricing
# Dated so drift is visible; when OpenAI changes a price, edit here and bump the date.
RATES_AS_OF = "2026-08-22"
RATES_USD_PER_MIN: dict[str, float] = {
    "gpt-transcribe": 0.0045,
    "gpt-4o-transcribe": 0.006,
    "gpt-4o-mini-transcribe": 0.003,
    "gpt-4o-transcribe-diarize": 0.006,
    "whisper-1": 0.006,
}
DEFAULT_OPENAI_MODEL = "gpt-transcribe"

# --- Ceilings (SENSIBILITIES #3) -------------------------------------------------------------
# Per-run cost above which `run --backend openai` refuses without --yes. ~3.7 h of audio at
# the default model. --max-usd raises it per run; this constant is the default, not a cap —
# private spend a human chose is legitimate work, so the flag is always honored.
DEFAULT_MAX_USD = 1.00
# OpenAI's hard upload limit; the tool re-encodes once, then refuses.
OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# --- Audit log (SENSIBILITIES #7) -------------------------------------------------------------
DEFAULT_AUDIT_LOG = Path("~/.local/state/toolbelt/transcribe.log")


def audit_log_path() -> Path:
    """Where the append-only audit log lives. TRANSCRIBE_AUDIT_LOG overrides (tests)."""
    override = os.environ.get("TRANSCRIBE_AUDIT_LOG")
    return Path(override).expanduser() if override else DEFAULT_AUDIT_LOG.expanduser()


def rate_for(model: str) -> float | None:
    return RATES_USD_PER_MIN.get(model)


def billed_minutes(duration_s: float) -> int:
    return max(1, math.ceil(duration_s / 60.0))


def estimate_usd(model: str, duration_s: float | None) -> float | None:
    """Estimated charge for one request, or None when duration or rate is unknown."""
    rate = rate_for(model)
    if rate is None or duration_s is None:
        return None
    return round(billed_minutes(duration_s) * rate, 4)


def ffprobe_duration(path: Path) -> float | None:
    """Duration in seconds via ffprobe, before any upload. None when ffprobe is absent or fails."""
    ffprobe = shutil.which("ffprobe") or (
        "/opt/homebrew/bin/ffprobe" if Path("/opt/homebrew/bin/ffprobe").exists() else None
    )
    if not ffprobe:
        return None
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def key_fingerprint(key: str | None) -> str:
    """Identifies which key was used without revealing it: `last4` only."""
    if not key:
        return "none"
    return f"last4={key[-4:]}"


@dataclass
class AuditRecord:
    backend: str                 # local | openai
    model: str
    file: Path
    bytes: int
    duration_s: float | None
    principal: str               # key fingerprint for openai, "local" for whisper.cpp
    usage: str = "-"             # usage.type=duration seconds=N | tokens in=N out=N
    billed_min: int | None = None
    est_usd: float | None = None
    request_id: str = "-"
    chunk: str = "1/1"
    status: str = "ok"
    sha256: str = "-"

    def line(self, ts: datetime | None = None) -> str:
        ts = ts or datetime.now(timezone.utc)
        dur = f"{self.duration_s:.1f}" if self.duration_s is not None else "unknown"
        est = f"{self.est_usd:.4f}" if self.est_usd is not None else "0.0000" if self.backend == "local" else "unknown"
        bm = str(self.billed_min) if self.billed_min is not None else "-"
        return " | ".join([
            ts.isoformat(timespec="seconds"),
            f"principal={self.principal}",
            f"endpoint={self.backend}",
            f"model={self.model}",
            f"file={self.file.name} sha256={self.sha256[:16]} bytes={self.bytes} duration_s={dur}",
            f"usage={self.usage}",
            f"billed_minutes={bm}",
            f"est_usd={est}",
            f"request_id={self.request_id}",
            f"chunk={self.chunk}",
            f"status={self.status}",
        ])


def append_audit(record: AuditRecord, log_path: Path | None = None) -> Path:
    """Append one line (file created 600 under a 700 dir); returns the path written."""
    p = log_path or audit_log_path()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    line = record.line() + "\n"
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a") as f:
        f.write(line)
    return p


def parse_est_usd(line: str) -> float:
    for part in line.split(" | "):
        if part.startswith("est_usd="):
            try:
                return float(part[len("est_usd="):])
            except ValueError:
                return 0.0
    return 0.0


def month_total_usd(month: str | None = None, log_path: Path | None = None) -> tuple[float, int]:
    """(estimated USD, request count) of openai lines in the log for YYYY-MM (default: this month)."""
    p = log_path or audit_log_path()
    month = month or datetime.now(timezone.utc).strftime("%Y-%m")
    if not p.exists():
        return 0.0, 0
    total, n = 0.0, 0
    for line in p.read_text().splitlines():
        if not line.startswith(month) or " endpoint=openai " not in f" {line} ".replace(" | ", "  "):
            continue
        total += parse_est_usd(line)
        n += 1
    return round(total, 4), n


# --- Key resolution (SENSIBILITIES #6, #11) ---------------------------------------------------
KEYCHAIN_SERVICE = "OPENAI_API_KEY"
KEY_FILE = Path("~/.config/toolbelt/transcription.key")


def resolve_openai_key(env: dict[str, str] | None = None, key_file: Path | None = None) -> tuple[str | None, str]:
    """Returns (key, source). Order: $OPENAI_API_KEY, macOS Keychain item OPENAI_API_KEY,
    ~/.config/toolbelt/transcription.key (refused unless mode 600). The key is never printed."""
    env = os.environ if env is None else env
    val = env.get("OPENAI_API_KEY", "").strip()
    if val:
        return val, "env:OPENAI_API_KEY"
    security = shutil.which("security")
    if security:
        try:
            r = subprocess.run(
                [security, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip(), f"keychain:{KEYCHAIN_SERVICE}"
        except (OSError, subprocess.SubprocessError):
            pass
    kf = (key_file or KEY_FILE).expanduser()
    if kf.exists():
        if kf.stat().st_mode & 0o077:
            raise PermissionError(f"{kf} is group/world readable — chmod 600 it first")
        val = kf.read_text().strip()
        if val:
            return val, f"file:{kf}"
    return None, "none"
