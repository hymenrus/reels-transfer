from pathlib import Path

import pytest

from reels_transfer.cloudinary_uploader import CloudinaryUploadError, CloudinaryUploader


class Response:
    ok = True
    status_code = 200
    def __init__(self, payload: dict):
        self._payload = payload
    def json(self):
        return self._payload


class Session:
    def __init__(self, response):
        self.response = response
        self.calls = []
    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def test_upload_returns_secure_url(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    session = Session(Response({"secure_url": "https://res.cloudinary.com/demo/video/upload/reel.mp4"}))
    url = CloudinaryUploader("demo", "unsigned-preset", session).upload_video(video)
    assert url.startswith("https://")
    assert "upload_preset" in session.calls[0][1]["data"]


def test_upload_requires_preset(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    with pytest.raises(CloudinaryUploadError, match="CLOUDINARY"):
        CloudinaryUploader("", "", Session(Response({}))).upload_video(video)


def test_upload_reports_cloudinary_error(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    session = Session(Response({"error": {"message": "Invalid preset"}}))
    with pytest.raises(CloudinaryUploadError, match="Invalid preset"):
        CloudinaryUploader("demo", "bad", session).upload_video(video)
