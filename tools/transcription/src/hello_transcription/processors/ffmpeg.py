"""FFmpeg audio preprocessing for optimal whisper.cpp input."""

import shutil
import subprocess
import tempfile
from pathlib import Path

# Formats that whisper.cpp handles directly
NATIVE_FORMATS = {".wav", ".mp3", ".m4a", ".ogg", ".flac"}


def preprocess_audio(input_path: Path, *, force: bool = False) -> Path:
    """Convert audio to optimal format for whisper.cpp if needed.

    whisper.cpp works best with:
    - 16kHz sample rate
    - Mono channel
    - WAV format

    Args:
        input_path: Path to input audio file.
        force: Force conversion even for native formats.

    Returns:
        Path to processed audio (may be same as input if no conversion needed).
    """
    if not force and input_path.suffix.lower() in NATIVE_FORMATS:
        return input_path

    # Create temp file for converted audio
    temp_dir = Path(tempfile.gettempdir())
    output_path = temp_dir / f"transcribe_{input_path.stem}.wav"

    # Convert to 16kHz mono WAV
    ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    cmd = [
        ffmpeg,
        "-y",  # Overwrite output
        "-i",
        str(input_path),
        "-ar",
        "16000",  # 16kHz sample rate
        "-ac",
        "1",  # Mono
        "-c:a",
        "pcm_s16le",  # 16-bit PCM
        str(output_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg conversion failed: {result.stderr}")

    return output_path


def shrink_for_upload(input_path: Path, max_bytes: int) -> Path:
    """Re-encode to 16 kHz mono 32 kbps MP3 when a file exceeds a hosted backend's upload cap.

    Returns the input untouched when it already fits; raises when ffmpeg is missing or the
    result still exceeds max_bytes (the caller refuses rather than splitting silently).
    """
    if input_path.stat().st_size <= max_bytes:
        return input_path
    ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    if not Path(ffmpeg).exists():
        raise RuntimeError(
            f"{input_path.name} is over {max_bytes // (1024 * 1024)} MB and ffmpeg is not installed to shrink it"
        )
    output_path = Path(tempfile.gettempdir()) / f"transcribe_upload_{input_path.stem}.mp3"
    cmd = [ffmpeg, "-y", "-i", str(input_path), "-vn", "-ar", "16000", "-ac", "1",
           "-b:a", "32k", str(output_path)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg re-encode failed: {result.stderr[-400:]}")
    if output_path.stat().st_size > max_bytes:
        raise RuntimeError(
            f"{input_path.name} is still over the upload cap after re-encoding; split it with "
            f"`ffmpeg -i {input_path.name} -f segment -segment_time 3600 part%02d.mp3` and run each part"
        )
    return output_path
