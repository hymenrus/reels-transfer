from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

from reels_transfer import downloader, github_worker
from reels_transfer.downloader import DownloadError


class Response:
    def __init__(self, payload=None, status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300

    def json(self):
        return self.payload


class Session:
    def __init__(self, *, posts=None, gets=None, patches=None) -> None:
        self.headers = {}
        self.posts = list(posts or [])
        self.gets = list(gets or [])
        self.patches = list(patches or [])
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.posts.pop(0)

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.gets.pop(0)

    def patch(self, url, **kwargs):
        self.calls.append(("PATCH", url, kwargs))
        return self.patches.pop(0)

    def delete(self, url, **kwargs):
        self.calls.append(("DELETE", url, kwargs))
        return Response({})


def test_downloader_applies_optional_transfer_size_limit(monkeypatch, tmp_path: Path) -> None:
    clip = tmp_path / "ABC123.mp4"
    clip.write_bytes(b"small-video")
    captured = {}

    class FakeYoutubeDL:
        def __init__(self, options):
            captured.update(options)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def extract_info(self, url, download):
            assert download is True
            return {"requested_downloads": [{"filepath": str(clip)}]}

    monkeypatch.setattr(downloader.yt_dlp, "YoutubeDL", FakeYoutubeDL)
    result = downloader.download_reel(
        "https://www.instagram.com/reel/ABC123/", "ABC123", tmp_path,
        max_filesize_bytes=50 * 1024 * 1024,
    )
    assert result == clip
    assert captured["max_filesize"] == 50 * 1024 * 1024


def test_worker_accepts_only_canonical_instagram_video_links() -> None:
    job = {"shortcode": "ABC123", "source_url": "https://www.instagram.com/reel/ABC123/"}
    assert github_worker._canonical_import_url(job) == job["source_url"]
    assert github_worker._canonical_import_url({"shortcode": "ABC123", "source_url": "https://instagram.com/p/ABC123/"}) == job["source_url"]
    for bad in [
        {"shortcode": "ABC123", "source_url": "https://evil.example/reel/ABC123/"},
        {"shortcode": "ABC123", "source_url": "https://instagram.com/reel/XYZ789/"},
        {"shortcode": "ABC123", "source_url": "https://instagram.com/reel/ABC123/?token=secret"},
        {"shortcode": "ABC123", "source_url": "http://instagram.com/reel/ABC123/"},
    ]:
        with pytest.raises(DownloadError):
            github_worker._canonical_import_url(bad)


def test_import_worker_downloads_to_owner_scoped_private_archive(monkeypatch, tmp_path: Path) -> None:
    owner = "123e4567-e89b-42d3-a456-426614174000"
    job = {
        "id": "import-1", "user_id": owner, "shortcode": "ABC123",
        "source_url": "https://www.instagram.com/reel/ABC123/", "attempts": 1,
    }
    calls = []

    class FakeQueue:
        def claim_video_import_job(self):
            return job if not calls else None

        def update_video_import(self, imported_job, **fields):
            calls.append(("progress", fields))
            return True

        def upload_imported_video(self, imported_job, video_path):
            assert video_path.read_bytes() == b"instagram-video"
            calls.append(("upload", str(video_path)))
            return {
                "storage_path": f"{owner}/0123456789abcdef0123456789abcdef.mp4",
                "mime_type": "video/mp4", "size_bytes": 16,
                "original_filename": "instagram-ABC123.mp4",
            }

        def finish_video_import(self, imported_job, metadata):
            calls.append(("finish", metadata["storage_path"]))
            return "video-id"

        def fail_video_import(self, imported_job, message):
            raise AssertionError(f"unexpected failure: {message}")

    # The claim function returns the single test job once, then no work.
    queue = FakeQueue()
    claim_count = 0
    original_claim = queue.claim_video_import_job

    def claim_once():
        nonlocal claim_count
        claim_count += 1
        return job if claim_count == 1 else None

    queue.claim_video_import_job = claim_once

    def fake_download(url, shortcode, download_dir, cookies_file, *, max_filesize_bytes):
        assert url == job["source_url"]
        assert shortcode == "ABC123"
        assert cookies_file is None
        assert max_filesize_bytes == 50 * 1024 * 1024
        path = tmp_path / "ABC123.mp4"
        path.write_bytes(b"instagram-video")
        return path

    monkeypatch.setattr(github_worker, "download_reel", fake_download)
    settings = SimpleNamespace(download_dir=tmp_path, cookies_file=None)

    saved, failed = github_worker._process_video_imports(queue, settings, limit=1)

    assert (saved, failed) == (1, 0)
    assert any(call[0] == "upload" for call in calls)
    assert ("finish", f"{owner}/0123456789abcdef0123456789abcdef.mp4") in calls
    assert not (tmp_path / "ABC123.mp4").exists()


def test_import_worker_records_private_download_failure_as_retryable(monkeypatch, tmp_path: Path) -> None:
    job = {
        "id": "import-2", "user_id": "123e4567-e89b-42d3-a456-426614174000",
        "shortcode": "ABC123", "source_url": "https://www.instagram.com/reel/ABC123/",
    }
    failures = []

    class FakeQueue:
        claimed = False

        def claim_video_import_job(self):
            if self.claimed:
                return None
            self.claimed = True
            return job

        def update_video_import(self, imported_job, **fields):
            return True

        def fail_video_import(self, imported_job, message):
            failures.append(message)

    monkeypatch.setattr(github_worker, "download_reel", lambda *args, **kwargs: (_ for _ in ()).throw(DownloadError("Instagram 403")))
    settings = SimpleNamespace(download_dir=tmp_path, cookies_file=None)

    saved, failed = github_worker._process_video_imports(FakeQueue(), settings, limit=1)

    assert (saved, failed) == (0, 1)
    assert failures == ["Instagram videosu indirilemedi. Reel herkese açık ve erişilebilir mi kontrol et; özel veya kısıtlı Reels indirilemeyebilir."]


def test_import_worker_never_deletes_file_when_metadata_verification_is_unavailable(monkeypatch, tmp_path: Path) -> None:
    owner = "123e4567-e89b-42d3-a456-426614174000"
    job = {
        "id": "123e4567-e89b-42d3-a456-426614174001", "user_id": owner,
        "shortcode": "ABC123", "source_url": "https://www.instagram.com/reel/ABC123/",
    }
    deleted = []
    failures = []

    class AmbiguousQueue:
        claimed = False

        def claim_video_import_job(self):
            if self.claimed:
                return None
            self.claimed = True
            return job

        def update_video_import(self, imported_job, **fields):
            return True

        def upload_imported_video(self, imported_job, video_path):
            path = f"{owner}/import-{job['id'].replace('-', '')}.mp4"
            imported_job["active_storage_path"] = path
            return {"storage_path": path, "mime_type": "video/mp4", "size_bytes": 10,
                    "original_filename": "instagram-ABC123.mp4"}

        def finish_video_import(self, imported_job, metadata):
            raise github_worker.QueueApiError("network timeout")

        def video_import_metadata_for_path(self, storage_path):
            raise github_worker.QueueApiError("metadata lookup timeout")

        def valid_import_object_path(self, imported_job, storage_path):
            return True

        def _remove_unregistered_import_object(self, imported_job, storage_path):
            deleted.append(storage_path)

        def fail_video_import(self, imported_job, message):
            failures.append(message)

    def fake_download(url, shortcode, download_dir, cookies_file, *, max_filesize_bytes):
        path = tmp_path / "ABC123.mp4"
        path.write_bytes(b"instagram-video")
        return path

    monkeypatch.setattr(github_worker, "download_reel", fake_download)
    settings = SimpleNamespace(download_dir=tmp_path, cookies_file=None)
    saved, failed = github_worker._process_video_imports(AmbiguousQueue(), settings, limit=1)

    assert (saved, failed) == (0, 1)
    assert deleted == []
    assert job["active_storage_path"].startswith(owner + "/import-")
    assert failures


def test_private_archive_upload_enforces_bucket_size_and_owner_path(tmp_path: Path) -> None:
    owner = "123e4567-e89b-42d3-a456-426614174000"
    job = {"id": "123e4567-e89b-42d3-a456-426614174001", "user_id": owner, "shortcode": "ABC123"}
    session = Session(
        posts=[Response({})],
        patches=[Response([{"id": job["id"]}])],
    )
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "service-key", session=session)
    small = tmp_path / "clip.mp4"
    small.write_bytes(b"mp4-video")

    metadata = queue.upload_imported_video(job, small)

    assert metadata["mime_type"] == "video/mp4"
    assert metadata["size_bytes"] == len(b"mp4-video")
    assert metadata["storage_path"].startswith(owner + "/")
    assert metadata["storage_path"] == f"{owner}/import-{job['id'].replace('-', '')}.mp4"
    upload_call = next(call for call in session.calls if call[0] == "POST" and "/object/reelflow-original-videos/" in call[1])
    assert upload_call[1].endswith("/object/reelflow-original-videos/" + metadata["storage_path"])
    assert upload_call[2]["headers"]["Content-Type"] == "video/mp4"
    assert upload_call[2]["headers"]["x-upsert"] == "true"
    assert "service-key" not in upload_call[1]
    assert session.calls[0][0] == "PATCH"
    assert session.calls[0][2]["json"]["active_storage_path"] == metadata["storage_path"]

    large = tmp_path / "large.mp4"
    with large.open("wb") as handle:
        handle.truncate(50 * 1024 * 1024 + 1)
    empty_session = Session()
    empty_queue = github_worker.SupabaseQueue("https://project.supabase.co", "service-key", session=empty_session)
    with pytest.raises(github_worker.QueueApiError, match="50 MB"):
        empty_queue.upload_imported_video(job, large)
    assert not empty_session.calls


def test_unregistered_import_object_cleanup_retries_and_only_then_clears_path() -> None:
    owner = "123e4567-e89b-42d3-a456-426614174000"
    job_id = "123e4567-e89b-42d3-a456-426614174001"
    storage_path = f"{owner}/import-{job_id.replace('-', '')}.mp4"
    job = {
        "id": job_id, "user_id": owner, "shortcode": "ABC123",
        "status": "failed", "active_storage_path": storage_path,
    }
    session = Session(
        gets=[Response([job]), Response([])],
        patches=[Response([job])],
    )
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "service-key", session=session)

    assert queue.cleanup_unregistered_video_import_objects() == 1
    delete_call = next(call for call in session.calls if call[0] == "DELETE")
    assert delete_call[2]["json"]["prefixes"] == [storage_path]
    clear_call = next(call for call in session.calls if call[0] == "PATCH")
    assert clear_call[2]["json"]["active_storage_path"] is None
    assert "failed" in clear_call[1]


def test_claim_rpc_and_status_patch_are_scoped_and_use_service_endpoints() -> None:
    owner = "123e4567-e89b-42d3-a456-426614174000"
    job = {"id": "import-3", "user_id": owner}
    session = Session(
        posts=[Response([job])],
        patches=[Response([job])],
    )
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "service-key", session=session)

    assert queue.claim_video_import_job() == [job][0]
    assert queue.update_video_import(job, progress=68, stage="Yükleniyor") is True
    assert session.calls[0][1].endswith("/rpc/claim_video_import_job")
    params = parse_qs(urlparse(session.calls[1][1]).query)
    assert params["id"] == ["eq.import-3"]
    assert params["user_id"] == [f"eq.{owner}"]
    assert params["status"] == ["eq.processing"]
