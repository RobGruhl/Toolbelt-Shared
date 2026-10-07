"""Abstract backend interface for transcription engines."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Segment:
    """A timestamped segment of transcription."""

    start: float
    end: float
    text: str


@dataclass
class TranscriptionResult:
    """Result from a transcription backend."""

    text: str
    language: str | None = None
    duration: float | None = None
    segments: list[Segment] = field(default_factory=list)


class TranscriptionBackend(ABC):
    """Abstract base class for transcription backends."""

    @abstractmethod
    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        prompt: str | None = None,
        timestamps: bool = False,
    ) -> TranscriptionResult:
        """Transcribe an audio file.

        Args:
            audio_path: Path to the audio file.
            language: ISO 639-1 language code (e.g., 'en', 'es'). Auto-detected if None.
            prompt: Custom vocabulary/context to improve recognition.
            timestamps: Whether to include word/segment timestamps.

        Returns:
            TranscriptionResult with text and optional segments.
        """
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Check if this backend is available and ready."""
        ...
