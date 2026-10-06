"""GitHub Actions'ta çalışan, Supabase kuyruğunu tek turda işleyen bulut worker'ı."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

from .config import ConfigError, load_settings
from .downloader import DownloadError, download_reel
from .media import MediaError, ensure_tools_available, prepare_for_reels
from .publisher import InstagramApiError, InstagramPublisher

LOGGER = logging.getLogger("reels_transfer.github_worker")


class QueueApiError(RuntimeError):
    """Supabase queue API request failed."""


class SupabaseQueue:
    def __init__(self, project_url: str, service_key: str, owner_id: str) -> None:
        self.base_url = project_url.rstrip("/") + "/rest/v1/reels_queue"
        self.owner_id = owner_id
        self.session = requests.Session()
        self.session.headers.update({
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        })

    def queued(self, limit: int) -> list[dict[str, Any]]:
        params = urlencode({
            "select": "id,user_id,shortcode,source_url,caption,status,progress,attempts,rights_confirmed",
            "user_id": f"eq.{self.owner_id}",
            "status": "eq.queued",
            "order": "created_at.asc",
            "limit": str(limit),
        })
        response = self.session.get(self.base_url + "?" + params, timeout=30)
        if not response.ok:
            raise QueueApiError(f"Supabase kuyruğu okunamadı: HTTP {response.status_code}")
        return response.json()

    def update(self, job: dict[str, Any], **fields: Any) -> bool:
        fields.setdefault("updated_at", datetime.now(timezone.utc).isoformat())
        params = urlencode({
            "id": f"eq.{job['id']}",
            "user_id": f"eq.{self.owner_id}",
        })
        headers = {"Prefer": "return=representation"}
        response = self.session.patch(self.base_url + "?" + params, json=fields, headers=headers, timeout=30)
        if not response.ok:
            raise QueueApiError(f"Supabase kuyruk durumu güncellenemedi: HTTP {response.status_code}")
        rows = response.json()
        return bool(rows)


def _publisher(settings: Any) -> InstagramPublisher:
    return InstagramPublisher(
        access_token=settings.access_token,
        ig_user_id=settings.ig_user_id,
        graph_version=settings.graph_version,
        poll_seconds=settings.status_poll_seconds,
        poll_attempts=settings.status_poll_attempts,
        api_mode=settings.api_mode,
        public_upload_mode=settings.public_upload_mode,
        cloudinary_cloud_name=settings.cloudinary_cloud_name,
        cloudinary_upload_preset=settings.cloudinary_upload_preset,
    )


def _cleanup(*paths: Path | None) -> None:
    for path in paths:
        if path:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                LOGGER.warning("Geçici dosya silinemedi (%s): %s", path.name, type(exc).__name__)


def run_worker() -> dict[str, int]:
    project_url = os.getenv("SUPABASE_URL", "").strip()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    owner_id = os.getenv("SUPABASE_OWNER_ID", "").strip()
    if not project_url or not service_key or not owner_id:
        raise ConfigError("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ve SUPABASE_OWNER_ID gerekli.")

    settings = load_settings()
    ensure_tools_available()
    publisher = _publisher(settings)
    budget = min(settings.max_posts_per_run, publisher.remaining_quota())
    if budget <= 0:
        LOGGER.info("Instagram yayın kotası dolu; iş kuyruğa bırakıldı.")
        return {"published": 0, "failed": 0, "skipped": 0}

    queue = SupabaseQueue(project_url, service_key, owner_id)
    jobs = queue.queued(budget)
    published = failed = skipped = 0
    LOGGER.info("Bulut işçisi %d kuyruk kaydı buldu.", len(jobs))

    for job in jobs:
        # Atomik olmayan provider API'larında yinelenen yan etkiyi azaltmak için önce
        # processing durumuna al. GitHub Actions concurrency grubu ikinci worker'ı bekletir.
        if not queue.update(
            job,
            status="processing",
            progress=3,
            stage="Bulut işçisi aldı",
            attempts=int(job.get("attempts") or 0) + 1,
            error_message=None,
        ):
            skipped += 1
            continue

        source_file: Path | None = None
        reel_file: Path | None = None
        try:
            if job.get("rights_confirmed") is not True:
                raise ValueError("İçerik paylaşma hakkı onayı eksik.")
            queue.update(job, progress=10, stage="Reel indiriliyor")
            source_file = download_reel(
                str(job["source_url"]), str(job["shortcode"]), settings.download_dir, settings.cookies_file
            )
            queue.update(job, progress=35, stage="Video indirildi · dikey formata hazırlanıyor")
            reel_file = prepare_for_reels(source_file, settings.download_dir)
            queue.update(job, progress=62, stage="Video hazırlandı · Instagram'a yükleniyor")
            caption = str(job.get("caption") or settings.default_caption).replace("{source_url}", str(job["source_url"]))
            media_id = publisher.publish_reel(reel_file, caption)
            queue.update(
                job,
                status="published",
                progress=100,
                stage="Yayınlandı",
                ig_media_id=media_id,
                error_message=None,
            )
            published += 1
            LOGGER.info("Reel yayınlandı: %s", job["shortcode"])
        except (DownloadError, MediaError, InstagramApiError, ValueError, OSError, QueueApiError) as exc:
            # Hata metninde erişim tokenı bulunmaz; publisher hata gövdelerini önceden temizler.
            safe_error = str(exc).replace(settings.access_token, "[TOKEN]")[:1000]
            try:
                queue.update(job, status="failed", stage="Yayın başarısız", error_message=safe_error)
            except QueueApiError:
                LOGGER.exception("Hata durumu Supabase'e yazılamadı (%s).", job["shortcode"])
            LOGGER.error("Reel başarısız (%s): %s", job["shortcode"], safe_error)
            failed += 1
        finally:
            _cleanup(source_file, reel_file)

    return {"published": published, "failed": failed, "skipped": skipped}


def main() -> int:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    result = run_worker()
    LOGGER.info("Tur tamamlandı: %d yayınlandı, %d başarısız, %d atlandı.", result["published"], result["failed"], result["skipped"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
