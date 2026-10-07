"""Sample frames from a video with PyAV, resize, and JPEG-encode for Claude vision.

PyAV rather than decord/eva-decord: neither ships ARM64 wheels for Python 3.13,
and the batch-read speed they offer is irrelevant at ~8 sampled frames per file.

If PyAV and decord are ever imported together, `import av` MUST come first to
avoid an FFmpeg symbol collision.
"""
from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import av
from PIL import Image


def _uniform_second_targets(duration_s: float, n: int) -> list[float]:
    """Evenly sample n timestamps across a video's duration in seconds.

    Industry-standard pattern from VLM model cards (InternVL2, MiniCPM-V):
    sample at the midpoint of each of n equal segments.
    """
    if duration_s <= 0 or n <= 0:
        return []
    gap = duration_s / n
    return [i * gap + gap / 2 for i in range(n)]


def _resize_longest(img: Image.Image, max_edge: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= max_edge:
        return img
    if w >= h:
        new_w = max_edge
        new_h = round(h * max_edge / w)
    else:
        new_h = max_edge
        new_w = round(w * max_edge / h)
    return img.resize((new_w, new_h), Image.Resampling.LANCZOS)


def extract_frames(
    path: Path,
    num_frames: int,
    max_edge: int,
) -> list[Image.Image]:
    """Return up to `num_frames` uniformly-sampled PIL frames, resized to max_edge."""
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.codec_context.skip_frame = "NONKEY"  # Seek to nearest keyframe; fast enough for a thumbnail sweep.

        duration_s = _container_duration_s(container, stream)
        time_base = float(stream.time_base or 0) or None
        targets = _uniform_second_targets(duration_s, num_frames)

        frames: list[Image.Image] = []
        if not targets or time_base is None:
            # Fallback: grab the first `num_frames` decoded frames.
            for i, frame in enumerate(container.decode(stream)):
                if i >= num_frames:
                    break
                frames.append(_frame_to_pil(frame, max_edge))
            return frames

        for t in targets:
            seek_pts = int(t / time_base)
            try:
                container.seek(seek_pts, any_frame=False, backward=True, stream=stream)
            except av.FFmpegError:
                continue
            for frame in container.decode(stream):
                frames.append(_frame_to_pil(frame, max_edge))
                break  # One decoded frame per seek target is enough.
        return frames


def _container_duration_s(container: "av.container.InputContainer", stream) -> float:
    """Best-effort video duration in seconds."""
    if stream.duration and stream.time_base:
        return float(stream.duration * stream.time_base)
    if container.duration:
        return container.duration / av.time_base
    return 0.0


def _frame_to_pil(frame: "av.VideoFrame", max_edge: int) -> Image.Image:
    img = frame.to_image()
    return _resize_longest(img, max_edge)


def jpeg_b64(img: Image.Image, quality: int = 85) -> str:
    """Encode a PIL image as base64 JPEG for the Claude vision API."""
    buf = BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")
