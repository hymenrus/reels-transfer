from pathlib import Path

import pytest
import requests

from reels_transfer.publisher import InstagramApiError, InstagramPublisher, refresh_long_lived_token


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300

    def json(self) -> dict:
        return self._payload


class FakeSession:
    """Sırayla önceden tanımlanmış yanıtları döner; istekleri kaydeder."""

    def __init__(self, responses: list[FakeResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []

    def request(self, method: str, url: str, **kwargs):
        self.calls.append({"method": method, "url": url, "kwargs": kwargs})
        if not self._responses:
            raise AssertionError("Beklenmeyen fazladan istek")
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def make_publisher(session: FakeSession, **kwargs) -> InstagramPublisher:
    return InstagramPublisher(
        "TOKEN", "IGID", "v25.0", poll_seconds=0, poll_attempts=3, session=session, **kwargs
    )


def make_instagram_login_publisher(session: FakeSession, **kwargs) -> InstagramPublisher:
    return InstagramPublisher(
        "TOKEN", "IGID", "v25.0", poll_seconds=0, poll_attempts=3,
        session=session, api_mode="instagram_login", **kwargs
    )


def test_remaining_quota_subtracts_usage() -> None:
    session = FakeSession([FakeResponse({"data": [{"quota_usage": 3, "config": {"quota_total": 50}}]})])
    assert make_publisher(session).remaining_quota() == 47


def test_remaining_quota_never_negative() -> None:
    session = FakeSession([FakeResponse({"data": [{"quota_usage": 60, "config": {"quota_total": 50}}]})])
    assert make_publisher(session).remaining_quota() == 0


def test_remaining_quota_raises_on_unexpected_payload() -> None:
    session = FakeSession([FakeResponse({"data": []})])
    with pytest.raises(InstagramApiError):
        make_publisher(session).remaining_quota()


def test_error_response_becomes_api_error_without_token() -> None:
    session = FakeSession([FakeResponse({"error": {"message": "Invalid token"}}, status_code=400)])
    with pytest.raises(InstagramApiError) as excinfo:
        make_publisher(session).remaining_quota()
    assert "TOKEN" not in str(excinfo.value)


def test_network_error_is_wrapped() -> None:
    session = FakeSession([requests.ConnectionError("boom")])
    with pytest.raises(InstagramApiError) as excinfo:
        make_publisher(session).remaining_quota()
    assert "ConnectionError" in str(excinfo.value)


def test_caption_length_is_validated() -> None:
    session = FakeSession([])
    with pytest.raises(InstagramApiError):
        make_publisher(session).create_reel_container("x" * 2201)


def test_container_response_must_include_uri() -> None:
    session = FakeSession([FakeResponse({"id": "123"})])
    with pytest.raises(InstagramApiError):
        make_publisher(session).create_reel_container("merhaba")


def test_upload_rejects_untrusted_host(tmp_path: Path) -> None:
    video = tmp_path / "v.mp4"
    video.write_bytes(b"data")
    session = FakeSession([])
    with pytest.raises(InstagramApiError):
        make_publisher(session).upload_video("https://evil.example.com/upload", video)


def test_upload_sends_offset_and_size(tmp_path: Path) -> None:
    video = tmp_path / "v.mp4"
    video.write_bytes(b"0123456789")
    session = FakeSession([FakeResponse({"success": True})])
    make_publisher(session).upload_video("https://rupload.facebook.com/ig-api-upload/v25.0/123", video)

    headers = session.calls[0]["kwargs"]["headers"]
    assert headers["offset"] == "0"
    assert headers["file_size"] == "10"
    assert headers["Authorization"].startswith("OAuth ")


def test_upload_failure_raises(tmp_path: Path) -> None:
    video = tmp_path / "v.mp4"
    video.write_bytes(b"data")
    session = FakeSession([FakeResponse({"success": False})])
    with pytest.raises(InstagramApiError):
        make_publisher(session).upload_video("https://rupload.facebook.com/x", video)


def test_wait_until_ready_polls_until_finished() -> None:
    session = FakeSession(
        [
            FakeResponse({"status_code": "IN_PROGRESS"}),
            FakeResponse({"status_code": "IN_PROGRESS"}),
            FakeResponse({"status_code": "FINISHED"}),
        ]
    )
    sleeps: list[float] = []
    publisher = InstagramPublisher(
        "TOKEN", "IGID", "v25.0", poll_seconds=1, poll_attempts=5,
        session=session, sleep=sleeps.append,
    )
    publisher.wait_until_ready("container-1")
    assert sleeps == [1, 1]


def test_wait_until_ready_raises_on_error_status() -> None:
    session = FakeSession([FakeResponse({"status_code": "ERROR", "status": "Bozuk video"})])
    with pytest.raises(InstagramApiError, match="Bozuk video"):
        make_publisher(session).wait_until_ready("container-1")


def test_full_publish_flow_order(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    session = FakeSession(
        [
            FakeResponse({"id": "c1", "uri": "https://rupload.facebook.com/ig-api-upload/v25.0/c1"}),
            FakeResponse({"success": True}),
            FakeResponse({"status_code": "FINISHED"}),
            FakeResponse({"id": "media-42"}),
        ]
    )
    media_id = make_publisher(session).publish_reel(video, "açıklama")

    assert media_id == "media-42"
    assert [call["url"].rsplit("/", 1)[-1] for call in session.calls] == [
        "media", "c1", "c1", "media_publish",
    ]


def test_instagram_login_container_uses_graph_instagram_and_video_url() -> None:
    session = FakeSession([FakeResponse({"id": "c1"})])
    publisher = make_instagram_login_publisher(session)
    container_id, upload_uri = publisher.create_reel_container(
        "açıklama", "https://tmpfiles.org/dl/123/reel.mp4"
    )
    assert container_id == "c1"
    assert upload_uri is None
    call = session.calls[0]
    assert "graph.instagram.com" in call["url"]
    assert call["kwargs"]["data"]["video_url"].startswith("https://")


def test_instagram_login_container_passes_selected_reel_cover_url() -> None:
    session = FakeSession([FakeResponse({"id": "c1"})])
    publisher = make_instagram_login_publisher(session)
    cover_url = "https://fwscsiswefezkyfblres.supabase.co/storage/v1/object/sign/reelflow-cover-images/user/cover.jpg?token=private"

    publisher.create_reel_container("açıklama", "https://files.example/reel.mp4", cover_url)

    assert session.calls[0]["kwargs"]["data"]["cover_url"] == cover_url


def test_private_cover_url_is_redacted_from_meta_error(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    cover_url = "https://project.supabase.co/storage/v1/object/sign/reelflow-cover-images/user/cover.jpg?token=secret-cover"
    session = FakeSession([FakeResponse({"error": {"message": cover_url}}, status_code=400)])
    publisher = make_instagram_login_publisher(session)
    publisher._cloudinary.upload_video = lambda path, callback: "https://files.example/reel.mp4"

    with pytest.raises(InstagramApiError) as excinfo:
        publisher.publish_reel(video, "caption", cover_url=cover_url)

    assert cover_url not in str(excinfo.value)
    assert "[SIGNED_COVER_URL]" in str(excinfo.value)


def test_instagram_login_requires_public_url() -> None:
    session = FakeSession([])
    with pytest.raises(InstagramApiError, match="herkese açık"):
        make_instagram_login_publisher(session).create_reel_container("x")


def test_catbox_upload_returns_direct_url(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    session = FakeSession([])

    class UploadSession(FakeSession):
        def post(self, url, **kwargs):
            self.calls.append({"method": "POST", "url": url, "kwargs": kwargs})
            return FakeResponse({}) if False else type("Response", (), {
                "ok": True, "status_code": 200,
                "text": "https://files.catbox.moe/example.mp4",
            })()

        def get(self, url, **kwargs):
            return type("Response", (), {
                "ok": True, "status_code": 206,
                "headers": {"content-type": "video/mp4"},
            })()

    publisher = make_instagram_login_publisher(UploadSession([]), public_upload_mode="catbox")
    assert publisher.upload_public_video(video) == "https://files.catbox.moe/example.mp4"


def test_refresh_long_lived_token_uses_instagram_refresh_endpoint() -> None:
    class RefreshSession:
        def __init__(self, response: FakeResponse) -> None:
            self.response = response
            self.calls = []

        def get(self, url: str, **kwargs):
            self.calls.append((url, kwargs))
            return self.response

    session = RefreshSession(FakeResponse({"access_token": "NEW-TOKEN", "expires_in": 5183944}))
    assert refresh_long_lived_token("OLD-TOKEN", session) == ("NEW-TOKEN", 5183944)
    url, kwargs = session.calls[0]
    assert url.endswith("/refresh_access_token")
    assert kwargs["params"] == {"grant_type": "ig_refresh_token", "access_token": "OLD-TOKEN"}


def test_instagram_login_publish_reports_progress_stages(tmp_path: Path) -> None:
    video = tmp_path / "reel.mp4"
    video.write_bytes(b"video")
    session = FakeSession([
        FakeResponse({"id": "container-1"}),
        FakeResponse({"status_code": "FINISHED"}),
        FakeResponse({"id": "media-1"}),
    ])
    publisher = make_instagram_login_publisher(session)
    progress: list[tuple[int, str]] = []

    def fake_cloudinary_upload(path, callback):
        callback(0)
        callback(50)
        callback(100)
        return "https://res.cloudinary.com/demo/video/upload/reel.mp4"

    publisher._cloudinary.upload_video = fake_cloudinary_upload
    media_id = publisher.publish_reel(video, "caption", progress_callback=lambda percent, stage: progress.append((percent, stage)))

    assert media_id == "media-1"
    assert (72, "Cloudinary'ye video aktarılıyor · %50") in progress
    assert any(percent == 97 and "hazır" in stage for percent, stage in progress)
    assert progress[-2][0] == 98
    assert progress[-1][0] == 99


def test_refresh_error_does_not_leak_access_token() -> None:
    class RefreshSession:
        def get(self, url: str, **kwargs):
            return FakeResponse({"error": {"message": "invalid OLD-TOKEN"}}, status_code=400)

    with pytest.raises(InstagramApiError) as excinfo:
        refresh_long_lived_token("OLD-TOKEN", RefreshSession())
    assert "OLD-TOKEN" not in str(excinfo.value)
