from __future__ import annotations

from datetime import datetime, timedelta, timezone
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
    job = {"id": "job-1", "user_id": "user-1", "status": "queued"}
    session = FakeRestSession([FakeResponse([job])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.queued(10) == [job]
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert "user_id" in params["select"][0]
    assert "publish_now" in params["select"][0]
    assert params["status"] == ["eq.queued"]
    assert params["order"] == ["publish_now.desc,created_at.asc"]


def test_connection_combines_owner_account_and_private_token() -> None:
    account = {"user_id": "user-1", "instagram_user_id": "ig-1", "username": "creator", "token_expires_at": "2030-01-01T00:00:00Z"}
    credentials = {"user_id": "user-1", "access_token": "private-token", "refreshed_at": "2029-12-01T00:00:00Z"}
    session = FakeRestSession([FakeResponse([account]), FakeResponse([credentials])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    connection = queue.instagram_connection("user-1")
    assert connection["instagram_user_id"] == "ig-1"
    assert connection["access_token"] == "private-token"
    for _, url, _ in session.calls:
        assert parse_qs(urlparse(url).query)["user_id"] == ["eq.user-1"]


def test_queue_status_update_is_scoped_to_job_owner() -> None:
    session = FakeRestSession([FakeResponse([{"id": "job-1"}])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.update({"id": "job-1", "user_id": "user-1"}, status="processing")
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert params["id"] == ["eq.job-1"]
    assert params["user_id"] == ["eq.user-1"]


def test_refreshes_expiring_connection_and_persists_new_token(monkeypatch) -> None:
    now = datetime.now(timezone.utc)
    connection = {
        "user_id": "user-1",
        "instagram_user_id": "ig-1",
        "username": "creator",
        "access_token": "old-token",
        "refreshed_at": (now - timedelta(hours=25)).isoformat(),
        "token_expires_at": (now + timedelta(days=5)).isoformat(),
    }
    calls = []

    class FakeQueue:
        def update_instagram_token(self, user_id, access_token, expires_at):
            calls.append((user_id, access_token, expires_at))

    monkeypatch.setattr(github_worker, "refresh_long_lived_token", lambda token: ("new-token", 5183944))
    updated = github_worker._active_connection(FakeQueue(), connection)

    assert updated["access_token"] == "new-token"
    assert calls and calls[0][0:2] == ("user-1", "new-token")


def test_publication_interval_is_measured_from_last_success() -> None:
    last = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
    connection = {"last_published_at": last.isoformat(), "publish_interval_minutes": 1440}
    assert github_worker._next_publication_at(connection) == last + timedelta(days=1)
    assert github_worker._next_publication_at({"last_published_at": None, "publish_interval_minutes": 60}) is None


def test_latest_published_at_reads_only_the_owners_successful_queue_history() -> None:
    last = "2026-10-07T12:00:00+00:00"
    session = FakeRestSession([FakeResponse([{"published_at": last, "created_at": last}])])
    queue = github_worker.SupabaseQueue("https://project.supabase.co", "server-key", session)

    assert queue.latest_published_at("user-1") == last
    params = parse_qs(urlparse(session.calls[0][1]).query)
    assert params["user_id"] == ["eq.user-1"]
    assert params["status"] == ["eq.published"]
    assert params["select"] == ["published_at,created_at"]
    assert params["limit"] == ["1"]


def test_missing_account_publish_time_falls_back_to_latest_queue_publication() -> None:
    last = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)

    class HistoryQueue:
        def latest_published_at(self, user_id):
            assert user_id == "user-1"
            return last.isoformat()

    connection = {"user_id": "user-1", "last_published_at": None, "publish_interval_minutes": 60}
    recovered = github_worker._connection_with_published_history(HistoryQueue(), "user-1", connection)

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
