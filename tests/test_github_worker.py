from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

from reels_transfer import github_worker


class FakeResponse:
    def __init__(self, payload, status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300

    def json(self):
        return self.payload


class FakeRestSession:
    def __init__(self, responses=None) -> None:
        self.headers = {}
        self.responses = list(responses or [])
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.responses.pop(0)

    def patch(self, url, **kwargs):
        self.calls.append(("PATCH", url, kwargs))
        return self.responses.pop(0)

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.responses.pop(0)


def test_queued_query_includes_user_id_and_queued_filter() -> None:
    job = {"id": "job-1", "user_id": "user-1", "instagram_account_id": "account-1", "status": "queued"}
    session = FakeRestSession([FakeResponse([job])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.queued(10) == [job]
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert "user_id" in params["select"][0]
    assert "instagram_account_id" in params["select"][0]
    assert "publish_now" in params["select"][0]
    assert params["status"] == ["eq.queued"]
    assert params["order"] == ["publish_now.desc,created_at.asc"]


def test_queued_query_can_target_one_specific_reel() -> None:
    reel_id = "12121212-1212-4212-8212-121212121212"
    job = {"id": reel_id, "user_id": "user-1", "instagram_account_id": "account-1", "status": "queued"}
    session = FakeRestSession([FakeResponse([job])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.queued(50, target_job_id=reel_id) == [job]
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert params["id"] == [f"eq.{reel_id}"]
    assert params["status"] == ["eq.queued"]
    assert params["limit"] == ["1"]


def test_connection_combines_owner_account_and_private_token() -> None:
    account = {"id": "account-1", "user_id": "user-1", "instagram_user_id": "ig-1", "username": "creator", "token_expires_at": "2030-01-01T00:00:00Z"}
    credentials = {"user_id": "user-1", "instagram_account_id": "account-1", "access_token": "private-token", "refreshed_at": "2029-12-01T00:00:00Z"}
    session = FakeRestSession([FakeResponse([account]), FakeResponse([credentials])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    connection = queue.instagram_connection("account-1", "user-1")
    assert connection["instagram_user_id"] == "ig-1"
    assert connection["access_token"] == "private-token"
    account_params = parse_qs(urlparse(session.calls[0][1]).query)
    credential_params = parse_qs(urlparse(session.calls[1][1]).query)
    assert account_params["id"] == ["eq.account-1"]
    assert account_params["user_id"] == ["eq.user-1"]
    assert credential_params["instagram_account_id"] == ["eq.account-1"]
    assert credential_params["user_id"] == ["eq.user-1"]


def test_queue_status_update_is_scoped_to_job_owner() -> None:
    session = FakeRestSession([FakeResponse([{"id": "job-1"}])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.update({"id": "job-1", "user_id": "user-1", "instagram_account_id": "account-1"}, status="processing")
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert params["id"] == ["eq.job-1"]
    assert params["user_id"] == ["eq.user-1"]
    assert params["instagram_account_id"] == ["eq.account-1"]


def test_refreshes_expiring_connection_and_persists_new_token(monkeypatch) -> None:
    now = datetime.now(timezone.utc)
    connection = {
        "id": "account-1",
        "user_id": "user-1",
        "instagram_user_id": "ig-1",
        "username": "creator",
        "access_token": "old-token",
        "refreshed_at": (now - timedelta(hours=25)).isoformat(),
        "token_expires_at": (now + timedelta(days=5)).isoformat(),
    }
    calls = []

    class FakeQueue:
        def update_instagram_token(self, account_id, user_id, access_token, expires_at):
            calls.append((account_id, user_id, access_token, expires_at))

    monkeypatch.setattr(github_worker, "refresh_long_lived_token", lambda token: ("new-token", 5183944))
    updated = github_worker._active_connection(FakeQueue(), connection)

    assert updated["access_token"] == "new-token"
    assert calls and calls[0][0:3] == ("account-1", "user-1", "new-token")


def test_publication_interval_is_measured_from_last_success() -> None:
    last = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
    connection = {"last_published_at": last.isoformat(), "publish_interval_minutes": 1440}
    assert github_worker._next_publication_at(connection) == last + timedelta(days=1)
    assert github_worker._next_publication_at({"last_published_at": None, "publish_interval_minutes": 60}) is None


def test_latest_published_at_reads_only_the_target_accounts_successful_queue_history() -> None:
    last = "2026-10-07T12:00:00+00:00"
    session = FakeRestSession([FakeResponse([{"published_at": last, "created_at": last}])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.latest_published_at("account-1", "user-1") == last
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert params["instagram_account_id"] == ["eq.account-1"]
    assert params["user_id"] == ["eq.user-1"]
    assert params["status"] == ["eq.published"]
    assert params["select"] == ["published_at,created_at"]
    assert params["limit"] == ["1"]


def test_missing_account_publish_time_falls_back_to_latest_queue_publication() -> None:
    last = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)

    class HistoryQueue:
        def latest_published_at(self, account_id, user_id):
            assert account_id == "account-1"
            assert user_id == "user-1"
            return last.isoformat()

    connection = {"id": "account-1", "user_id": "user-1", "last_published_at": None, "publish_interval_minutes": 60}
    recovered = github_worker._connection_with_published_history(HistoryQueue(), connection)

    assert recovered["last_published_at"] == last.isoformat()
    assert github_worker._next_publication_at(recovered) == last + timedelta(hours=1)


def test_manual_publish_request_bypasses_only_the_selected_reels_interval() -> None:
    now = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
    due_at = now + timedelta(hours=6)

    assert github_worker._interval_wait_required(due_at, now) is True
    assert github_worker._interval_wait_required(due_at, now, publish_now=True) is False
    assert github_worker._interval_wait_required(now - timedelta(seconds=1), now) is False
    assert github_worker._interval_wait_required(None, now) is False


def test_publication_progress_is_monotonic_and_skips_duplicates() -> None:
    class RecordingQueue:
        def __init__(self):
            self.updates = []

        def update(self, job, **fields):
            self.updates.append(fields)
            return True

    queue = RecordingQueue()
    reporter = github_worker.PublicationProgress(queue, {"id": "job-1", "user_id": "user-1"}, initial_progress=62)
    reporter(62, "Cloudinary · %0")
    reporter(62, "Cloudinary · %0")
    reporter(72, "Cloudinary · %50")
    reporter(66, "Instagram hazırlanıyor")
    reporter(120, "Instagram yayında")

    assert [entry["progress"] for entry in queue.updates] == [62, 72, 72, 98]


def test_finish_publication_uses_atomic_user_scoped_rpc() -> None:
    session = FakeRestSession([FakeResponse(True)])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.finish_publication("user-1", "job-1", "media-1") is True
    method, url, kwargs = session.calls[0]
    assert method == "POST"
    assert url.endswith("/rpc/mark_reel_published")
    assert kwargs["json"] == {"p_user_id": "user-1", "p_id": "job-1", "p_media_id": "media-1"}



def test_worker_applies_publication_interval_per_target_account(monkeypatch, tmp_path) -> None:
    now = datetime.now(timezone.utc)
    account_a = {
        "id": "account-a", "user_id": "user-1", "instagram_user_id": "ig-a", "username": "creator-a",
        "access_token": "token-a", "token_expires_at": (now + timedelta(days=30)).isoformat(),
        "refreshed_at": now.isoformat(), "publish_interval_minutes": 60,
        "last_published_at": (now - timedelta(hours=2)).isoformat(),
        "last_processed_at": (now - timedelta(hours=2)).isoformat(),
    }
    account_b = {
        "id": "account-b", "user_id": "user-1", "instagram_user_id": "ig-b", "username": "creator-b",
        "access_token": "token-b", "token_expires_at": (now + timedelta(days=30)).isoformat(),
        "refreshed_at": now.isoformat(), "publish_interval_minutes": 60,
        "last_published_at": (now - timedelta(minutes=20)).isoformat(),
        "last_processed_at": (now - timedelta(minutes=10)).isoformat(),
    }
    accounts = {"account-a": account_a, "account-b": account_b}
    created = (now - timedelta(minutes=5)).isoformat()
    jobs = [
        {"id": "job-a", "user_id": "user-1", "instagram_account_id": "account-a", "shortcode": "CodeA1", "source_url": "https://www.instagram.com/reel/CodeA1/", "caption": "", "status": "queued", "progress": 0, "attempts": 0, "rights_confirmed": True, "publish_now": False, "created_at": created},
        {"id": "job-b", "user_id": "user-1", "instagram_account_id": "account-b", "shortcode": "CodeB1", "source_url": "https://www.instagram.com/reel/CodeB1/", "caption": "", "status": "queued", "progress": 0, "attempts": 0, "rights_confirmed": True, "publish_now": False, "created_at": created},
    ]

    class FakeQueue:
        def __init__(self):
            self.updates = []
            self.processed_accounts = []
            self.published = []

        def queued(self, limit, target_job_id=None):
            return list(jobs)

        def instagram_connection(self, account_id, user_id):
            assert accounts[account_id]["user_id"] == user_id
            return dict(accounts[account_id])

        def update(self, job, **fields):
            self.updates.append((job["id"], fields))
            return True

        def mark_processed(self, account_id):
            self.processed_accounts.append(account_id)

        def finish_publication(self, user_id, job_id, media_id):
            self.published.append((user_id, job_id, media_id))
            return True

    queue = FakeQueue()
    publishers = []

    class FakePublisher:
        def __init__(self, instagram_user_id):
            self.instagram_user_id = instagram_user_id

        def remaining_quota(self):
            return 5

        def publish_reel(self, reel_file, caption, progress_callback=None):
            publishers.append(self.instagram_user_id)
            return f"media-{self.instagram_user_id}"

    settings = SimpleNamespace(
        api_mode="instagram_login",
        max_posts_per_run=5,
        download_dir=tmp_path,
        cookies_file=None,
        default_caption="",
    )
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "server-key")
    monkeypatch.setattr(github_worker, "load_settings", lambda **kwargs: settings)
    monkeypatch.setattr(github_worker, "ensure_tools_available", lambda: None)
    monkeypatch.setattr(github_worker, "SupabaseQueue", lambda *args: queue)
    monkeypatch.setattr(github_worker, "_publisher", lambda settings, token, ig_id: FakePublisher(ig_id))
    monkeypatch.setattr(github_worker, "_sync_published_instagram_media", lambda queue, settings: (0, 0))

    def download(source_url, shortcode, download_dir, cookies_file):
        path = tmp_path / f"{shortcode}-source.mp4"
        path.write_bytes(b"source")
        return path

    def prepare(source_file, download_dir):
        path = tmp_path / f"{source_file.stem}-ready.mp4"
        path.write_bytes(b"ready")
        return path

    monkeypatch.setattr(github_worker, "download_reel", download)
    monkeypatch.setattr(github_worker, "prepare_for_reels", prepare)

    result = github_worker.run_worker()

    assert result == {"published": 1, "failed": 0, "skipped": 1}
    assert publishers == ["ig-a"]
    assert queue.processed_accounts == ["account-a"]
    assert queue.published == [("user-1", "job-a", "media-ig-a")]
    assert any(job_id == "job-b" and fields.get("status") == "queued" and "Yayın aralığı bekleniyor" in fields.get("stage", "") for job_id, fields in queue.updates)
