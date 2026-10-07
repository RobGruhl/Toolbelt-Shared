"""OpenAI hosted speech-to-text backend (paid, off-host). Explicit opt-in via --backend openai.

Same multipart shape as whisper.cpp (POST /v1/audio/transcriptions); the differences are the
bearer key, the model name, the 25 MB upload limit, and that every call is billed. Model
capabilities and pricing: see spend.RATES_USD_PER_MIN and the contract in CLAUDE.md.
"""

from __future__ import annotations

from pathlib import Path

import httpx

from .base import Segment, TranscriptionBackend, TranscriptionResult

OPENAI_BASE_URL = "https://api.openai.com"

# Models and what each is for. `response_format` is whatever the model supports: only
# whisper-1 returns verbose_json (segments for srt/vtt); diarize returns diarized_json.
MODELS: dict[str, str] = {
    "gpt-transcribe": "default: best WER per dollar; text only",
    "gpt-4o-transcribe-diarize": "speaker labels; needs chunking_strategy=auto over 30 s",
    "whisper-1": "only cloud model with segment timestamps (srt/vtt)",
    "gpt-4o-transcribe": "previous generation",
    "gpt-4o-mini-transcribe": "previous generation, cheapest",
}


class OpenAIBackend(TranscriptionBackend):
    def __init__(self, api_key: str, *, model: str = "gpt-transcribe",
                 base_url: str = OPENAI_BASE_URL, timeout: float = 600.0):
        self._api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.last_request_id: str = "-"
        self.last_usage: str = "-"

    def is_available(self) -> bool:
        """Unauthenticated reachability only; a dead key surfaces as 401 on the real call."""
        try:
            r = httpx.get(f"{self.base_url}/v1/models", timeout=5.0)
            return r.status_code in (200, 401, 403)
        except httpx.RequestError:
            return False

    def request_plan(self, audio_path: Path, *, language: str | None, prompt: str | None,
                     timestamps: bool) -> dict[str, str]:
        """The form fields the real call sends — shared with --explain so they cannot drift."""
        data: dict[str, str] = {"model": self.model}
        if self.model == "gpt-4o-transcribe-diarize":
            data["response_format"] = "diarized_json"
            data["chunking_strategy"] = "auto"
        elif timestamps and self.model == "whisper-1":
            data["response_format"] = "verbose_json"
        else:
            data["response_format"] = "json"
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt
        return data

    def transcribe(self, audio_path: Path, *, language: str | None = None,
                   prompt: str | None = None, timestamps: bool = False) -> TranscriptionResult:
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        data = self.request_plan(audio_path, language=language, prompt=prompt, timestamps=timestamps)
        with open(audio_path, "rb") as f:
            response = httpx.post(
                f"{self.base_url}/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {self._api_key}"},
                files={"file": (audio_path.name, f)},
                data=data,
                timeout=self.timeout,
            )
        self.last_request_id = response.headers.get("x-request-id", "-")
        if response.status_code >= 400:
            # Body may echo request details; never the key. Surface the API's own message.
            try:
                msg = response.json().get("error", {}).get("message", response.text[:200])
            except ValueError:
                msg = response.text[:200]
            raise RuntimeError(f"OpenAI {response.status_code}: {msg}")
        body = response.json()
        self.last_usage = _usage_string(body.get("usage"))
        segments: list[Segment] = []
        text = (body.get("text") or "").strip()
        if data["response_format"] == "diarized_json":
            for seg in body.get("segments", []):
                speaker = seg.get("speaker")
                seg_text = (seg.get("text") or "").strip()
                segments.append(Segment(start=seg.get("start", 0.0), end=seg.get("end", 0.0),
                                        text=f"[{speaker}] {seg_text}" if speaker else seg_text))
            if segments and not text:
                text = "\n".join(s.text for s in segments)
        elif "segments" in body:
            segments = [Segment(start=s.get("start", 0.0), end=s.get("end", 0.0),
                                text=(s.get("text") or "").strip()) for s in body["segments"]]
        return TranscriptionResult(text=text, language=body.get("language"),
                                   duration=body.get("duration"), segments=segments)


def _usage_string(usage: dict | None) -> str:
    if not usage:
        return "-"
    if usage.get("type") == "duration":
        return f"type=duration seconds={usage.get('seconds')}"
    if usage.get("type") == "tokens":
        return f"type=tokens in={usage.get('input_tokens')} out={usage.get('output_tokens')}"
    return "type=" + str(usage.get("type"))
