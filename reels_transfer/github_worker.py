"""GitHub Actions bulut worker'ı: her kullanıcı yalnızca kendi Instagram hesabında yayın yapar."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

from .config import ConfigError, Settings, load_settings
from .downloader import DownloadError, download_reel
from .media import MediaError, ensure_tools_available, prepare_for_reels
from .publisher import InstagramApiError, InstagramPublisher, refresh_long_lived_token

LOGGER = logging.getLogger("reels_transfer.github_worker")


class QueueApiError(RuntimeError):
    """Supabase queue API request failed."""


def _parse_time(value: Any) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise QueueApiError("Supabase tarih alanı geçersiz.") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class SupabaseQueue:
    def __init__(self, project_url: str, service_key: str, session: requests.Session | None = None) -> None:
        base = project_url.rstrip("/") + "/rest/v1"
        self.queue_url = base + "/reels_queue"
        self.accounts_url = base + "/instagram_accounts"
        self.credentials_url = base + "/instagram_credentials"
        self.rpc_url = base + "/rpc"
        self.session = session or requests.Session()
        self.session.headers.update({
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        })

    @staticmethod
    def _rows(response: requests.Response, label: str) -> list[dict[str, Any]]:
        if not response.ok:
            raise QueueApiError(f"Supabase {label} isteği başarısız: HTTP {response.status_code}")
        payload = response.json()
        return payload if isinstance(payload, list) else []

    def queued(self, limit: int) -> list[dict[str, Any]]:
        params = urlencode({
            "select": "id,user_id,shortcode,source_url,caption,status,progress,attempts,rights_confirmed,publish_now,created_at",
            "status": "eq.queued",
            "order": "publish_now.desc,created_at.asc",
            "limit": str(max(1, min(limit, 200))),
        })
        response = self.session.get(self.queue_url + "?" + params, timeout=30)
        return self._rows(response, "kuyruk")

    def instagram_connection(self, user_id: str) -> dict[str, Any] | None:
        account_params = urlencode({
            "select": "user_id,instagram_user_id,username,token_expires_at,last_processed_at,last_published_at,publish_interval_minutes",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        })
        credential_params = urlencode({
            "select": "user_id,access_token,refreshed_at",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        })
        account_response = self.session.get(self.accounts_url + "?" + account_params, timeout=30)
        accounts = self._rows(account_response, "Instagram hesabı")
        if not accounts:
            return None
        credential_response = self.session.get(self.credentials_url + "?" + credential_params, timeout=30)
        credentials = self._rows(credential_response, "Instagram kimlik bilgisi")
        if not credentials or not credentials[0].get("access_token"):
            return None
        return {**accounts[0], **credentials[0]}

    def update(self, job: dict[str, Any], **fields: Any) -> bool:
        user_id = str(job.get("user_id") or "")
        if not user_id:
            raise QueueApiError("Kuyruk kaydında user_id bulunamadı.")
        fields.setdefault("updated_at", datetime.now(timezone.utc).isoformat())
        params = urlencode({"id": f"eq.{job['id']}", "user_id": f"eq.{user_id}"})
        response = self.session.patch(
            self.queue_url + "?" + params,
            json=fields,
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        return bool(self._rows(response, "kuyruk durumu"))

    def update_instagram_token(self, user_id: str, access_token: str, expires_at: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        params = urlencode({"user_id": f"eq.{user_id}"})
        response = self.session.patch(
            self.credentials_url + "?" + params,
            json={"access_token": access_token, "refreshed_at": now, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not self._rows(response, "token yenileme"):
            raise QueueApiError("Instagram tokenı kaydedilemedi.")
        response = self.session.patch(
            self.accounts_url + "?" + params,
            json={"token_expires_at": expires_at, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not self._rows(response, "token süresi"):
            raise QueueApiError("Instagram token süresi güncellenemedi.")

    def mark_processed(self, user_id: str) -> None:
        params = urlencode({"user_id": f"eq.{user_id}"})
        response = self.session.patch(
            self.accounts_url + "?" + params,
            json={"last_processed_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Kullanıcı kuyruk sırası güncellenemedi: HTTP {response.status_code}")

    def mark_published_time(self, user_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        params = urlencode({"user_id": f"eq.{user_id}"})
        response = self.session.patch(
            self.accounts_url + "?" + params,
            json={"last_published_at": now, "last_processed_at": now, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Yayın aralığı Supabase'e kaydedilemedi: HTTP {response.status_code}")

    def finish_publication(self, user_id: str, job_id: str, media_id: str) -> bool:
        response = self.session.post(
            self.rpc_url + "/mark_reel_published",
            json={"p_user_id": user_id, "p_id": job_id, "p_media_id": media_id},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Yayın durumu Supabase'e kaydedilemedi: HTTP {response.status_code}")
        return response.json() is True


def _publisher(settings: Settings, access_token: str, ig_user_id: str) -> InstagramPublisher:
    return InstagramPublisher(
        access_token=access_token,
        ig_user_id=ig_user_id,
        graph_version=settings.graph_version,
        poll_seconds=settings.status_poll_seconds,
        poll_attempts=settings.status_poll_attempts,
        api_mode="instagram_login",
        public_upload_mode=settings.public_upload_mode,
        cloudinary_cloud_name=settings.cloudinary_cloud_name,
        cloudinary_upload_preset=settings.cloudinary_upload_preset,
    )


def _active_connection(queue: SupabaseQueue, connection: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    expires_at = _parse_time(connection.get("token_expires_at"))
    refreshed_at = _parse_time(connection.get("refreshed_at"))
    if expires_at <= now:
        raise InstagramApiError("Instagram erişim süresi doldu. Hesabını yeniden bağla.")
    if expires_at - now <= timedelta(days=10):
        if now - refreshed_at < timedelta(hours=24):
            if expires_at - now <= timedelta(hours=1):
                raise InstagramApiError("Instagram tokenı yenileme sınırında; biraz sonra tekrar dene veya hesabı yeniden bağla.")
        else:
            fresh_token, lifetime = refresh_long_lived_token(str(connection["access_token"]))
            fresh_expiry = (now + timedelta(seconds=lifetime)).isoformat()
            queue.update_instagram_token(str(connection["user_id"]), fresh_token, fresh_expiry)
            connection = {**connection, "access_token": fresh_token, "token_expires_at": fresh_expiry, "refreshed_at": now.isoformat()}
    return connection


def _next_publication_at(connection: dict[str, Any]) -> datetime | None:
    interval = int(connection.get("publish_interval_minutes") or 360)
    if interval not in {60, 180, 360, 720, 1440, 2880}:
        raise QueueApiError("Instagram yayın aralığı geçersiz.")
    last_published = _parse_time(connection.get("last_published_at"))
    if last_published == datetime.min.replace(tzinfo=timezone.utc):
        return None
    return last_published + timedelta(minutes=interval)


def _remaining_interval(due_at: datetime, now: datetime) -> str:
    seconds = max(1, int((due_at - now).total_seconds()))
    if seconds >= 86400:
        days, hours = divmod(seconds, 86400)
        return f"{days} gün {hours // 3600} saat"
    if seconds >= 3600:
        return f"{seconds // 3600} saat"
    return f"{max(1, seconds // 60)} dakika"


def _interval_wait_required(due_at: datetime | None, now: datetime, publish_now: bool = False) -> bool:
    """A user-requested one-off publish may bypass, but never changes, the regular interval setting."""
    return due_at is not None and due_at > now and not publish_now


def _cleanup(*paths: Path | None) -> None:
    for path in paths:
        if path:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                LOGGER.warning("Geçici dosya silinemedi (%s): %s", path.name, type(exc).__name__)


def _mark_failed(queue: SupabaseQueue, job: dict[str, Any], message: str) -> None:
    try:
        queue.update(job, status="failed", stage="Yayın başarısız", error_message=message[:1000])
    except QueueApiError:
        LOGGER.exception("Hata durumu Supabase'e yazılamadı (%s).", job.get("shortcode", "bilinmeyen"))


def run_worker() -> dict[str, int]:
    project_url = os.getenv("SUPABASE_URL", "").strip()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not project_url or not service_key:
        raise ConfigError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.")

    settings = load_settings(require_account_credentials=False)
    if settings.api_mode != "instagram_login":
        raise ConfigError("Kullanıcı başına Instagram bağlantısı için IG_API_MODE=instagram_login olmalı.")
    ensure_tools_available()
    if settings.max_posts_per_run <= 0:
        LOGGER.info("MAX_POSTS_PER_RUN sıfır; worker bu turda yayın yapmayacak.")
        return {"published": 0, "failed": 0, "skipped": 0}

    queue = SupabaseQueue(project_url, service_key)
    jobs = queue.queued(max(50, settings.max_posts_per_run * 20))
    connections: dict[str, dict[str, Any] | None] = {}
    for job in jobs:
        user_id = str(job.get("user_id") or "")
        if user_id and user_id not in connections:
            connections[user_id] = queue.instagram_connection(user_id)

    def fairness_key(job: dict[str, Any]) -> tuple[bool, datetime, datetime]:
        connection = connections.get(str(job.get("user_id") or ""))
        last = _parse_time(connection.get("last_processed_at")) if connection else datetime.min.replace(tzinfo=timezone.utc)
        return job.get("publish_now") is not True, last, _parse_time(job.get("created_at"))

    jobs.sort(key=fairness_key)
    published = failed = skipped = claimed = 0
    LOGGER.info("Bulut işçisi %d kullanıcıya ait kuyruk kaydı buldu.", len(jobs))

    for job in jobs:
        if claimed >= settings.max_posts_per_run:
            break
        user_id = str(job.get("user_id") or "")
        if not user_id:
            skipped += 1
            continue
        if job.get("rights_confirmed") is not True:
            _mark_failed(queue, job, "İçerik paylaşma hakkı onayı eksik.")
            failed += 1
            continue
        connection = connections.get(user_id)
        if not connection:
            _mark_failed(queue, job, "Instagram hesabı bağlı değil. ReelFlow'da Instagram hesabını bağlayıp yeniden dene.")
            failed += 1
            continue
        try:
            due_at = _next_publication_at(connection)
        except QueueApiError as exc:
            _mark_failed(queue, job, str(exc))
            failed += 1
            continue
        now = datetime.now(timezone.utc)
        if _interval_wait_required(due_at, now, job.get("publish_now") is True):
            queue.update(
                job,
                status="queued",
                progress=0,
                stage=f"Yayın aralığı bekleniyor · yaklaşık {_remaining_interval(due_at, now)} kaldı",
                error_message=None,
            )
            skipped += 1
            continue
        if not queue.update(
            job,
            status="processing",
            progress=3,
            stage="Kişisel Instagram hesabına hazırlanıyor",
            attempts=int(job.get("attempts") or 0) + 1,
            error_message=None,
        ):
            skipped += 1
            continue
        claimed += 1

        source_file: Path | None = None
        reel_file: Path | None = None
        try:
            queue.mark_processed(user_id)
            connection = _active_connection(queue, connection)
            connections[user_id] = connection
            publisher = _publisher(settings, str(connection["access_token"]), str(connection["instagram_user_id"]))
            if publisher.remaining_quota() <= 0:
                queue.update(
                    job,
                    status="queued",
                    progress=0,
                    stage="Instagram günlük yayın sınırı dolu · sonraki turda yeniden denenecek",
                    error_message=None,
                )
                skipped += 1
                continue
            queue.update(job, progress=10, stage="Reel indiriliyor")
            source_file = download_reel(
                str(job["source_url"]), str(job["shortcode"]), settings.download_dir, settings.cookies_file
            )
            queue.update(job, progress=35, stage="Video indirildi · dikey formata hazırlanıyor")
            reel_file = prepare_for_reels(source_file, settings.download_dir)
            queue.update(job, progress=62, stage=f"Video hazırlandı · @{connection['username']} hesabına yükleniyor")
            caption = str(job.get("caption") or settings.default_caption).replace("{source_url}", str(job["source_url"]))
            media_id = publisher.publish_reel(reel_file, caption)
            published += 1
            connection = {**connection, "last_published_at": datetime.now(timezone.utc).isoformat()}
            connections[user_id] = connection
            try:
                saved = queue.finish_publication(user_id, str(job["id"]), media_id)
            except QueueApiError:
                LOGGER.exception("Instagram yayınlandı fakat kuyruk durumu eşitlenemedi (%s).", job["shortcode"])
                try:
                    queue.mark_published_time(user_id)
                except QueueApiError:
                    LOGGER.exception("Yayın aralığı fallback olarak da yazılamadı (%s).", job["shortcode"])
                try:
                    queue.update(job, progress=100, stage="Instagramda yayınlandı · durum eşitlemesi bekleniyor", error_message=None)
                except QueueApiError:
                    LOGGER.exception("Yayın sonrası uyarı durumu da yazılamadı (%s).", job["shortcode"])
                skipped += 1
                continue
            if not saved:
                LOGGER.error("Instagram yayınlandı fakat queue RPC processing satırını bulamadı (%s).", job["shortcode"])
                try:
                    queue.mark_published_time(user_id)
                except QueueApiError:
                    LOGGER.exception("Yayın aralığı fallback olarak da yazılamadı (%s).", job["shortcode"])
                try:
                    queue.update(job, progress=100, stage="Instagramda yayınlandı · durum eşitlemesi gerekli", error_message=None)
                except QueueApiError:
                    LOGGER.exception("Yayın sonrası uyarı durumu da yazılamadı (%s).", job["shortcode"])
                skipped += 1
                continue
            LOGGER.info("Reel kullanıcı hesabında yayınlandı: %s", job["shortcode"])
        except (DownloadError, MediaError, InstagramApiError, ValueError, OSError, QueueApiError) as exc:
            safe_error = str(exc).replace(str(connection.get("access_token", "")), "[TOKEN]")[:1000]
            _mark_failed(queue, job, safe_error)
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
