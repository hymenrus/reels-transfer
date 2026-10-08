"""GitHub Actions worker: every queue item is published only to its owner-selected Instagram account."""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit
from uuid import UUID, uuid4

import requests

from .config import ConfigError, Settings, load_settings
from .downloader import DownloadError, download_reel
from .media import MediaError, ensure_tools_available, original_reel_is_meta_compatible, prepare_for_reels
from .publisher import InstagramApiError, InstagramPublisher, refresh_long_lived_token

LOGGER = logging.getLogger("reels_transfer.github_worker")
MEDIA_SYNC_INTERVAL = timedelta(minutes=30)
MAX_MEDIA_SYNC_ACCOUNTS_PER_RUN = 10
MAX_MEDIA_SYNC_PAGES = 25


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
    def __init__(
        self,
        project_url: str,
        service_key: str,
        session: requests.Session | None = None,
        storage_session: requests.Session | None = None,
    ) -> None:
        self.project_url = project_url.rstrip("/")
        base = self.project_url + "/rest/v1"
        self.queue_url = base + "/reels_queue"
        self.accounts_url = base + "/instagram_accounts"
        self.credentials_url = base + "/instagram_credentials"
        self.video_import_jobs_url = base + "/video_import_jobs"
        self.video_cover_images_url = base + "/video_cover_images"
        self.rpc_url = base + "/rpc"
        self.storage_url = self.project_url + "/storage/v1"
        self.temporary_video_objects_url = base + "/worker_temporary_video_objects"
        self.session = session or requests.Session()
        # Never send the service-role key to the signed-URL download request.
        self.storage_session = storage_session or requests.Session()
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

    def queued(self, limit: int, target_job_id: str | None = None) -> list[dict[str, Any]]:
        filters = {
            "select": "id,user_id,instagram_account_id,uploaded_video_id,cover_image_id,shortcode,source_url,caption,status,progress,attempts,rights_confirmed,publish_now,created_at",
            "status": "eq.queued",
            "order": "publish_now.desc,created_at.asc",
            "limit": str(max(1, min(limit, 200))),
        }
        if target_job_id:
            filters["id"] = f"eq.{target_job_id}"
            filters["limit"] = "1"
        params = urlencode(filters)
        response = self.session.get(self.queue_url + "?" + params, timeout=30)
        return self._rows(response, "kuyruk")

    def signed_uploaded_video(self, job: dict[str, Any], expires_seconds: int = 14400) -> dict[str, Any]:
        user_id = str(job.get("user_id") or "")
        video_id = str(job.get("uploaded_video_id") or "")
        if not user_id or not video_id:
            raise QueueApiError("Yüklenen video için sahip veya video kimliği bulunamadı.")
        params = urlencode({
            "select": "id,user_id,storage_path,mime_type,size_bytes,cleanup_pending",
            "id": f"eq.{video_id}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        })
        try:
            response = self.session.get("https://" + urlsplit(self.project_url).netloc + "/rest/v1/uploaded_videos?" + params, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Özel video bilgisi alınamadı (ağ hatası).") from exc
        rows = self._rows(response, "özel video bilgisi")
        if not rows:
            raise QueueApiError("Özel video arşivinde kaynak dosya bulunamadı.")
        video = rows[0]
        path = str(video.get("storage_path") or "")
        mime_type = str(video.get("mime_type") or "")
        try:
            size_bytes = int(video.get("size_bytes") or 0)
        except (TypeError, ValueError) as exc:
            raise QueueApiError("Özel video boyutu geçersiz.") from exc
        if (video.get("cleanup_pending") or not path.startswith(user_id + "/")
                or not re.fullmatch(r"[0-9a-fA-F-]{36}/[A-Za-z0-9_-]+\.(?:mp4|mov|m4v)", path)
                or mime_type not in {"video/mp4", "video/quicktime", "video/x-m4v"}
                or size_bytes < 1 or size_bytes > 50 * 1024 * 1024):
            raise QueueApiError("Özel video kaynağı güvenli veya geçerli değil.")
        object_url = f"{self.storage_url}/object/sign/reelflow-original-videos/{quote(path, safe='/')}"
        try:
            signed_response = self.session.post(object_url, json={"expiresIn": max(600, min(int(expires_seconds), 604800))}, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Özel video bağlantısı üretilemedi (ağ hatası).") from exc
        if not signed_response.ok:
            raise QueueApiError(f"Özel video bağlantısı üretilemedi: HTTP {signed_response.status_code}")
        try:
            payload = signed_response.json()
        except ValueError as exc:
            raise QueueApiError("Özel video bağlantısı yanıtı geçersiz.") from exc
        signed = str(payload.get("signedURL") or payload.get("signedUrl") or "") if isinstance(payload, dict) else ""
        if signed.startswith("https://"):
            signed_url = signed
        elif signed.startswith("/storage/v1/"):
            signed_url = self.project_url + signed
        elif signed.startswith("/object/"):
            signed_url = self.storage_url + signed
        elif signed.startswith("object/"):
            signed_url = self.storage_url + "/" + signed
        else:
            raise QueueApiError("Özel video bağlantısı HTTPS adresi değil.")
        parsed = urlsplit(signed_url)
        expected_path = f"/storage/v1/object/sign/reelflow-original-videos/{quote(path, safe='/')}"
        if (parsed.scheme != "https" or parsed.netloc != urlsplit(self.project_url).netloc
                or parsed.path != expected_path or "token=" not in parsed.query):
            raise QueueApiError("Özel video bağlantısının kapsamı doğrulanamadı.")
        return {"url": signed_url, "storage_path": path, "mime_type": mime_type, "size_bytes": size_bytes}

    def download_uploaded_video(self, job: dict[str, Any], destination: Path) -> tuple[Path, str]:
        signed = self.signed_uploaded_video(job)
        suffix = {"video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v"}[signed["mime_type"]]
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / f"reelflow-original-{uuid4().hex}{suffix}"
        response = None
        total = 0
        try:
            response = self.storage_session.get(signed["url"], stream=True, timeout=(15, 900))
            if not response.ok:
                raise QueueApiError(f"Özel video geçici indirmesi başarısız: HTTP {response.status_code}")
            with target.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > signed["size_bytes"] or total > 50 * 1024 * 1024:
                        raise QueueApiError("Özel video indirmesi beklenen boyut sınırını aştı.")
                    handle.write(chunk)
            if total != signed["size_bytes"]:
                raise QueueApiError("Özel video indirmesi eksik veya bozuk.")
            return target, signed["url"]
        except QueueApiError:
            target.unlink(missing_ok=True)
            raise
        except (OSError, requests.RequestException) as exc:
            target.unlink(missing_ok=True)
            raise QueueApiError(f"Özel video geçici indirmesi başarısız: {type(exc).__name__}") from exc
        finally:
            if response is not None:
                response.close()

    def signed_cover_image(self, job: dict[str, Any], expires_seconds: int = 14400) -> str:
        user_id = str(job.get("user_id") or "")
        cover_id = str(job.get("cover_image_id") or "")
        if not user_id or not cover_id:
            raise QueueApiError("Reels kapağı için sahip veya görsel kimliği bulunamadı.")
        params = urlencode({
            "select": "id,user_id,storage_path,mime_type,size_bytes,cleanup_pending",
            "id": f"eq.{cover_id}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        })
        try:
            response = self.session.get(self.video_cover_images_url + "?" + params, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Özel kapak görseli bilgisi alınamadı (ağ hatası).") from exc
        rows = self._rows(response, "özel Reels kapağı")
        if not rows:
            raise QueueApiError("Seçilen özel Reels kapağı bulunamadı.")
        cover = rows[0]
        path = str(cover.get("storage_path") or "")
        try:
            size_bytes = int(cover.get("size_bytes") or 0)
        except (TypeError, ValueError) as exc:
            raise QueueApiError("Özel Reels kapağının dosya boyutu geçersiz.") from exc
        if (cover.get("cleanup_pending") or cover.get("mime_type") != "image/jpeg"
                or size_bytes < 1 or size_bytes > 8 * 1024 * 1024
                or not re.fullmatch(r"[0-9a-fA-F-]{36}/[0-9a-f]{32}\.jpg", path)
                or path.split("/", 1)[0].lower() != user_id.lower()):
            raise QueueApiError("Özel Reels kapağının sahibi, yolu veya biçimi geçersiz.")
        object_url = f"{self.storage_url}/object/sign/reelflow-cover-images/{quote(path, safe='/')}"
        try:
            signed_response = self.session.post(
                object_url, json={"expiresIn": max(600, min(int(expires_seconds), 604800))}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Meta için süreli kapak bağlantısı üretilemedi (ağ hatası).") from exc
        if not signed_response.ok:
            raise QueueApiError(f"Meta için süreli kapak bağlantısı üretilemedi: HTTP {signed_response.status_code}")
        try:
            payload = signed_response.json()
        except ValueError as exc:
            raise QueueApiError("Süreli kapak bağlantısı yanıtı geçersiz.") from exc
        signed = str(payload.get("signedURL") or payload.get("signedUrl") or "") if isinstance(payload, dict) else ""
        if signed.startswith("https://"):
            signed_url = signed
        elif signed.startswith("/storage/v1/"):
            signed_url = self.project_url + signed
        elif signed.startswith("/object/"):
            signed_url = self.storage_url + signed
        elif signed.startswith("object/"):
            signed_url = self.storage_url + "/" + signed
        else:
            raise QueueApiError("Süreli kapak bağlantısı HTTPS adresi değil.")
        parsed = urlsplit(signed_url)
        expected_path = f"/storage/v1/object/sign/reelflow-cover-images/{quote(path, safe='/')}"
        if (parsed.scheme != "https" or parsed.netloc != urlsplit(self.project_url).netloc
                or parsed.path != expected_path or "token=" not in parsed.query):
            raise QueueApiError("Süreli kapak bağlantısının kapsamı doğrulanamadı.")
        return signed_url

    def claim_uploaded_video_cleanups(self, limit: int = 50) -> list[dict[str, Any]]:
        try:
            response = self.session.post(
                self.rpc_url + "/claim_uploaded_video_cleanups",
                json={"p_limit": max(1, min(limit, 200))}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Yayın sonrası video temizleme kuyruğuna erişilemedi.") from exc
        return self._rows(response, "yayın sonrası video temizleme kuyruğu")

    def delete_uploaded_video_object(self, storage_path: str) -> None:
        if not re.fullmatch(r"[0-9a-fA-F-]{36}/[A-Za-z0-9_-]+\.(?:mp4|mov|m4v)", storage_path):
            raise QueueApiError("Video silme yolu güvenli değil.")
        try:
            response = self.session.delete(
                self.storage_url + "/object/reelflow-original-videos",
                json={"prefixes": [storage_path]},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Özel video depolamadan silinemedi (ağ hatası).") from exc
        if not response.ok and response.status_code != 404:
            raise QueueApiError(f"Özel video depolamadan silinemedi: HTTP {response.status_code}")

    def upload_temporary_video(self, video_path: Path, expires_seconds: int = 14400) -> tuple[str, str]:
        """Store a converted library file privately for Meta to ingest; never use the public uploader."""
        if not video_path.is_file():
            raise QueueApiError("Dönüştürülmüş özel video bulunamadı.")
        size_bytes = video_path.stat().st_size
        if size_bytes < 1 or size_bytes > 50 * 1024 * 1024:
            raise QueueApiError(
                "Instagram için dönüştürülen dosya Supabase Free'ın 50 MB sınırını aşıyor; "
                "orijinali korudum. Daha küçük/uyumlu bir MP4 yükle."
            )
        storage_path = f"worker-temp/{uuid4().hex}.mp4"
        try:
            registered = self.session.post(
                self.temporary_video_objects_url,
                json={"storage_path": storage_path}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Özel geçici video kaydı oluşturulamadı (ağ hatası).") from exc
        if not registered.ok:
            raise QueueApiError(f"Özel geçici video kaydı oluşturulamadı: HTTP {registered.status_code}")

        object_url = f"{self.storage_url}/object/reelflow-original-videos/{quote(storage_path, safe='/')}"
        try:
            with video_path.open("rb") as handle:
                uploaded = self.session.post(
                    object_url,
                    data=handle,
                    headers={"Content-Type": "video/mp4", "x-upsert": "false"},
                    timeout=(15, 900),
                )
        except (OSError, requests.RequestException) as exc:
            raise QueueApiError(f"Dönüştürülmüş özel video depolanamadı: {type(exc).__name__}") from exc
        if not uploaded.ok:
            raise QueueApiError(f"Dönüştürülmüş özel video depolanamadı: HTTP {uploaded.status_code}")

        try:
            signed_response = self.session.post(
                f"{self.storage_url}/object/sign/reelflow-original-videos/{quote(storage_path, safe='/')}",
                json={"expiresIn": max(600, min(int(expires_seconds), 604800))}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Meta için süreli özel video bağlantısı üretilemedi.") from exc
        if not signed_response.ok:
            raise QueueApiError(f"Meta için süreli özel video bağlantısı üretilemedi: HTTP {signed_response.status_code}")
        try:
            payload = signed_response.json()
        except ValueError as exc:
            raise QueueApiError("Süreli özel video bağlantısı yanıtı geçersiz.") from exc
        signed = str(payload.get("signedURL") or payload.get("signedUrl") or "") if isinstance(payload, dict) else ""
        if signed.startswith("https://"):
            signed_url = signed
        elif signed.startswith("/storage/v1/"):
            signed_url = self.project_url + signed
        elif signed.startswith("/object/"):
            signed_url = self.storage_url + signed
        elif signed.startswith("object/"):
            signed_url = self.storage_url + "/" + signed
        else:
            raise QueueApiError("Süreli özel video bağlantısı HTTPS adresi değil.")
        parsed = urlsplit(signed_url)
        expected_path = f"/storage/v1/object/sign/reelflow-original-videos/{quote(storage_path, safe='/')}"
        if (parsed.scheme != "https" or parsed.netloc != urlsplit(self.project_url).netloc
                or parsed.path != expected_path or "token=" not in parsed.query):
            raise QueueApiError("Süreli özel video bağlantısının kapsamı doğrulanamadı.")
        return storage_path, signed_url

    def delete_temporary_video(self, storage_path: str) -> None:
        if not re.fullmatch(r"worker-temp/[0-9a-f]{32}\.mp4", storage_path):
            raise QueueApiError("Geçici video yolu güvenli değil.")
        try:
            response = self.session.delete(
                self.storage_url + "/object/reelflow-original-videos",
                json={"prefixes": [storage_path]}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Geçici özel video silinemedi (ağ hatası).") from exc
        if not response.ok and response.status_code != 404:
            raise QueueApiError(f"Geçici özel video silinemedi: HTTP {response.status_code}")
        params = urlencode({"storage_path": f"eq.{storage_path}"})
        try:
            recorded = self.session.delete(self.temporary_video_objects_url + "?" + params, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Geçici video temizlik kaydı kaldırılamadı (ağ hatası).") from exc
        if not recorded.ok:
            raise QueueApiError(f"Geçici video temizlik kaydı kaldırılamadı: HTTP {recorded.status_code}")

    def cleanup_stale_temporary_videos(self, older_than_hours: int = 12, limit: int = 50) -> int:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(6, older_than_hours))).isoformat()
        params = urlencode({
            "select": "storage_path",
            "created_at": f"lt.{cutoff}",
            "order": "created_at.asc",
            "limit": str(max(1, min(limit, 200))),
        })
        try:
            response = self.session.get(self.temporary_video_objects_url + "?" + params, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Süre aşımı dolan özel geçici videolar listelenemedi.") from exc
        rows = self._rows(response, "eski özel geçici videolar")
        cleaned = 0
        for row in rows:
            try:
                self.delete_temporary_video(str(row.get("storage_path") or ""))
                cleaned += 1
            except QueueApiError:
                LOGGER.exception("Süre aşımı dolan özel geçici video temizlenemedi.")
        return cleaned

    def finish_uploaded_video_cleanup(self, video_id: str) -> bool:
        try:
            response = self.session.post(
                self.rpc_url + "/finish_uploaded_video_cleanup",
                json={"p_uploaded_video_id": video_id}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Özel video arşiv kaydı güncellenemedi (ağ hatası).") from exc
        if not response.ok:
            raise QueueApiError(f"Özel video arşiv kaydı güncellenemedi: HTTP {response.status_code}")
        try:
            return response.json() is True
        except ValueError as exc:
            raise QueueApiError("Özel video arşiv yanıtı geçersiz.") from exc

    def cleanup_uploaded_videos(self, limit: int = 50) -> int:
        cleaned = 0
        for item in self.claim_uploaded_video_cleanups(limit):
            video_id = str(item.get("uploaded_video_id") or "")
            path = str(item.get("storage_path") or "")
            try:
                self.delete_uploaded_video_object(path)
                if not self.finish_uploaded_video_cleanup(video_id):
                    raise QueueApiError("Özel video silme durumu kaydedilemedi.")
                cleaned += 1
                LOGGER.info("Yayın sonrası özel video arşivden temizlendi (%s).", video_id)
            except QueueApiError:
                LOGGER.exception("Özel video temizliği başarısız (%s).", video_id or "bilinmeyen kimlik")
        return cleaned

    def instagram_connection(self, account_id: str, user_id: str) -> dict[str, Any] | None:
        account_params = urlencode({
            "select": "id,user_id,instagram_user_id,username,token_expires_at,last_processed_at,last_published_at,publish_interval_minutes,last_media_sync_at,disconnected_at",
            "id": f"eq.{account_id}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        })
        account_response = self.session.get(self.accounts_url + "?" + account_params, timeout=30)
        accounts = self._rows(account_response, "Instagram hesabı")
        if not accounts or accounts[0].get("disconnected_at"):
            return None
        credential_params = urlencode({
            "select": "user_id,instagram_account_id,access_token,refreshed_at",
            "instagram_account_id": f"eq.{account_id}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        })
        credential_response = self.session.get(self.credentials_url + "?" + credential_params, timeout=30)
        credentials = self._rows(credential_response, "Instagram kimlik bilgisi")
        if (not credentials or not credentials[0].get("access_token")
                or str(credentials[0].get("user_id")) != str(accounts[0].get("user_id"))):
            return None
        return {**accounts[0], **credentials[0]}

    def update(self, job: dict[str, Any], **fields: Any) -> bool:
        user_id = str(job.get("user_id") or "")
        if not user_id:
            raise QueueApiError("Kuyruk kaydında user_id bulunamadı.")
        fields.setdefault("updated_at", datetime.now(timezone.utc).isoformat())
        filters = {"id": f"eq.{job['id']}", "user_id": f"eq.{user_id}"}
        if job.get("instagram_account_id"):
            filters["instagram_account_id"] = f"eq.{job['instagram_account_id']}"
        params = urlencode(filters)
        response = self.session.patch(
            self.queue_url + "?" + params,
            json=fields,
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        return bool(self._rows(response, "kuyruk durumu"))

    def update_instagram_token(self, account_id: str, user_id: str, access_token: str, expires_at: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        params = urlencode({"instagram_account_id": f"eq.{account_id}", "user_id": f"eq.{user_id}"})
        response = self.session.patch(
            self.credentials_url + "?" + params,
            json={"access_token": access_token, "refreshed_at": now, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not self._rows(response, "token yenileme"):
            raise QueueApiError("Instagram tokenı kaydedilemedi.")
        account_params = urlencode({"id": f"eq.{account_id}", "user_id": f"eq.{user_id}"})
        response = self.session.patch(
            self.accounts_url + "?" + account_params,
            json={"token_expires_at": expires_at, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not self._rows(response, "token süresi"):
            raise QueueApiError("Instagram token süresi güncellenemedi.")

    def mark_processed(self, account_id: str) -> None:
        params = urlencode({"id": f"eq.{account_id}"})
        response = self.session.patch(
            self.accounts_url + "?" + params,
            json={"last_processed_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Instagram hesap sırası güncellenemedi: HTTP {response.status_code}")

    def mark_published_time(self, account_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        params = urlencode({"id": f"eq.{account_id}"})
        response = self.session.patch(
            self.accounts_url + "?" + params,
            json={"last_published_at": now, "last_processed_at": now, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Yayın aralığı Supabase'e kaydedilemedi: HTTP {response.status_code}")

    def latest_published_at(self, account_id: str, user_id: str) -> str | None:
        params = urlencode({
            "select": "published_at,created_at",
            "instagram_account_id": f"eq.{account_id}",
            "user_id": f"eq.{user_id}",
            "status": "eq.published",
            "order": "published_at.desc.nullslast,created_at.desc",
            "limit": "1",
        })
        response = self.session.get(self.queue_url + "?" + params, timeout=30)
        rows = self._rows(response, "önceki yayın zamanı")
        if not rows:
            return None
        value = rows[0].get("published_at") or rows[0].get("created_at")
        return str(value) if value else None

    def media_sync_due_accounts(self, cutoff: datetime, limit: int) -> list[dict[str, Any]]:
        params = urlencode({
            "select": "id,user_id,instagram_user_id,last_media_sync_at,disconnected_at",
            "disconnected_at": "is.null",
            "order": "last_media_sync_at.asc.nullsfirst",
            "limit": "1000",
        })
        response = self.session.get(self.accounts_url + "?" + params, timeout=30)
        accounts = self._rows(response, "Instagram medya eşitleme hesapları")
        due = []
        for account in accounts:
            if _parse_time(account.get("last_media_sync_at")) <= cutoff:
                due.append(account)
        return due[:max(0, limit)]

    def published_reels(self, user_id: str, account_id: str, instagram_user_id: str) -> list[dict[str, Any]]:
        params = urlencode({
            "select": "id,user_id,instagram_account_id,ig_media_id,published_at,created_at,published_instagram_user_id,is_deleted_on_instagram",
            "user_id": f"eq.{user_id}",
            "instagram_account_id": f"eq.{account_id}",
            "status": "eq.published",
            "ig_media_id": "not.is.null",
            "published_instagram_user_id": f"eq.{instagram_user_id}",
            "published_at": "not.is.null",
            "order": "published_at.desc",
            "limit": "1000",
        })
        response = self.session.get(self.queue_url + "?" + params, timeout=30)
        return self._rows(response, "Instagram'da yayınlanmış Reels")

    def update_media_presence(self, job: dict[str, Any], present: bool) -> bool:
        return self.update(
            job,
            is_deleted_on_instagram=not present,
            instagram_deleted_at=None if present else datetime.now(timezone.utc).isoformat(),
        )

    def mark_media_sync_attempt(self, account_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        params = urlencode({"id": f"eq.{account_id}"})
        response = self.session.patch(
            self.accounts_url + "?" + params,
            json={"last_media_sync_at": now, "updated_at": now},
            headers={"Prefer": "return=representation"},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Instagram medya eşitleme zamanı kaydedilemedi: HTTP {response.status_code}")

    def finish_publication(self, user_id: str, job_id: str, media_id: str) -> bool:
        response = self.session.post(
            self.rpc_url + "/mark_reel_published",
            json={"p_user_id": user_id, "p_id": job_id, "p_media_id": media_id},
            timeout=30,
        )
        if not response.ok:
            raise QueueApiError(f"Yayın durumu Supabase'e kaydedilemedi: HTTP {response.status_code}")
        return response.json() is True

    def claim_video_import_job(self) -> dict[str, Any] | None:
        try:
            response = self.session.post(self.rpc_url + "/claim_video_import_job", json={}, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Instagram URL arşiv kuyruğuna erişilemedi (ağ hatası).") from exc
        rows = self._rows(response, "Instagram URL arşiv kuyruğu")
        return rows[0] if rows else None

    def update_video_import(self, job: dict[str, Any], **fields: Any) -> bool:
        user_id = str(job.get("user_id") or "")
        job_id = str(job.get("id") or "")
        if not user_id or not job_id:
            raise QueueApiError("Video içe aktarma kaydında sahip veya kimlik bulunamadı.")
        fields.setdefault("updated_at", datetime.now(timezone.utc).isoformat())
        params = urlencode({"id": f"eq.{job_id}", "user_id": f"eq.{user_id}", "status": "eq.processing"})
        try:
            response = self.session.patch(
                self.video_import_jobs_url + "?" + params, json=fields,
                headers={"Prefer": "return=representation"}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Video arşiv durumu güncellenemedi (ağ hatası).") from exc
        return bool(self._rows(response, "video arşiv durumu"))

    @staticmethod
    def valid_import_object_path(job: dict[str, Any], storage_path: str) -> bool:
        try:
            owner = str(UUID(str(job.get("user_id") or "")))
            job_id = UUID(str(job.get("id") or ""))
        except ValueError:
            return False
        return bool(re.fullmatch(
            rf"{re.escape(owner)}/import-{job_id.hex}\.(?:mp4|mov|m4v)", storage_path,
        ))

    def pending_video_import_objects(self, limit: int = 100) -> list[dict[str, Any]]:
        params = urlencode({
            "select": "id,user_id,shortcode,status,active_storage_path",
            "active_storage_path": "not.is.null",
            "status": "in.(queued,failed)",
            "order": "updated_at.asc",
            "limit": str(max(1, min(limit, 200))),
        })
        try:
            response = self.session.get(self.video_import_jobs_url + "?" + params, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Kayıtsız video nesneleri taranamadı (ağ hatası).") from exc
        return self._rows(response, "kayıtsız video nesneleri")

    def clear_inactive_video_import_path(self, job: dict[str, Any]) -> bool:
        job_id = str(job.get("id") or "")
        user_id = str(job.get("user_id") or "")
        if not job_id or not user_id:
            raise QueueApiError("Video aktarım temizleme kaydında sahip veya kimlik yok.")
        params = urlencode({
            "id": f"eq.{job_id}", "user_id": f"eq.{user_id}",
            "status": "in.(queued,failed)",
        })
        try:
            response = self.session.patch(
                self.video_import_jobs_url + "?" + params,
                json={"active_storage_path": None, "updated_at": datetime.now(timezone.utc).isoformat()},
                headers={"Prefer": "return=representation"}, timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Temizlenen video yolu kaydedilemedi (ağ hatası).") from exc
        return bool(self._rows(response, "temizlenen video yolu"))

    def cleanup_unregistered_video_import_objects(self, limit: int = 100) -> int:
        cleaned = 0
        for job in self.pending_video_import_objects(limit):
            storage_path = str(job.get("active_storage_path") or "")
            if not self.valid_import_object_path(job, storage_path):
                LOGGER.error("Geçersiz URL aktarım nesnesi yolu temizlenmek üzere reddedildi.")
                continue
            try:
                metadata = self.video_import_metadata_for_path(storage_path)
                if metadata:
                    if str(metadata.get("user_id") or "") != str(job.get("user_id") or ""):
                        LOGGER.error("URL aktarım nesnesi sahibi metadata ile eşleşmedi; silinmedi.")
                        continue
                    # A committed library row is authoritative; never delete its object here.
                    if self.clear_inactive_video_import_path(job):
                        cleaned += 1
                    continue
                self.delete_uploaded_video_object(storage_path)
                if self.clear_inactive_video_import_path(job):
                    cleaned += 1
            except QueueApiError:
                LOGGER.exception("Başarısız/yarım kalmış URL aktarım nesnesi temizlenemedi; sonraki turda yeniden denenecek.")
        return cleaned

    def upload_imported_video(self, job: dict[str, Any], video_path: Path) -> dict[str, Any]:
        user_id = str(job.get("user_id") or "")
        shortcode = str(job.get("shortcode") or "")
        try:
            user_id = str(UUID(user_id))
            job_id = UUID(str(job.get("id") or ""))
        except ValueError as exc:
            raise QueueApiError("Instagram URL arşivinin sahibi veya aktarım kimliği geçersiz.") from exc
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", shortcode):
            raise QueueApiError("Instagram Reel kodu geçersiz.")
        if not video_path.is_file():
            raise QueueApiError("Instagram’dan indirilen video dosyası bulunamadı.")
        suffix = video_path.suffix.lower()
        mime_type = {".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v"}.get(suffix)
        if not mime_type:
            raise QueueApiError("Instagram’dan alınan video MP4/MOV biçiminde değil.")
        size_bytes = video_path.stat().st_size
        if size_bytes < 1 or size_bytes > 50 * 1024 * 1024:
            raise QueueApiError("Instagram’dan indirilen video 50 MB depolama sınırını aşıyor.")
        storage_path = f"{user_id}/import-{job_id.hex}{suffix}"
        job["active_storage_path"] = storage_path
        if not self.update_video_import(job, active_storage_path=storage_path):
            raise QueueApiError("Özel arşiv dosya yolu güvenli biçimde kaydedilemedi.")
        object_url = f"{self.storage_url}/object/reelflow-original-videos/{quote(storage_path, safe='/')}"
        try:
            with video_path.open("rb") as handle:
                response = self.session.post(
                    object_url, data=handle,
                    headers={"Content-Type": mime_type, "x-upsert": "true"},
                    timeout=(15, 900),
                )
        except (OSError, requests.RequestException) as exc:
            self._remove_unregistered_import_object(job, storage_path)
            raise QueueApiError(f"Video özel bulut arşivine yüklenemedi: {type(exc).__name__}.") from exc
        if not response.ok:
            self._remove_unregistered_import_object(job, storage_path)
            raise QueueApiError(f"Video özel bulut arşivine yüklenemedi: HTTP {response.status_code}.")
        return {
            "storage_path": storage_path,
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "original_filename": f"instagram-{shortcode}{suffix}",
        }

    def _remove_unregistered_import_object(self, job: dict[str, Any], storage_path: str) -> bool:
        try:
            self.delete_uploaded_video_object(storage_path)
        except QueueApiError:
            LOGGER.exception("Kayıtsız Instagram URL aktarım dosyası temizlenemedi.")
            return False
        try:
            if not self.update_video_import(job, active_storage_path=None):
                raise QueueApiError("Temizleme yolu import kaydında sıfırlanamadı.")
            job["active_storage_path"] = None
            return True
        except QueueApiError:
            LOGGER.exception("Silinen Instagram URL dosyasının yolu import kaydında sıfırlanamadı.")
            return False

    def finish_video_import(self, job: dict[str, Any], metadata: dict[str, Any]) -> str:
        payload = {
            "p_import_id": job.get("id"),
            "p_storage_path": metadata["storage_path"],
            "p_original_filename": metadata["original_filename"],
            "p_mime_type": metadata["mime_type"],
            "p_size_bytes": metadata["size_bytes"],
        }
        try:
            response = self.session.post(self.rpc_url + "/finish_video_import", json=payload, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Video arşiv kaydı tamamlanamadı (ağ hatası).") from exc
        if not response.ok:
            raise QueueApiError(f"Video arşiv kaydı tamamlanamadı: HTTP {response.status_code}.")
        try:
            data = response.json()
        except ValueError as exc:
            raise QueueApiError("Video arşiv kaydı yanıtı geçersiz.") from exc
        if isinstance(data, str):
            job["active_storage_path"] = None
            return data
        if isinstance(data, list) and data and isinstance(data[0], dict):
            job["active_storage_path"] = None
            return str(data[0].get("finish_video_import") or data[0].get("id") or "")
        job["active_storage_path"] = None
        return str(data.get("id") or "") if isinstance(data, dict) else ""

    def video_import_metadata_for_path(self, storage_path: str) -> dict[str, Any] | None:
        params = urlencode({
            "select": "id,user_id,storage_path,source_shortcode,original_filename,mime_type,size_bytes,cleanup_pending",
            "storage_path": f"eq.{storage_path}",
            "limit": "1",
        })
        try:
            response = self.session.get(self.project_url + "/rest/v1/uploaded_videos?" + params, timeout=30)
        except requests.RequestException as exc:
            raise QueueApiError("Video arşiv sonucu doğrulanamadı (ağ hatası).") from exc
        rows = self._rows(response, "video arşiv sonucu")
        return rows[0] if rows else None

    def fail_video_import(self, job: dict[str, Any], message: str) -> None:
        try:
            response = self.session.post(
                self.rpc_url + "/fail_video_import",
                json={"p_import_id": job.get("id"), "p_error_message": str(message)[:1000]},
                timeout=30,
            )
        except requests.RequestException as exc:
            raise QueueApiError("Başarısız video aktarım durumu kaydedilemedi (ağ hatası).") from exc
        if not response.ok:
            raise QueueApiError(f"Başarısız video aktarım durumu kaydedilemedi: HTTP {response.status_code}.")


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
            queue.update_instagram_token(str(connection["id"]), str(connection["user_id"]), fresh_token, fresh_expiry)
            connection = {**connection, "access_token": fresh_token, "token_expires_at": fresh_expiry, "refreshed_at": now.isoformat()}
    return connection


def _connection_with_published_history(
    queue: SupabaseQueue, connection: dict[str, Any] | None
) -> dict[str, Any] | None:
    if not connection or connection.get("last_published_at"):
        return connection
    last_published_at = queue.latest_published_at(str(connection["id"]), str(connection["user_id"]))
    return {**connection, "last_published_at": last_published_at} if last_published_at else connection


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


class PublicationProgress:
    """Publish-stage progress writer; telemetry failures must not cancel an Instagram publish."""

    def __init__(self, queue: SupabaseQueue, job: dict[str, Any], initial_progress: int = 62) -> None:
        self.queue = queue
        self.job = job
        self.last_progress = initial_progress
        self.last_stage = ""

    def __call__(self, percent: int, stage: str) -> None:
        progress = max(self.last_progress, min(98, max(0, int(percent))))
        safe_stage = str(stage)[:200]
        if progress == self.last_progress and safe_stage == self.last_stage:
            return
        try:
            updated = self.queue.update(self.job, progress=progress, stage=safe_stage)
        except (QueueApiError, requests.RequestException, ValueError) as exc:
            LOGGER.warning("Yayın ilerlemesi kaydedilemedi (%s): %s", self.job.get("shortcode", "bilinmeyen"), type(exc).__name__)
            return
        if updated:
            self.last_progress = progress
            self.last_stage = safe_stage


def _sync_published_instagram_media(queue: SupabaseQueue, settings: Settings) -> tuple[int, int]:
    """Compare locally tracked publications with each connected account's media list."""
    now = datetime.now(timezone.utc)
    due_accounts = queue.media_sync_due_accounts(now - MEDIA_SYNC_INTERVAL, MAX_MEDIA_SYNC_ACCOUNTS_PER_RUN)
    removed = restored = 0
    for account in due_accounts:
        account_id = str(account.get("id") or "")
        user_id = str(account.get("user_id") or "")
        instagram_user_id = str(account.get("instagram_user_id") or "")
        if not account_id or not user_id or not instagram_user_id:
            continue
        account_removed = account_restored = 0
        try:
            rows = queue.published_reels(user_id, account_id, instagram_user_id)
            if not rows:
                continue
            connection = queue.instagram_connection(account_id, user_id)
            if (not connection
                    or str(connection.get("id") or "") != account_id
                    or str(connection.get("instagram_user_id") or "") != instagram_user_id):
                continue
            connection = _active_connection(queue, connection)
            dates = [
                _parse_time(row.get("published_at") or row.get("created_at"))
                for row in rows
            ]
            dates = [value for value in dates if value != datetime.min.replace(tzinfo=timezone.utc)]
            if not dates:
                continue
            media_ids, oldest_seen, coverage_complete = _publisher(
                settings,
                str(connection["access_token"]),
                instagram_user_id,
            ).list_own_media_ids(min(dates), max_pages=MAX_MEDIA_SYNC_PAGES)

            for row in rows:
                published_at = _parse_time(row.get("published_at") or row.get("created_at"))
                if published_at == datetime.min.replace(tzinfo=timezone.utc):
                    continue
                is_covered = coverage_complete or (oldest_seen is not None and published_at >= oldest_seen)
                if not is_covered:
                    continue
                present = str(row.get("ig_media_id") or "") in media_ids
                was_missing = row.get("is_deleted_on_instagram") is True
                if present == (not was_missing):
                    continue
                if queue.update_media_presence(row, present):
                    if present:
                        account_restored += 1
                    else:
                        account_removed += 1
            removed += account_removed
            restored += account_restored
            LOGGER.info(
                "Instagram medya eşitlemesi tamamlandı: hesap=%s, kontrol edilen=%d, artık bulunmayan=%d, geri gelen=%d%s",
                account_id,
                len(rows),
                account_removed,
                account_restored,
                " (kısmi tarama)" if not coverage_complete else "",
            )
        except (InstagramApiError, QueueApiError, KeyError, TypeError, ValueError, OSError) as exc:
            LOGGER.warning("Instagram medya eşitlemesi atlandı (hesap=%s): %s", account_id, exc)
        finally:
            try:
                queue.mark_media_sync_attempt(account_id)
            except QueueApiError:
                LOGGER.exception("Instagram medya eşitleme zamanı kaydedilemedi (hesap=%s).", account_id)
    return removed, restored


def _cleanup_uploaded_video_objects(queue: Any, context: str) -> None:
    cleanup = getattr(queue, "cleanup_uploaded_videos", None)
    if not callable(cleanup):
        return
    try:
        cleanup()
    except QueueApiError:
        LOGGER.exception("%s", context)


def _cleanup_stale_temporary_video_objects(queue: Any) -> None:
    cleanup = getattr(queue, "cleanup_stale_temporary_videos", None)
    if not callable(cleanup):
        return
    try:
        cleanup()
    except QueueApiError:
        LOGGER.exception("Süre aşımı dolan özel geçici video temizliği başlatılamadı.")


def _cleanup_unregistered_video_import_objects(queue: Any, context: str) -> None:
    cleanup = getattr(queue, "cleanup_unregistered_video_import_objects", None)
    if not callable(cleanup):
        return
    try:
        cleanup()
    except QueueApiError:
        LOGGER.exception("%s", context)


def _canonical_import_url(job: dict[str, Any]) -> str:
    shortcode = str(job.get("shortcode") or "")
    source_url = str(job.get("source_url") or "")
    parsed = urlsplit(source_url)
    host = (parsed.hostname or "").lower()
    match = re.fullmatch(r"/(?:reel|reels|p)/([A-Za-z0-9_-]{1,64})/?", parsed.path, flags=re.IGNORECASE)
    if (parsed.scheme != "https" or host not in {"instagram.com", "www.instagram.com"}
            or parsed.username or parsed.password or parsed.port not in {None, 443}
            or parsed.query or parsed.fragment or not match
            or match.group(1).lower() != shortcode.lower()):
        raise DownloadError("Instagram Reel bağlantısı geçersiz; bağlantıyı kontrol edip tekrar dene.")
    return f"https://www.instagram.com/reel/{match.group(1)}/"


def _video_import_error(exc: Exception, source_url: str) -> str:
    message = str(exc).replace(source_url, "Instagram Reel bağlantısı")
    if "50 MB" in message or "52428800" in message:
        return "Instagram’dan indirilen video 50 MB sınırını aşıyor; farklı bir Reel URL’si dene."
    if isinstance(exc, DownloadError):
        return "Instagram videosu indirilemedi. Reel herkese açık ve erişilebilir mi kontrol et; özel veya kısıtlı Reels indirilemeyebilir."
    return message[:1000] or "Instagram videosu bulut arşivine kaydedilemedi."


def _process_video_imports(queue: Any, settings: Settings, limit: int = 1) -> tuple[int, int]:
    claim = getattr(queue, "claim_video_import_job", None)
    if not callable(claim):
        return 0, 0
    saved = failed = 0
    for _ in range(max(0, min(int(limit), 5))):
        try:
            job = claim()
        except QueueApiError:
            LOGGER.exception("Instagram URL arşiv kuyruğundan iş alınamadı.")
            break
        if not job:
            break
        shortcode = str(job.get("shortcode") or "bilinmeyen")
        source_url = str(job.get("source_url") or "")
        source_file: Path | None = None
        storage_path = str(job.get("active_storage_path") or "") or None
        try:
            if storage_path:
                if not queue.valid_import_object_path(job, storage_path):
                    raise QueueApiError("Önceki URL aktarımındaki nesne yolu güvenli değil.")
                persisted = queue.video_import_metadata_for_path(storage_path)
                if persisted:
                    if str(persisted.get("user_id") or "") != str(job.get("user_id") or ""):
                        raise QueueApiError("Önceki URL aktarım nesnesinin sahibi uyuşmuyor.")
                    recovered = {
                        "storage_path": storage_path,
                        "original_filename": persisted.get("original_filename"),
                        "mime_type": persisted.get("mime_type"),
                        "size_bytes": persisted.get("size_bytes"),
                    }
                    video_id = queue.finish_video_import(job, recovered)
                    if video_id:
                        job["active_storage_path"] = None
                        storage_path = None
                        saved += 1
                        continue
                    raise QueueApiError("Önceki URL aktarımı arşiv kaydıyla eşitlenemedi.")
                queue.delete_uploaded_video_object(storage_path)
                if not queue.update_video_import(job, active_storage_path=None):
                    raise QueueApiError("Önceki URL aktarım dosyası silindi fakat temizleme yolu sıfırlanamadı.")
                job["active_storage_path"] = None
                storage_path = None
            canonical_url = _canonical_import_url(job)
            try:
                queue.update_video_import(job, progress=12, stage="Instagram Reel indiriliyor")
            except QueueApiError:
                LOGGER.warning("URL arşiv ilerlemesi kaydedilemedi (%s).", shortcode)
            source_file = download_reel(
                canonical_url, shortcode, settings.download_dir, settings.cookies_file,
                max_filesize_bytes=50 * 1024 * 1024,
            )
            if not source_file.is_file() or source_file.suffix.lower() not in {".mp4", ".mov", ".m4v"}:
                raise DownloadError("Instagram’dan alınan video MP4/MOV biçiminde değil; farklı bir URL dene.")
            size_bytes = source_file.stat().st_size
            if size_bytes < 1 or size_bytes > 50 * 1024 * 1024:
                raise DownloadError("Instagram’dan indirilen video 50 MB depolama sınırını aşıyor.")
            try:
                queue.update_video_import(job, progress=68, stage="Video özel bulut arşivine yükleniyor")
            except QueueApiError:
                LOGGER.warning("URL arşiv ilerlemesi kaydedilemedi (%s).", shortcode)
            metadata = queue.upload_imported_video(job, source_file)
            storage_path = str(metadata["storage_path"])
            try:
                queue.update_video_import(job, progress=92, stage="Bulut arşiv kaydı tamamlanıyor")
            except QueueApiError:
                LOGGER.warning("URL arşiv ilerlemesi kaydedilemedi (%s).", shortcode)
            video_id = queue.finish_video_import(job, metadata)
            if not video_id:
                raise QueueApiError("Özel bulut video kaydı boş yanıt verdi.")
            job["active_storage_path"] = None
            storage_path = None
            saved += 1
            LOGGER.info("Instagram Reel özel bulut arşivine kaydedildi: %s", shortcode)
        except (DownloadError, MediaError, QueueApiError, ValueError, OSError, requests.RequestException) as exc:
            storage_path = str(job.get("active_storage_path") or storage_path or "") or None
            if storage_path:
                metadata_check_failed = False
                try:
                    persisted = queue.video_import_metadata_for_path(storage_path)
                except QueueApiError:
                    persisted = None
                    metadata_check_failed = True
                    LOGGER.exception("Belirsiz URL arşiv kaydı doğrulanamadı (%s). Dosyayı koruyoruz.", shortcode)
                if metadata_check_failed:
                    pass
                elif persisted:
                    try:
                        queue.finish_video_import(job, {
                            "storage_path": storage_path,
                            "original_filename": persisted.get("original_filename"),
                            "mime_type": persisted.get("mime_type"),
                            "size_bytes": persisted.get("size_bytes"),
                        })
                    except QueueApiError:
                        LOGGER.exception("Kaydedilmiş URL aktarımı sonlandırılamadı (%s).", shortcode)
                        continue
                    job["active_storage_path"] = None
                    storage_path = None
                    saved += 1
                    LOGGER.info("Instagram Reel özel bulut arşivine kaydedildi (yanıt yeniden doğrulandı): %s", shortcode)
                    continue
                elif queue.valid_import_object_path(job, storage_path):
                    queue._remove_unregistered_import_object(job, storage_path)
                storage_path = str(job.get("active_storage_path") or "") or None
            message = _video_import_error(exc, source_url)
            try:
                queue.fail_video_import(job, message)
            except QueueApiError:
                LOGGER.exception("URL arşiv hatası Supabase'e kaydedilemedi (%s).", shortcode)
            LOGGER.warning("Instagram URL arşiv aktarımı başarısız (%s): %s", shortcode, message)
            failed += 1
        finally:
            _cleanup(source_file)
    return saved, failed


def run_worker() -> dict[str, int]:
    project_url = os.getenv("SUPABASE_URL", "").strip()
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not project_url or not service_key:
        raise ConfigError("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY gerekli.")

    settings = load_settings(require_account_credentials=False)
    if settings.api_mode != "instagram_login":
        raise ConfigError("Kullanıcıya ait Instagram hesaplarını yayınlamak için IG_API_MODE=instagram_login olmalı.")
    try:
        max_video_imports = int(os.getenv("MAX_VIDEO_IMPORTS_PER_RUN", "1"))
    except ValueError as exc:
        raise ConfigError("MAX_VIDEO_IMPORTS_PER_RUN 0 ile 5 arasında sayı olmalı.") from exc
    if not 0 <= max_video_imports <= 5:
        raise ConfigError("MAX_VIDEO_IMPORTS_PER_RUN 0 ile 5 arasında olmalı.")
    ensure_tools_available()

    queue = SupabaseQueue(project_url, service_key)
    _cleanup_uploaded_video_objects(queue, "Önceki yayınlardan kalan özel video temizliği başlatılamadı.")
    _cleanup_stale_temporary_video_objects(queue)
    _cleanup_unregistered_video_import_objects(queue, "Önceki URL arşiv aktarımından kalan nesneler temizlenemedi.")
    imports_saved, imports_failed = _process_video_imports(queue, settings, max_video_imports)
    _cleanup_unregistered_video_import_objects(queue, "URL arşiv aktarımından kalan nesneler temizlenemedi.")
    if settings.max_posts_per_run <= 0:
        LOGGER.info("MAX_POSTS_PER_RUN sıfır; bu turda Reel yayınlanmayacak.")
        result = {"published": 0, "failed": 0, "skipped": 0}
        if imports_saved or imports_failed:
            result.update({"video_imports_saved": imports_saved, "video_imports_failed": imports_failed})
        return result
    target_reel_id = os.getenv("TARGET_REEL_ID", "").strip()
    if target_reel_id:
        try:
            target_reel_id = str(UUID(target_reel_id))
        except ValueError as exc:
            raise ConfigError("TARGET_REEL_ID geçerli bir UUID olmalı.") from exc
    jobs = queue.queued(
        max(50, settings.max_posts_per_run * 20),
        target_job_id=target_reel_id or None,
    )
    connections: dict[str, dict[str, Any] | None] = {}
    for job in jobs:
        account_id = str(job.get("instagram_account_id") or "")
        if account_id and account_id not in connections:
            connection = queue.instagram_connection(account_id, str(job.get("user_id") or ""))
            connections[account_id] = _connection_with_published_history(queue, connection)

    def fairness_key(job: dict[str, Any]) -> tuple[bool, datetime, datetime]:
        connection = connections.get(str(job.get("instagram_account_id") or ""))
        last = _parse_time(connection.get("last_processed_at")) if connection else datetime.min.replace(tzinfo=timezone.utc)
        return job.get("publish_now") is not True, last, _parse_time(job.get("created_at"))

    jobs.sort(key=fairness_key)
    published = failed = skipped = claimed = 0
    LOGGER.info("Bulut işçisi %d kuyruk kaydı buldu.", len(jobs))

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
        account_id = str(job.get("instagram_account_id") or "")
        if not account_id:
            _mark_failed(queue, job, "Bu Reel için yayınlanacağı Instagram hesabını ReelFlow panelinde seç.")
            failed += 1
            continue
        connection = connections.get(account_id)
        if not connection:
            _mark_failed(queue, job, "Bu Reel'in hedef Instagram hesabı bağlı değil. Yeniden bağla veya ReelFlow'da açıkça başka hedef seç.")
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
        temporary_storage_path: str | None = None
        cover_url: str | None = None
        try:
            queue.mark_processed(account_id)
            connection = _active_connection(queue, connection)
            connections[account_id] = connection
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
            source_url = str(job.get("source_url") or "")
            uploaded_video_id = str(job.get("uploaded_video_id") or "")
            public_video_url: str | None = None
            if uploaded_video_id:
                queue.update(job, progress=10, stage="Özel video arşivinden indiriliyor")
                source_file, signed_url = queue.download_uploaded_video(job, settings.download_dir)
                if original_reel_is_meta_compatible(source_file):
                    reel_file = source_file
                    public_video_url = signed_url
                    queue.update(job, progress=62, stage=f"Özel arşiv · süreli bağlantı @{connection['username']} hesabına hazır")
                else:
                    queue.update(job, progress=35, stage="Video uyumluluğu düzenleniyor · Instagram biçimine hazırlanıyor")
                    reel_file = prepare_for_reels(source_file, settings.download_dir)
                    temporary_storage_path, public_video_url = queue.upload_temporary_video(reel_file)
                    queue.update(job, progress=62, stage=f"Dönüştürülen video özel depoda · @{connection['username']} hesabına hazır")
            else:
                queue.update(job, progress=10, stage="Reel indiriliyor")
                source_file = download_reel(source_url, str(job["shortcode"]), settings.download_dir, settings.cookies_file)
                queue.update(job, progress=35, stage="Video indirildi · dikey formata hazırlanıyor")
                reel_file = prepare_for_reels(source_file, settings.download_dir)
                queue.update(job, progress=62, stage=f"Video hazırlandı · @{connection['username']} hesabına yükleniyor")
            if job.get("cover_image_id"):
                cover_url = queue.signed_cover_image(job)
            caption = str(job.get("caption") or settings.default_caption).replace("{source_url}", source_url)
            progress_callback = PublicationProgress(queue, job, initial_progress=62)
            publish_kwargs: dict[str, Any] = {"progress_callback": progress_callback}
            if public_video_url:
                publish_kwargs["public_video_url"] = public_video_url
            if cover_url:
                publish_kwargs["cover_url"] = cover_url
            media_id = publisher.publish_reel(reel_file, caption, **publish_kwargs)
            if temporary_storage_path:
                try:
                    queue.delete_temporary_video(temporary_storage_path)
                    temporary_storage_path = None
                except QueueApiError:
                    LOGGER.exception("Meta yayını tamamlandı fakat dönüştürülmüş özel geçici video silinemedi; süre aşımı temizliği yeniden deneyecek.")
            published += 1
            connection = {**connection, "last_published_at": datetime.now(timezone.utc).isoformat()}
            connections[account_id] = connection
            try:
                saved = queue.finish_publication(user_id, str(job["id"]), media_id)
            except QueueApiError:
                LOGGER.exception("Instagram yayınlandı fakat kuyruk durumu eşitlenemedi (%s).", job["shortcode"])
                try:
                    queue.mark_published_time(account_id)
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
                    queue.mark_published_time(account_id)
                except QueueApiError:
                    LOGGER.exception("Yayın aralığı fallback olarak da yazılamadı (%s).", job["shortcode"])
                try:
                    queue.update(job, progress=100, stage="Instagramda yayınlandı · durum eşitlemesi gerekli", error_message=None)
                except QueueApiError:
                    LOGGER.exception("Yayın sonrası uyarı durumu da yazılamadı (%s).", job["shortcode"])
                skipped += 1
                continue
            LOGGER.info("Reel Instagram hesabında yayınlandı: %s", job["shortcode"])
            if uploaded_video_id:
                _cleanup_uploaded_video_objects(queue, "Yayın sonrası özel video temizliği ertelendi.")
        except (DownloadError, MediaError, InstagramApiError, ValueError, OSError, QueueApiError) as exc:
            safe_error = str(exc).replace(str(connection.get("access_token", "")), "[TOKEN]")[:1000]
            _mark_failed(queue, job, safe_error)
            LOGGER.error("Reel başarısız (%s): %s", job["shortcode"], safe_error)
            failed += 1
        finally:
            _cleanup(source_file, reel_file)

    try:
        _sync_published_instagram_media(queue, settings)
    except QueueApiError:
        LOGGER.exception("Instagram medya eşitleme turu başlatılamadı.")

    _cleanup_uploaded_video_objects(queue, "Yayın sonrası özel video temizliği tamamlanamadı.")
    result = {"published": published, "failed": failed, "skipped": skipped}
    if imports_saved or imports_failed:
        result.update({"video_imports_saved": imports_saved, "video_imports_failed": imports_failed})
    return result


def main() -> int:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    result = run_worker()
    LOGGER.info(
        "Tur tamamlandı: %d yayınlandı, %d başarısız, %d atlandı, %d URL arşive kaydedildi, %d URL indirmesi başarısız.",
        result["published"], result["failed"], result["skipped"],
        result.get("video_imports_saved", 0), result.get("video_imports_failed", 0),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
