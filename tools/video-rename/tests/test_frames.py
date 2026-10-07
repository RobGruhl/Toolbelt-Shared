from pathlib import Path

from PIL import Image

from video_analysis.frames import extract_frames, jpeg_b64

FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"


def test_fixture_exists():
    assert FIXTURE.exists(), (
        "Missing test fixture. Regenerate with: "
        "ffmpeg -y -f lavfi -i 'testsrc=duration=3:size=320x240:rate=10' "
        "-c:v libx264 -pix_fmt yuv420p tests/fixtures/tiny.mp4"
    )


def test_extract_frames_count_and_type():
    frames = extract_frames(FIXTURE, num_frames=4, max_edge=128)
    assert len(frames) >= 1  # PyAV keyframe seeking may round to fewer than requested
    assert len(frames) <= 4
    assert all(isinstance(f, Image.Image) for f in frames)


def test_extract_frames_resizes():
    frames = extract_frames(FIXTURE, num_frames=2, max_edge=128)
    assert all(max(f.size) <= 128 for f in frames)


def test_jpeg_b64_round_trips():
    img = Image.new("RGB", (32, 32), color=(255, 0, 0))
    b64 = jpeg_b64(img)
    assert isinstance(b64, str)
    assert len(b64) > 100  # non-empty JPEG
