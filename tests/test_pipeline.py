from dataclasses import replace
from pathlib import Path

import pytest

from reels_transfer import pipeline
from reels_transfer.config import Settings
from reels_transfer.downloader import DownloadError
from reels_transfer.state import FAILED, PUBLISHED, StateStore


def make_settings(tmp_path: Path, max_posts: int = 3) -> Settings:
    return Settings(
        access_token="token",
        ig_user_id="123",
        graph_version="v25.0",
        data_dir=tmp_path / "data",
        max_posts_per_run=max_posts,
        default_caption="",
        cookies_file=None,
        status_poll_seconds=0,
        status_poll_attempts=1,
        api_mode="facebook_login",
        public_upload_mode="none",
    )


class FakePublisher:
    def __init__(self, quota: int = 10, fail: bool = False) -> None:
        self._quota = quota
        self._fail = fail
        self.published: list[str] = []

    def remaining_quota(self) -> int:
        return self._quota

    def publish_reel(self, video_path: Path, caption: str) -> str:
        if self._fail:
            raise pipeline.InstagramApiError("yayın hatası")
        assert video_path.exists()
        self.published.append(caption)
        return f"media-{len(self.published)}"


def _fake_download(url: str, shortcode: str, download_dir: Path, cookies_file: Path | None = None) -> Path:
    """Ağa çıkmadan sahte bir indirme dosyası üretir."""
    download_dir.mkdir(parents=True, exist_ok=True)
    target = download_dir / f"{shortcode}.mp4"
    target.write_bytes(b"video")
    return target


def _fake_prepare(source: Path, out: Path) -> Path:
    """Gerçek ffmpeg dönüşümü yerine dosyayı kopyalar."""
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{source.stem}_reel.mp4"
    target.write_bytes(source.read_bytes())
    return target


@pytest.fixture
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setattr(pipeline, "download_reel", _fake_download)
    monkeypatch.setattr(pipeline, "ensure_tools_available", lambda: None)
    monkeypatch.setattr(pipeline, "prepare_for_reels", _fake_prepare)
    return make_settings(tmp_path)


def test_run_once_publishes_and_cleans_up(tmp_path: Path, settings: Settings) -> None:
    store = StateStore(settings.db_path)
    store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "açıklama")
    publisher = FakePublisher()

    result = pipeline.run_once(settings, store, publisher)

    assert result == {"published": 1, "failed": 0}
    assert publisher.published == ["açıklama"]
    assert store.summary() == {PUBLISHED: 1}
    assert list(settings.download_dir.glob("*")) == []
    store.close()


def test_run_once_marks_failed_jobs(tmp_path: Path, settings: Settings) -> None:
    store = StateStore(settings.db_path)
    store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "")
    publisher = FakePublisher(fail=True)

    result = pipeline.run_once(settings, store, publisher)

    assert result == {"published": 0, "failed": 1}
    assert store.summary() == {FAILED: 1}
    store.close()


def test_run_once_respects_zero_quota(tmp_path: Path, settings: Settings) -> None:
    store = StateStore(settings.db_path)
    store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "")

    assert pipeline.run_once(settings, store, FakePublisher(quota=0)) == {
        "published": 0,
        "failed": 0,
    }
    assert store.pending_jobs(5)  # iş kuyrukta kalır
    store.close()


def test_run_once_budget_limited_by_max_posts(tmp_path: Path, settings: Settings) -> None:
    settings = replace(settings, max_posts_per_run=1)
    store = StateStore(settings.db_path)
    for code in ("AAA", "BBB"):
        store.enqueue(code, f"https://www.instagram.com/reel/{code}/", "")

    result = pipeline.run_once(settings, store, FakePublisher())

    assert result == {"published": 1, "failed": 0}
    assert len(store.pending_jobs(5)) == 1
    store.close()


def test_run_once_reuses_recorded_download(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Kuyrukta dosya yolu kayıtlıysa indirme tekrar denenmez."""
    settings.download_dir.mkdir(parents=True, exist_ok=True)
    existing = settings.download_dir / "ABC.mp4"
    existing.write_bytes(b"video")

    store = StateStore(settings.db_path)
    store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "")
    store.mark_downloaded("ABC", str(existing))

    def boom(*args, **kwargs):
        raise DownloadError("indirme çağrılmamalıydı")

    monkeypatch.setattr(pipeline, "download_reel", boom)

    result = pipeline.run_once(settings, store, FakePublisher())

    assert result == {"published": 1, "failed": 0}
    store.close()


def test_run_once_reports_monotonic_percentage_progress(tmp_path: Path, settings: Settings) -> None:
    store = StateStore(settings.db_path)
    store.enqueue("ABC", "https://www.instagram.com/reel/ABC/", "açıklama")
    events: list[tuple[int, int, int, str, str]] = []

    result = pipeline.run_once(settings, store, FakePublisher(), progress_callback=lambda *event: events.append(event))

    percentages = [event[0] for event in events]
    assert result == {"published": 1, "failed": 0}
    assert percentages[0] == 0 and percentages[-1] == 100
    assert percentages == sorted(percentages)
    assert {event[3] for event in events} >= {"İndiriliyor", "Dikey formata hazırlanıyor", "Instagram'a gönderiliyor", "Yayınlandı"}
    store.close()
