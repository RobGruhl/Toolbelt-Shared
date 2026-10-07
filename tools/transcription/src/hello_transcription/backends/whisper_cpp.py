"""whisper.cpp backend using the Voice Mode service on port 2022."""

import json
from pathlib import Path

import httpx

from .base import Segment, TranscriptionBackend, TranscriptionResult


class WhisperCppBackend(TranscriptionBackend):
    """Backend using whisper.cpp via HTTP API (Voice Mode service)."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:2022",
        timeout: float = 600.0,  # 10 minutes for long files
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def is_available(self) -> bool:
        """Check if whisper.cpp service is running."""
        try:
            response = httpx.get(f"{self.base_url}/health", timeout=5.0)
            return response.status_code == 200
        except httpx.RequestError:
            return False

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        prompt: str | None = None,
        timestamps: bool = False,
    ) -> TranscriptionResult:
        """Transcribe audio using whisper.cpp service."""
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        # Prepare multipart form data
        files = {"file": (audio_path.name, audio_path.read_bytes())}
        data: dict[str, str] = {
            "model": "whisper-1",  # Required by API but ignored by whisper.cpp
            "response_format": "verbose_json" if timestamps else "json",
        }

        if language:
            data["language"] = language

        if prompt:
            data["prompt"] = prompt

        # Make request to OpenAI-compatible endpoint
        response = httpx.post(
            f"{self.base_url}/v1/audio/transcriptions",
            files=files,
            data=data,
            timeout=self.timeout,
        )
        response.raise_for_status()

        result = response.json()

        # Parse response based on format
        if timestamps and "segments" in result:
            segments = [
                Segment(
                    start=seg.get("start", 0.0),
                    end=seg.get("end", 0.0),
                    text=seg.get("text", "").strip(),
                )
                for seg in result.get("segments", [])
            ]
            return TranscriptionResult(
                text=result.get("text", "").strip(),
                language=result.get("language"),
                duration=result.get("duration"),
                segments=segments,
            )
        else:
            return TranscriptionResult(
                text=result.get("text", "").strip(),
                language=result.get("language"),
                duration=result.get("duration"),
            )
