"""Transcription backends."""

from .base import TranscriptionBackend, TranscriptionResult
from .openai_api import OpenAIBackend
from .whisper_cpp import WhisperCppBackend

__all__ = ["TranscriptionBackend", "TranscriptionResult", "WhisperCppBackend", "OpenAIBackend"]
