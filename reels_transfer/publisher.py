"""Instagram Graph API ile Reel yayınlama.

Instagram Login modu: video önce geçici bir HTTPS medya yükleyicisine konur,
sonra graph.instagram.com üzerinde video_url ile container oluşturulur.
Facebook Login modu: mevcut resumable rupload akışını kullanır.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import requests

from .cloudinary_uploader import CloudinaryUploadError, CloudinaryUploader

FACEBOOK_GRAPH_HOST = "https://graph.facebook.com"
INSTAGRAM_GRAPH_HOST = "https://graph.instagram.com"
UPLOAD_HOST_PREFIX = "https://rupload.facebook.com/"
TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"
CATBOX_UPLOAD_URL = "https://catbox.moe/user/api.php"
MAX_CAPTION_LENGTH = 2200


class InstagramApiError(RuntimeError):
    """Graph API veya yükleme hatası. Mesajlara token asla eklenmez."""


class InstagramPublisher:
    def __init__(
        self,
        access_token: str,
        ig_user_id: str,
        graph_version: str = "v25.0",
        poll_seconds: int = 60,
        poll_attempts: int = 5,
        session: requests.Session | None = None,
        sleep: Callable[[float], None] = time.sleep,
        api_mode: str = "facebook_login",
        public_upload_mode: str = "cloudinary",
        cloudinary_cloud_name: str = "",
        cloudinary_upload_preset: str = "",
    ) -> None:
        self._token = access_token
        self._ig_user_id = ig_user_id
        self._graph_version = graph_version
        self._api_mode = api_mode
        self._public_upload_mode = public_upload_mode
        host = INSTAGRAM_GRAPH_HOST if api_mode == "instagram_login" else FACEBOOK_GRAPH_HOST
        self._base_url = f"{host}/{graph_version}"
        self._poll_seconds = poll_seconds
        self._poll_attempts = poll_attempts
        self._session = session or requests.Session()
        self._sleep = sleep
        self._cloudinary = CloudinaryUploader(cloudinary_cloud_name, cloudinary_upload_preset, self._session)

    def _bearer_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def _request(self, method: str, url: str, timeout: Any = 60, **kwargs: Any) -> dict[str, Any]:
        try:
            response = self._session.request(method, url, timeout=timeout, **kwargs)
        except requests.RequestException as exc:
            raise InstagramApiError(f"Ağ hatası: {type(exc).__name__}") from exc
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not response.ok or "error" in payload:
            detail = payload.get("error") or payload.get("debug_info") or payload
            # Tokenı olası hata gövdesinden de temizle.
            text = str(detail).replace(self._token, "[TOKEN]")
            raise InstagramApiError(f"HTTP {response.status_code}: {text}")
        return payload

    def remaining_quota(self) -> int:
        payload = self._request(
            "GET",
            f"{self._base_url}/{self._ig_user_id}/content_publishing_limit",
            headers=self._bearer_headers(),
            params={"fields": "quota_usage,config"},
        )
        entry = (payload.get("data") or [{}])[0]
        total = entry.get("config", {}).get("quota_total")
        used = entry.get("quota_usage")
        if total is None or used is None:
            # Bazı Instagram Login sürümlerinde kota endpoint'i farklı gövde döndürebilir.
            # Yayın akışını gereksiz yere durdurmamak için limit yoksa güvenli bütçe kullanılır.
            if self._api_mode == "instagram_login":
                return 100
            raise InstagramApiError(f"Beklenmeyen kota yanıtı: {payload}")
        return max(0, int(total) - int(used))

    @staticmethod
    def _parse_media_timestamp(value: Any) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def list_own_media_ids(
        self,
        oldest_needed_at: datetime,
        max_pages: int = 25,
    ) -> tuple[set[str], datetime | None, bool]:
        """List own Instagram media IDs, stopping once tracked publication dates are covered."""
        if self._api_mode != "instagram_login":
            raise InstagramApiError("Kendi medya listesi Instagram Login API'si gerektirir.")
        if oldest_needed_at.tzinfo is None:
            oldest_needed_at = oldest_needed_at.replace(tzinfo=timezone.utc)
        oldest_needed_at = oldest_needed_at.astimezone(timezone.utc)
        page_limit = max(1, min(int(max_pages), 100))
        url = f"{self._base_url}/{self._ig_user_id}/media"
        params: dict[str, str] = {"fields": "id,timestamp", "limit": "100"}
        seen_cursors: set[str] = set()
        media_ids: set[str] = set()
        oldest_seen: datetime | None = None
        coverage_complete = False

        for _ in range(page_limit):
            payload = self._request(
                "GET", url, headers=self._bearer_headers(), params=params, timeout=30,
            )
            entries = payload.get("data")
            if not isinstance(entries, list):
                raise InstagramApiError("Instagram medya listesi beklenmeyen yanıt döndürdü.")

            page_oldest: datetime | None = None
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                media_id = entry.get("id")
                if media_id is not None:
                    media_ids.add(str(media_id))
                timestamp = self._parse_media_timestamp(entry.get("timestamp"))
                if timestamp and (page_oldest is None or timestamp < page_oldest):
                    page_oldest = timestamp
            if page_oldest and (oldest_seen is None or page_oldest < oldest_seen):
                oldest_seen = page_oldest

            paging = payload.get("paging") or {}
            next_url = paging.get("next") if isinstance(paging, dict) else None
            if not next_url:
                coverage_complete = True
                break
            if page_oldest and page_oldest <= oldest_needed_at:
                coverage_complete = True
                break

            cursors = paging.get("cursors") or {}
            after = cursors.get("after") if isinstance(cursors, dict) else None
            if not after and isinstance(next_url, str):
                after = parse_qs(urlsplit(next_url).query).get("after", [None])[0]
            after = str(after or "")
            if not after or after in seen_cursors:
                break
            seen_cursors.add(after)
            params["after"] = after

        return media_ids, oldest_seen, coverage_complete

    def upload_public_video(
        self,
        video_path: Path,
        progress_callback: Callable[[int, str], None] | None = None,
    ) -> str:
        """Instagram Login için Meta'nın erişebileceği geçici HTTPS URL üretir.

        Dosyayı üçüncü taraf bir medya sunucusuna yükler; hassas videoları
        bu modu kullanmadan önce bunu göz önünde bulundur.
        """
        if self._public_upload_mode == "cloudinary":
            try:
                def report_cloudinary_progress(percent: int) -> None:
                    if not progress_callback:
                        return
                    bucket = min(100, max(0, (int(percent) // 10) * 10))
                    overall = 62 + int(bucket * 0.20)
                    progress_callback(overall, f"Cloudinary'ye video aktarılıyor · %{bucket}")

                return self._cloudinary.upload_video(
                    video_path,
                    report_cloudinary_progress if progress_callback else None,
                )
            except CloudinaryUploadError as exc:
                raise InstagramApiError(str(exc)) from exc
        if self._public_upload_mode == "catbox":
            upload_url = CATBOX_UPLOAD_URL
        elif self._public_upload_mode == "tmpfiles":
            upload_url = TMPFILES_UPLOAD_URL
        else:
            raise InstagramApiError(
                "Instagram Login için PUBLIC_UPLOAD_MODE=cloudinary, catbox veya tmpfiles olmalı; "
                "Instagram yerel Windows dosyasını doğrudan göremez."
            )
        if progress_callback:
            progress_callback(64, "Geçici video aktarımı başlıyor")
        if not video_path.exists():
            raise InstagramApiError(f"Yüklenecek dosya yok: {video_path.name}")
        try:
            with video_path.open("rb") as handle:
                if self._public_upload_mode == "catbox":
                    response = self._session.post(
                        upload_url,
                        data={"reqtype": "fileupload"},
                        files={"fileToUpload": (video_path.name, handle, "video/mp4")},
                        timeout=(15, 900),
                    )
                    url = response.text.strip()
                    if not response.ok or not url.startswith("https://files.catbox.moe/"):
                        raise InstagramApiError(f"Catbox yüklemesi başarısız: HTTP {response.status_code}")
                    try:
                        check = self._session.get(url, headers={"Range": "bytes=0-31"}, timeout=(15, 60))
                    except requests.RequestException as exc:
                        raise InstagramApiError(f"Yüklenen MP4 URL'si kontrol edilemedi: {type(exc).__name__}") from exc
                    content_type = (check.headers.get("content-type") or "").lower()
                    if not check.ok or "video" not in content_type and not url.lower().endswith(".mp4"):
                        raise InstagramApiError(
                            f"Yüklenen adres MP4 döndürmüyor (HTTP {check.status_code}, {content_type or 'content-type yok'})."
                        )
                    return url
                response = self._session.post(
                    upload_url,
                    files={"file": (video_path.name, handle, "video/mp4")},
                    timeout=(15, 900),
                )
            payload = response.json()
        except (OSError, requests.RequestException, ValueError) as exc:
            raise InstagramApiError(f"Geçici HTTPS yükleme başarısız: {type(exc).__name__}") from exc
        if not response.ok or payload.get("status") != "success":
            raise InstagramApiError(f"Geçici HTTPS yükleme başarısız: HTTP {response.status_code}")
        url = (payload.get("data") or {}).get("url", "")
        if not url.startswith("https://"):
            raise InstagramApiError("Geçici yükleyici geçerli bir HTTPS adresi döndürmedi.")
        # tmpfiles.org görüntüleme URL'sini doğrudan indirme URL'sine çevir.
        url = url.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/", 1)
        if progress_callback:
            progress_callback(82, "Geçici video aktarımı tamamlandı")
        return url

    def create_reel_container(self, caption: str, video_url: str | None = None) -> tuple[str, str | None]:
        if len(caption) > MAX_CAPTION_LENGTH:
            raise InstagramApiError(f"Açıklama {MAX_CAPTION_LENGTH} karakteri aşıyor.")
        form: dict[str, str] = {"media_type": "REELS"}
        if caption:
            form["caption"] = caption
        if self._api_mode == "instagram_login":
            if not video_url:
                raise InstagramApiError("Instagram Login için herkese açık video URL'si gerekli.")
            form["video_url"] = video_url
        else:
            form["upload_type"] = "resumable"
        payload = self._request(
            "POST", f"{self._base_url}/{self._ig_user_id}/media",
            headers=self._bearer_headers(), data=form,
        )
        container_id = payload.get("id")
        upload_uri = payload.get("uri")
        if not container_id or (self._api_mode != "instagram_login" and not upload_uri):
            raise InstagramApiError(f"Container yanıtı eksik: {payload}")
        return container_id, upload_uri

    def upload_video(self, upload_uri: str | None, video_path: Path) -> None:
        if self._api_mode == "instagram_login":
            return
        if not upload_uri or not upload_uri.startswith(UPLOAD_HOST_PREFIX):
            raise InstagramApiError("Güvenilmeyen veya eksik yükleme adresi; işlem durduruldu.")
        if not video_path.exists():
            raise InstagramApiError(f"Yüklenecek dosya yok: {video_path.name}")
        headers = {"Authorization": f"OAuth {self._token}", "offset": "0", "file_size": str(video_path.stat().st_size)}
        with video_path.open("rb") as handle:
            payload = self._request("POST", upload_uri, headers=headers, data=handle, timeout=(10, 900))
        if not payload.get("success"):
            raise InstagramApiError(f"Yükleme başarısız: {payload}")

    def wait_until_ready(
        self,
        container_id: str,
        progress_callback: Callable[[int, str], None] | None = None,
    ) -> None:
        for attempt in range(1, self._poll_attempts + 1):
            payload = self._request(
                "GET", f"{self._base_url}/{container_id}",
                headers=self._bearer_headers(), params={"fields": "status_code,status"},
            )
            status = payload.get("status_code")
            if status == "FINISHED":
                if progress_callback:
                    progress_callback(97, "Instagram videosu hazır · yayınlanıyor")
                return
            if status in {"ERROR", "EXPIRED"}:
                detail = payload.get("status") or payload.get("error") or status
                raise InstagramApiError(f"Container durumu: {detail}; Meta yanıtı: {payload}")
            if progress_callback:
                divisor = max(1, self._poll_attempts)
                percent = min(96, 84 + int(12 * attempt / divisor))
                progress_callback(percent, f"Instagram videoyu işliyor · kontrol {attempt}/{self._poll_attempts}")
            if attempt < self._poll_attempts:
                self._sleep(self._poll_seconds)
        raise InstagramApiError("Video işleme süresi aşıldı; STATUS_POLL_ATTEMPTS değerini artır.")

    def publish_container(self, container_id: str) -> str:
        payload = self._request(
            "POST", f"{self._base_url}/{self._ig_user_id}/media_publish",
            headers=self._bearer_headers(), data={"creation_id": container_id},
        )
        media_id = payload.get("id")
        if not media_id:
            raise InstagramApiError(f"Yayın yanıtı eksik: {payload}")
        return media_id

    def publish_reel(
        self,
        video_path: Path,
        caption: str,
        progress_callback: Callable[[int, str], None] | None = None,
    ) -> str:
        public_url = self.upload_public_video(video_path, progress_callback) if self._api_mode == "instagram_login" else None
        if progress_callback:
            progress_callback(84, "Instagram Reels bilgileri hazırlanıyor")
        container_id, upload_uri = self.create_reel_container(caption, public_url)
        self.upload_video(upload_uri, video_path)
        self.wait_until_ready(container_id, progress_callback)
        if progress_callback:
            progress_callback(98, "Instagram hesabında yayınlanıyor")
        media_id = self.publish_container(container_id)
        if progress_callback:
            progress_callback(99, "Yayın yanıtı alındı · kayıt güncelleniyor")
        return media_id


def refresh_long_lived_token(
    access_token: str,
    session: requests.Session | None = None,
) -> tuple[str, int]:
    """Instagram Login long-lived tokenını 60 güne kadar yenile; URL/yanıtı loglama."""
    client = session or requests.Session()
    try:
        response = client.get(
            f"{INSTAGRAM_GRAPH_HOST}/refresh_access_token",
            params={"grant_type": "ig_refresh_token", "access_token": access_token},
            timeout=30,
        )
    except requests.RequestException as exc:
        raise InstagramApiError(f"Instagram token yenileme ağ hatası: {type(exc).__name__}") from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if not response.ok or payload.get("error"):
        detail = payload.get("error")
        detail = detail.get("message", "Meta tokenı yenilemedi.") if isinstance(detail, dict) else detail
        safe_detail = str(detail or "Meta tokenı yenilemedi.").replace(access_token, "[TOKEN]")
        raise InstagramApiError(f"Instagram token yenilenemedi: {safe_detail[:300]}")
    new_token = str(payload.get("access_token") or "")
    try:
        expires_in = int(payload.get("expires_in") or 0)
    except (TypeError, ValueError):
        expires_in = 0
    if not new_token or expires_in < 3600:
        raise InstagramApiError("Instagram token yenileme yanıtı eksik veya geçersiz.")
    return new_token, expires_in
