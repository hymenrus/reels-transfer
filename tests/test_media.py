import shutil
import subprocess
from pathlib import Path

import pytest

from reels_transfer.media import MediaError, ensure_tools_available, prepare_for_reels, probe

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe kurulu değil",
)


def make_sample_video(path: Path, *, with_audio: bool = True, size: str = "320x240") -> Path:
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=size={size}:rate=15:duration=1",
    ]
    if with_audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if with_audio:
        command += ["-c:a", "aac"]
    command += [str(path)]
    subprocess.run(command, check=True, capture_output=True)
    return path


def test_prepare_for_reels_produces_vertical_h264(tmp_path: Path) -> None:
    source = make_sample_video(tmp_path / "kaynak.mp4")
    reel = prepare_for_reels(source, tmp_path / "out")

    assert reel.exists() and reel.stat().st_size > 0
    info = probe(reel)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)
    assert video["codec_name"] == "h264"
    assert any(s["codec_type"] == "audio" for s in info["streams"])


def test_prepare_for_reels_adds_silent_audio_when_missing(tmp_path: Path) -> None:
    source = make_sample_video(tmp_path / "sessiz.mp4", with_audio=False)
    reel = prepare_for_reels(source, tmp_path / "out")
    info = probe(reel)
    assert any(s["codec_type"] == "audio" for s in info["streams"])


def test_prepare_for_reels_raises_for_missing_source(tmp_path: Path) -> None:
    with pytest.raises(MediaError):
        prepare_for_reels(tmp_path / "yok.mp4", tmp_path / "out")


def test_ensure_tools_available_passes_when_installed() -> None:
    ensure_tools_available()