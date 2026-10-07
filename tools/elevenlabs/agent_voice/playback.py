"""Audio playback via ffplay pipe streaming."""

import subprocess
import threading
from typing import Iterator


class AudioPlayback:
    """Streams PCM audio chunks to ffplay for low-latency playback."""

    def __init__(self, sample_rate: int = 24000):
        self._sample_rate = sample_rate
        self._current_process: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def play_stream(self, audio_chunks: Iterator[bytes]) -> None:
        """Pipe PCM chunks directly to ffplay. Blocks until playback finishes."""
        self.stop()

        proc = subprocess.Popen(
            [
                "ffplay",
                "-nodisp",
                "-autoexit",
                "-f", "s16le",
                "-ar", str(self._sample_rate),
                "-ch_layout", "mono",
                "-i", "pipe:0",
                "-loglevel", "quiet",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        with self._lock:
            self._current_process = proc

        try:
            for chunk in audio_chunks:
                if proc.stdin is None or proc.poll() is not None:
                    break
                proc.stdin.write(chunk)
            if proc.stdin:
                proc.stdin.close()
            proc.wait()
        except BrokenPipeError:
            pass
        finally:
            with self._lock:
                self._current_process = None

    def stop(self) -> None:
        """Stop currently playing audio."""
        with self._lock:
            if self._current_process and self._current_process.poll() is None:
                self._current_process.terminate()
                self._current_process = None
