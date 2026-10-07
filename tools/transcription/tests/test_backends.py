"""Tests for transcription backends."""

from hello_transcription.backends.whisper_cpp import WhisperCppBackend


def test_whisper_cpp_backend_init():
    """Test backend initialization with defaults."""
    backend = WhisperCppBackend()
    assert backend.base_url == "http://127.0.0.1:2022"
    assert backend.timeout == 600.0


def test_whisper_cpp_backend_custom_url():
    """Test backend with custom URL."""
    backend = WhisperCppBackend(base_url="http://localhost:3000/")
    assert backend.base_url == "http://localhost:3000"


def test_whisper_cpp_is_available():
    """Test availability check (requires running service)."""
    backend = WhisperCppBackend()
    # This will be True if whisper.cpp is running, False otherwise
    result = backend.is_available()
    assert isinstance(result, bool)
