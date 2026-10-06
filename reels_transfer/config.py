"""Ortam değişkenlerinden ayarları okur ve doğrular."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


class ConfigError(RuntimeError):
    """Eksik veya hatalı yapılandırma."""


@dataclass(frozen=True)
class Settings:
    access_token: str
    ig_user_id: str
    graph_version: str
    data_dir: Path
    max_posts_per_run: int
    default_caption: str
    cookies_file: Path | None
    status_poll_seconds: int
    status_poll_attempts: int
    api_mode: str = "instagram_login"
    public_upload_mode: str = "cloudinary"
    cloudinary_cloud_name: str = ""
    cloudinary_upload_preset: str = ""

    @property
    def db_path(self) -> Path:
        return self.data_dir / "state.sqlite3"

    @property
    def download_dir(self) -> Path:
        return self.data_dir / "downloads"


def _require(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(f"{name} .env dosyasında tanımlı olmalı.")
    return value


def _positive_int(name: str, default: str, minimum: int = 0) -> int:
    raw = os.getenv(name, default).strip() or default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} sayısal olmalı (verilen: {raw!r}).") from exc
    if value < minimum:
        raise ConfigError(f"{name} en az {minimum} olmalı (verilen: {value}).")
    return value


def load_settings(
    env_file: str | Path | None = None,
    *,
    require_account_credentials: bool = True,
) -> Settings:
    """Ayarları okur; bulut worker'ı IG token/ID'sini kişi bazında sağlayabilir."""
    load_dotenv(env_file) if env_file is not None else load_dotenv()

    if os.getenv("CONTENT_RIGHTS_CONFIRMED", "").strip().lower() != "true":
        raise ConfigError(
            "Yalnızca hakkına sahip olduğun veya izin aldığın içerikleri işleyebilirsin. "
            "Bunu onaylıyorsan .env içinde CONTENT_RIGHTS_CONFIRMED=true yap."
        )

    cookies = os.getenv("COOKIES_FILE", "").strip()
    cookies_path = Path(cookies) if cookies else None
    if cookies_path is not None and not cookies_path.exists():
        raise ConfigError(f"COOKIES_FILE bulunamadı: {cookies_path}")

    api_mode = os.getenv("IG_API_MODE", "instagram_login").strip().lower()
    if api_mode not in {"instagram_login", "facebook_login"}:
        raise ConfigError("IG_API_MODE instagram_login veya facebook_login olmalı.")

    public_upload_mode = os.getenv("PUBLIC_UPLOAD_MODE", "tmpfiles").strip().lower()
    if public_upload_mode not in {"cloudinary", "catbox", "tmpfiles", "none"}:
        raise ConfigError("PUBLIC_UPLOAD_MODE cloudinary, catbox, tmpfiles veya none olmalı.")

    return Settings(
        access_token=_require("IG_ACCESS_TOKEN") if require_account_credentials else os.getenv("IG_ACCESS_TOKEN", "").strip(),
        ig_user_id=_require("IG_USER_ID") if require_account_credentials else os.getenv("IG_USER_ID", "").strip(),
        graph_version=os.getenv("GRAPH_API_VERSION", "v26.0").strip() or "v26.0",
        api_mode=api_mode,
        public_upload_mode=public_upload_mode,
        data_dir=Path(os.getenv("DATA_DIR", "./data").strip() or "./data"),
        max_posts_per_run=_positive_int("MAX_POSTS_PER_RUN", "3", minimum=0),
        default_caption=os.getenv("DEFAULT_CAPTION", "").strip(),
        cookies_file=cookies_path,
        status_poll_seconds=_positive_int("STATUS_POLL_SECONDS", "60", minimum=1),
        status_poll_attempts=_positive_int("STATUS_POLL_ATTEMPTS", "5", minimum=1),
        cloudinary_cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME", "").strip(),
        cloudinary_upload_preset=os.getenv("CLOUDINARY_UPLOAD_PRESET", "").strip(),
    )
