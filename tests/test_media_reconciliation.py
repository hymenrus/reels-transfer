from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import pytest

from reels_transfer import github_worker
from reels_transfer.publisher import InstagramApiError, InstagramPublisher


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self.payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300

    def json(self) -> dict:
        return self.payload


class FakeGraphSession:
    def __init__(self, responses: list[FakeResponse | Exception]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def request(self, method: str, url: str, **kwargs):
        self.calls.append({"method": method, "url": url, "kwargs": kwargs})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_instagram_login_media_list_pages_until_tracked_date_is_covered() -> None:
    session = FakeGraphSession([
        FakeResponse({
            "data": [{"id": "new-media", "timestamp": "2026-10-07T12:00:00Z"}],
            "paging": {"cursors": {"after": "cursor-1"}, "next": "https://graph.instagram.com/v26.0/ig-1/media?after=cursor-1"},
        }),
        FakeResponse({
            "data": [{"id": "old-media", "timestamp": "2026-10-07T08:00:00Z"}],
            "paging": {},
        }),
    ])
    publisher = InstagramPublisher("private-token", "ig-1", "v26.0", session=session, api_mode="instagram_login")

    media_ids, oldest_seen, complete = publisher.list_own_media_ids(
        datetime(2026, 10, 7, 9, tzinfo=timezone.utc), max_pages=5,
    )

    assert media_ids == {"new-media", "old-media"}
    assert oldest_seen == datetime(2026, 10, 7, 8, tzinfo=timezone.utc)
    assert complete is True
    assert len(session.calls) == 2
    assert "graph.instagram.com/v26.0/ig-1/media" in session.calls[0]["url"]
    assert session.calls[0]["kwargs"]["headers"]["Authorization"] == "Bearer private-token"
    assert parse_qs(urlparse(session.calls[1]["url"]).query) == {}
    assert session.calls[1]["kwargs"]["params"]["after"] == "cursor-1"


def test_instagram_login_media_list_reports_partial_coverage_at_page_limit() -> None:
    session = FakeGraphSession([FakeResponse({
        "data": [{"id": "new-media", "timestamp": "2026-10-07T12:00:00Z"}],
        "paging": {"cursors": {"after": "cursor-1"}, "next": "https://graph.instagram.com/next"},
    })])
    publisher = InstagramPublisher("private-token", "ig-1", "v26.0", session=session, api_mode="instagram_login")

    media_ids, oldest_seen, complete = publisher.list_own_media_ids(
        datetime(2026, 10, 7, 9, tzinfo=timezone.utc), max_pages=1,
    )

    assert media_ids == {"new-media"}
    assert oldest_seen == datetime(2026, 10, 7, 12, tzinfo=timezone.utc)
    assert complete is False


def test_media_listing_is_restricted_to_instagram_login() -> None:
    publisher = InstagramPublisher("token", "ig-1", "v26.0", session=FakeGraphSession([]))
    with pytest.raises(InstagramApiError, match="Instagram Login"):
        publisher.list_own_media_ids(datetime.now(timezone.utc))


class FakeSyncQueue:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.updates: list[tuple[str, bool]] = []
        self.sync_attempts: list[str] = []

    def media_sync_due_accounts(self, cutoff: datetime, limit: int) -> list[dict]:
        return [{"user_id": "user-1", "instagram_user_id": "ig-1", "last_media_sync_at": None}]

    def published_reels(self, user_id: str, instagram_user_id: str) -> list[dict]:
        assert (user_id, instagram_user_id) == ("user-1", "ig-1")
        return self.rows

    def instagram_connection(self, user_id: str) -> dict:
        assert user_id == "user-1"
        now = datetime.now(timezone.utc)
        return {
            "user_id": user_id,
            "instagram_user_id": "ig-1",
            "access_token": "private-token",
            "token_expires_at": (now + timedelta(days=30)).isoformat(),
            "refreshed_at": now.isoformat(),
        }

    def update_media_presence(self, row: dict, present: bool) -> bool:
        self.updates.append((row["id"], present))
        return True

    def mark_media_sync_attempt(self, user_id: str) -> None:
        self.sync_attempts.append(user_id)


def test_partial_inventory_marks_only_missing_rows_inside_covered_window(monkeypatch) -> None:
    queue = FakeSyncQueue([
        {"id": "missing-recent", "user_id": "user-1", "ig_media_id": "media-gone", "published_at": "2026-10-05T10:00:00Z", "is_deleted_on_instagram": False},
        {"id": "still-present", "user_id": "user-1", "ig_media_id": "media-here", "published_at": "2026-10-04T10:00:00Z", "is_deleted_on_instagram": False},
        {"id": "outside-window", "user_id": "user-1", "ig_media_id": "media-old", "published_at": "2026-09-01T10:00:00Z", "is_deleted_on_instagram": False},
    ])

    class FakePublisher:
        def list_own_media_ids(self, oldest_needed_at: datetime, max_pages: int):
            assert oldest_needed_at == datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
            assert max_pages == github_worker.MAX_MEDIA_SYNC_PAGES
            return {"media-here"}, datetime(2026, 10, 1, tzinfo=timezone.utc), False

    monkeypatch.setattr(github_worker, "_publisher", lambda settings, token, ig_id: FakePublisher())

    removed, restored = github_worker._sync_published_instagram_media(queue, settings=None)

    assert (removed, restored) == (1, 0)
    assert queue.updates == [("missing-recent", False)]
    assert queue.sync_attempts == ["user-1"]


def test_api_failure_never_marks_a_published_reel_missing(monkeypatch) -> None:
    queue = FakeSyncQueue([
        {"id": "reel-1", "user_id": "user-1", "ig_media_id": "media-1", "published_at": "2026-10-05T10:00:00Z", "is_deleted_on_instagram": False},
    ])

    class BrokenPublisher:
        def list_own_media_ids(self, oldest_needed_at: datetime, max_pages: int):
            raise InstagramApiError("temporary Meta API error")

    monkeypatch.setattr(github_worker, "_publisher", lambda settings, token, ig_id: BrokenPublisher())

    removed, restored = github_worker._sync_published_instagram_media(queue, settings=None)

    assert (removed, restored) == (0, 0)
    assert queue.updates == []
    assert queue.sync_attempts == ["user-1"]
