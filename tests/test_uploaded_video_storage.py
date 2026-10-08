from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from reels_transfer.github_worker import QueueApiError, SupabaseQueue
from reels_transfer.media import original_reel_is_meta_compatible
from reels_transfer.publisher import InstagramApiError, InstagramPublisher

PROJECT_URL = "https://fwscsiswefezkyfblres.supabase.co"
USER_ID = "123e4567-e89b-42d3-a456-426614174000"
VIDEO_ID = "123e4567-e89b-42d3-a456-426614174001"
OBJECT_PATH = f"{USER_ID}/saved-original.mp4"
SIGNED_PATH = f"/object/sign/reelflow-original-videos/{OBJECT_PATH}?token=short-lived-token"
TEMPORARY_PATH = "worker-temp/0123456789abcdef0123456789abcdef.mp4"
SIGNED_TEMPORARY_PATH = f"/object/sign/reelflow-original-videos/{TEMPORARY_PATH}?token=short-lived-token"


class Response:
    def __init__(self, payload: Any = None, status_code: int = 200, chunks: tuple[bytes, ...] = ()) -> None:
        self.payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self.chunks = chunks
        self.closed = False

    def json(self) -> Any:
        return self.payload

    def iter_content(self, chunk_size: int = 1024 * 1024):
        yield from self.chunks

    def close(self) -> None:
        self.closed = True


class RestSession:
    def __init__(self, gets: list[Response] | None = None, posts: list[Response] | None = None) -> None:
        self.headers: dict[str, str] = {}
        self.get_responses = list(gets or [])
        self.post_responses = list(posts or [])
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.deleted: list[tuple[str, dict[str, Any]]] = []

    def get(self, url: str, **kwargs: Any) -> Response:
        self.calls.append(("GET", url, kwargs))
        return self.get_responses.pop(0)

    def post(self, url: str, **kwargs: Any) -> Response:
        self.calls.append(("POST", url, kwargs))
        return self.post_responses.pop(0)

    def delete(self, url: str, **kwargs: Any) -> Response:
        self.deleted.append((url, kwargs))
        return Response({})


class StorageSession:
    def __init__(self, response: Response) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get(self, url: str, **kwargs: Any) -> Response:
        self.calls.append((url, kwargs))
        return self.response


def video_metadata(**overrides: Any) -> dict[str, Any]:
    return {
        "id": VIDEO_ID,
        "user_id": USER_ID,
        "storage_path": OBJECT_PATH,
        "mime_type": "video/mp4",
        "size_bytes": 8,
        "cleanup_pending": False,
        **overrides,
    }


def test_private_video_download_uses_owner_scoped_short_signed_url(tmp_path: Path) -> None:
    rest = RestSession(
        gets=[Response([video_metadata()])],
        posts=[Response({"signedURL": SIGNED_PATH})],
    )
    streamed = Response(chunks=(b"priv", b"ate!"))
    storage = StorageSession(streamed)
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest, storage_session=storage)

    local_path, signed_url = queue.download_uploaded_video(
        {"user_id": USER_ID, "uploaded_video_id": VIDEO_ID}, tmp_path,
    )

    assert local_path.read_bytes() == b"private!"
    assert local_path.suffix == ".mp4"
    assert signed_url.endswith("?token=short-lived-token")
    assert storage.calls[0][0] == signed_url
    assert storage.calls[0][1]["stream"] is True
    assert "service-secret" not in str(storage.calls)
    assert streamed.closed is True


def test_private_video_download_rejects_cross_host_signed_url() -> None:
    rest = RestSession(
        gets=[Response([video_metadata()])],
        posts=[Response({"signedURL": "https://attacker.example/video.mp4?token=bad"})],
    )
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest, storage_session=StorageSession(Response()))

    with pytest.raises(QueueApiError, match="kapsamı doğrulanamadı"):
        queue.signed_uploaded_video({"user_id": USER_ID, "uploaded_video_id": VIDEO_ID})


def test_private_video_download_rejects_wrong_owner_path() -> None:
    rest = RestSession(gets=[Response([video_metadata(storage_path=f"{VIDEO_ID}/other.mp4")])])
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest)

    with pytest.raises(QueueApiError, match="geçerli değil"):
        queue.signed_uploaded_video({"user_id": USER_ID, "uploaded_video_id": VIDEO_ID})


def test_converted_private_video_uses_a_scoped_supabase_signed_url(tmp_path: Path, monkeypatch) -> None:
    converted = tmp_path / "converted.mp4"
    converted.write_bytes(b"converted-mp4")
    from types import SimpleNamespace
    monkeypatch.setattr("reels_transfer.github_worker.uuid4", lambda: SimpleNamespace(hex="0123456789abcdef0123456789abcdef"))
    rest = RestSession(posts=[Response([]), Response({}), Response({"signedURL": SIGNED_TEMPORARY_PATH})])
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest)

    storage_path, signed_url = queue.upload_temporary_video(converted)

    assert storage_path == TEMPORARY_PATH
    assert signed_url == f"{PROJECT_URL}/storage/v1{SIGNED_TEMPORARY_PATH}"
    assert rest.calls[0][1].endswith("/worker_temporary_video_objects")
    assert rest.calls[1][1].endswith(f"/object/reelflow-original-videos/{TEMPORARY_PATH}")
    assert rest.calls[1][2]["headers"]["Content-Type"] == "video/mp4"
    assert rest.calls[2][1].endswith(f"/object/sign/reelflow-original-videos/{TEMPORARY_PATH}")
    assert "service-secret" not in signed_url


def test_private_transcode_upload_enforces_supabase_free_file_limit(tmp_path: Path) -> None:
    converted = tmp_path / "too-large.mp4"
    with converted.open("wb") as handle:
        handle.truncate(50 * 1024 * 1024 + 1)
    rest = RestSession()
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest)

    with pytest.raises(QueueApiError, match="50 MB sınırını aşıyor"):
        queue.upload_temporary_video(converted)
    assert not rest.calls


def test_stale_private_transcodes_delete_storage_object_and_tracker_row() -> None:
    rest = RestSession(gets=[Response([{"storage_path": TEMPORARY_PATH}])])
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest)

    assert queue.cleanup_stale_temporary_videos() == 1
    assert len(rest.deleted) == 2
    assert rest.deleted[0][1]["json"] == {"prefixes": [TEMPORARY_PATH]}
    assert rest.deleted[1][0].startswith(queue.temporary_video_objects_url + "?")


def test_cleanup_deletes_claimed_object_then_marks_metadata_complete() -> None:
    rest = RestSession(posts=[
        Response([{"uploaded_video_id": VIDEO_ID, "storage_path": OBJECT_PATH}]),
        Response(True),
    ])
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest)

    assert queue.cleanup_uploaded_videos() == 1
    assert rest.deleted[0][0].endswith("/storage/v1/object/reelflow-original-videos")
    assert rest.deleted[0][1]["json"] == {"prefixes": [OBJECT_PATH]}
    assert rest.calls[-1][2]["json"] == {"p_uploaded_video_id": VIDEO_ID}


def test_cleanup_rejects_untrusted_storage_path_before_delete() -> None:
    rest = RestSession()
    queue = SupabaseQueue(PROJECT_URL, "service-secret", session=rest)

    with pytest.raises(QueueApiError, match="güvenli değil"):
        queue.delete_uploaded_video_object(f"{USER_ID}/../other.mp4")
    assert not rest.deleted


def test_meta_direct_ingest_accepts_supported_original_without_reencoding(tmp_path: Path, monkeypatch) -> None:
    from reels_transfer import media

    source = tmp_path / "original.mp4"
    source.write_bytes(b"mp4")
    monkeypatch.setattr(media, "ensure_tools_available", lambda: None)
    monkeypatch.setattr(media, "probe", lambda _: {
        "format": {"duration": "12.5", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "avg_frame_rate": "30/1", "width": 1080, "height": 1920},
            {"codec_type": "audio", "codec_name": "aac", "sample_rate": "44100"},
        ],
    })

    assert original_reel_is_meta_compatible(source) is True


def test_meta_direct_ingest_falls_back_for_missing_audio(tmp_path: Path, monkeypatch) -> None:
    from reels_transfer import media

    source = tmp_path / "silent.mp4"
    source.write_bytes(b"mp4")
    monkeypatch.setattr(media, "ensure_tools_available", lambda: None)
    monkeypatch.setattr(media, "probe", lambda _: {
        "format": {"duration": "12.5", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "avg_frame_rate": "30/1", "width": 1080, "height": 1920},
        ],
    })

    assert original_reel_is_meta_compatible(source) is False


class PublisherSession:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.responses = [
            Response({"id": "container-1"}),
            Response({"status_code": "FINISHED"}),
            Response({"id": "media-1"}),
        ]

    def request(self, method: str, url: str, **kwargs: Any) -> Response:
        self.calls.append({"method": method, "url": url, "kwargs": kwargs})
        return self.responses.pop(0)


def test_publisher_uses_signed_original_url_without_temporary_reupload(tmp_path: Path) -> None:
    source = tmp_path / "original.mp4"
    source.write_bytes(b"mp4")
    session = PublisherSession()
    publisher = InstagramPublisher(
        "token", "instagram-user", session=session, api_mode="instagram_login", poll_seconds=0,
    )
    publisher.upload_public_video = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected reupload"))
    signed_url = "https://fwscsiswefezkyfblres.supabase.co/storage/v1/object/sign/reelflow-original-videos/x.mp4?token=temp"

    assert publisher.publish_reel(source, "caption", public_video_url=signed_url) == "media-1"
    assert session.calls[0]["kwargs"]["data"]["video_url"] == signed_url


def test_publisher_rejects_non_https_signed_video_url(tmp_path: Path) -> None:
    source = tmp_path / "original.mp4"
    source.write_bytes(b"mp4")
    publisher = InstagramPublisher("token", "instagram-user", api_mode="instagram_login")

    with pytest.raises(InstagramApiError, match="süreli video bağlantısı güvenli değil"):
        publisher.publish_reel(source, "caption", public_video_url="http://example.com/video.mp4")


def test_publisher_redacts_signed_video_url_from_meta_errors(tmp_path: Path) -> None:
    source = tmp_path / "original.mp4"
    source.write_bytes(b"mp4")
    signed_url = "https://fwscsiswefezkyfblres.supabase.co/storage/v1/object/sign/reelflow-original-videos/x.mp4?token=private-token"
    session = PublisherSession()
    session.responses = [Response({"error": {"message": f"invalid source {signed_url}"}}, status_code=400)]
    publisher = InstagramPublisher("token", "instagram-user", session=session, api_mode="instagram_login")

    with pytest.raises(InstagramApiError) as error:
        publisher.publish_reel(source, "caption", public_video_url=signed_url)

    assert "private-token" not in str(error.value)
    assert "[SIGNED_VIDEO_URL]" in str(error.value)
    assert publisher._private_video_url is None
