from pathlib import Path

from reels_transfer.state import DOWNLOADED, FAILED, PENDING, PUBLISHED, StateStore


def make_store(tmp_path: Path) -> StateStore:
    return StateStore(tmp_path / "state" / "state.sqlite3")


def test_enqueue_is_idempotent(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "açıklama") is True
    assert store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "açıklama") is False
    assert store.summary() == {PENDING: 1}
    store.close()


def test_pending_jobs_respects_limit_and_order(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    for code in ("AAA", "BBB", "CCC"):
        store.enqueue(code, f"https://www.instagram.com/reel/{code}/", "")
    jobs = store.pending_jobs(2)
    assert [job.shortcode for job in jobs] == ["AAA", "BBB"]
    assert store.pending_jobs(0) == []
    store.close()


def test_lifecycle_and_reset_failed(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "")
    store.mark_downloaded("ABC", "/tmp/ABC.mp4")

    job = store.pending_jobs(1)[0]
    assert job.file_path == "/tmp/ABC.mp4"
    assert store.summary() == {DOWNLOADED: 1}

    store.mark_failed("ABC", "x" * 5000)
    assert store.summary() == {FAILED: 1}
    assert store.reset_failed() == 1
    assert store.summary() == {PENDING: 1}

    store.mark_published("ABC", "media-1")
    assert store.summary() == {PUBLISHED: 1}
    assert store.pending_jobs(5) == []
    store.close()


def test_context_manager_closes_connection(tmp_path: Path) -> None:
    with make_store(tmp_path) as store:
        store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "")
        assert store.summary() == {PENDING: 1}