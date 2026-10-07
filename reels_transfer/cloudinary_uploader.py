"""Cloudinary unsigned video upload yardımcısı.

Cloud Name + unsigned Upload Preset yeterlidir; API secret istemez.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import requests
from requests_toolbelt.multipart.encoder import MultipartEncoder, MultipartEncoderMonitor


class CloudinaryUploadError(RuntimeError):
    """Cloudinary yükleme hatası."""


class CloudinaryUploader:
    def __init__(self, cloud_name: str, upload_preset: str, session: requests.Session | None = None) -> None:
        self.cloud_name = cloud_name.strip()
        self.upload_preset = upload_preset.strip()
        self.session = session or requests.Session()

    def upload_video(
        self,
        video_path: Path,
        progress_callback: Callable[[int], None] | None = None,
    ) -> str:
        if not self.cloud_name or not self.upload_preset:
            raise CloudinaryUploadError(
                "CLOUDINARY_CLOUD_NAME ve CLOUDINARY_UPLOAD_PRESET .env içinde doldurulmalı."
            )
        if not video_path.exists():
            raise CloudinaryUploadError(f"Video dosyası bulunamadı: {video_path.name}")
        endpoint = f"https://api.cloudinary.com/v1_1/{self.cloud_name}/video/upload"
        try:
            with video_path.open("rb") as handle:
                encoder = MultipartEncoder(fields={
                    "upload_preset": self.upload_preset,
                    "resource_type": "video",
                    "file": (video_path.name, handle, "video/mp4"),
                })

                def report_progress(monitor: MultipartEncoderMonitor) -> None:
                    if progress_callback and monitor.len:
                        percent = min(100, int(monitor.bytes_read * 100 / monitor.len))
                        progress_callback(percent)

                monitor = MultipartEncoderMonitor(encoder, report_progress if progress_callback else None)
                response = self.session.post(
                    endpoint,
                    data=monitor,
                    headers={"Content-Type": monitor.content_type},
                    timeout=(15, 900),
                )
            payload = response.json()
        except (OSError, requests.RequestException, ValueError) as exc:
            raise CloudinaryUploadError(f"Cloudinary ağ/yükleme hatası: {type(exc).__name__}") from exc
        if not response.ok or not payload.get("secure_url"):
            message = (payload.get("error") or {}).get("message", "bilinmeyen hata")
            raise CloudinaryUploadError(f"Cloudinary yüklemesi başarısız: {message}")
        url = str(payload["secure_url"])
        if not url.startswith("https://"):
            raise CloudinaryUploadError("Cloudinary güvenli HTTPS URL döndürmedi.")
        return url
