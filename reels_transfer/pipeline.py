"""Kuyruktaki reel'ler için: indir → hazırla → yayınla."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Callable

from .config import Settings
from .downloader import DownloadError, download_reel
from .media import MediaError, ensure_tools_available, prepare_for_reels
from .publisher import InstagramApiError, InstagramPublisher
from .state import StateStore

LOGGER = logging.getLogger(__name__)

_HANDLED_ERRORS = (DownloadError, MediaError, InstagramApiError, ValueError, OSError)


def _existing_file(path_text: str | None) -> Path | None:
    if not path_text:
        return None
    path = Path(path_text)
    return path if path.exists() else None


def _cleanup(*paths: Path | None) -> None:
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:  # silinemeyen dosya turu bozmasın
            LOGGER.warning("Dosya silinemedi (%s): %s", path, exc)


def run_once(
    settings: Settings,
    store: StateStore,
    publisher: InstagramPublisher,
    progress_callback: Callable[[int, int, int, str, str], None] | None = None,
) -> dict[str, int]:
    ensure_tools_available()
    budget = min(settings.max_posts_per_run, publisher.remaining_quota())
    if budget <= 0:
        LOGGER.warning("24 saatlik yayın kotası dolu; bu turda paylaşım yapılmayacak.")
        return {"published": 0, "failed": 0}

    jobs = store.pending_jobs(budget)
    total = len(jobs)
    published = failed = 0

    def report(index: int, phase: int, stage: str, shortcode: str) -> None:
        if progress_callback and total:
            percent = int(((index * 4 + phase) / (total * 4)) * 100)
            progress_callback(percent, index + 1, total, stage, shortcode)

    if progress_callback:
        progress_callback(0, 0, total, "Hazırlanıyor", "")

    for index, job in enumerate(jobs):
        LOGGER.info("İşleniyor: %s", job.source_url)
        source_file = _existing_file(job.file_path)
        report(index, 0, "İndiriliyor", job.shortcode)
        try:
            if source_file is None:
                source_file = download_reel(
                    job.source_url, job.shortcode, settings.download_dir, settings.cookies_file
                )
                store.mark_downloaded(job.shortcode, str(source_file))
            report(index, 1, "Video indirildi", job.shortcode)
            report(index, 1, "Dikey formata hazırlanıyor", job.shortcode)
            reel_file = prepare_for_reels(source_file, settings.download_dir)
            report(index, 2, "Video hazırlandı · yayınlanıyor", job.shortcode)
            report(index, 3, "Instagram'a gönderiliyor", job.shortcode)
            media_id = publisher.publish_reel(reel_file, job.caption)
        except _HANDLED_ERRORS as exc:
            LOGGER.error("Başarısız (%s): %s", job.shortcode, exc)
            store.mark_failed(job.shortcode, str(exc))
            failed += 1
            report(index, 4, "İş hata ile tamamlandı", job.shortcode)
            continue

        store.mark_published(job.shortcode, media_id)
        _cleanup(source_file, reel_file)
        published += 1
        report(index, 4, "Yayınlandı", job.shortcode)
        LOGGER.info("Yayınlandı: %s (media id: %s)", job.shortcode, media_id)

    return {"published": published, "failed": failed}
