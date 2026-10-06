"""yt-dlp ile tek bir reel'i indirir."""
from __future__ import annotations

from pathlib import Path

import yt_dlp


class DownloadError(RuntimeError):
    """Reel indirilemedi."""


def download_reel(
    url: str, shortcode: str, download_dir: Path, cookies_file: Path | None = None
) -> Path:
    download_dir.mkdir(parents=True, exist_ok=True)
    options: dict[str, object] = {
        "outtmpl": str(download_dir / f"{shortcode}.%(ext)s"),
        "format": "bv*+ba/b",          # ayrı video+ses akışı varsa ffmpeg birleştirir
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
        "overwrites": True,
    }
    if cookies_file:
        options["cookiefile"] = str(cookies_file)

    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        raise DownloadError(f"İndirme başarısız ({url}): {exc}") from exc

    downloads = (info or {}).get("requested_downloads") or []
    filepath = downloads[0].get("filepath") if downloads else None
    if not filepath or not Path(filepath).exists():
        raise DownloadError(f"İndirilen dosya bulunamadı: {url}")
    return Path(filepath)