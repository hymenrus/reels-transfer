"""sources.txt dosyasını okuyup kuyruğa ekler."""
from __future__ import annotations

import logging
import re
from urllib.parse import urlsplit
from pathlib import Path

from .state import StateStore

LOGGER = logging.getLogger(__name__)

_SHORTCODE_PATTERN = re.compile(
    r"instagram\.com/(?:[\w.]+/)?(?:reels?|p)/([A-Za-z0-9_-]+)", re.IGNORECASE
)


def extract_shortcode(url: str) -> str:
    """Reel bağlantısından benzersiz kısa kodu çıkarır (tekilleştirme anahtarı)."""
    match = _SHORTCODE_PATTERN.search(url)
    if not match:
        raise ValueError(f"Geçerli bir Instagram reel bağlantısı değil: {url}")
    return match.group(1)


def deduplicate_source_lines(lines: list[str]) -> tuple[list[str], int]:
    """Aynı Reel'i query/son slash farkından bağımsız tutup ilk satırı korur."""
    seen: set[str] = set()
    result: list[str] = []
    removed = 0
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            if line:
                result.append(raw_line)
            continue
        url, separator, caption = line.partition("|")
        url = url.strip()
        try:
            identity = "reel:" + extract_shortcode(url).lower()
        except ValueError:
            parsed = urlsplit(url)
            identity = f"url:{parsed.netloc.lower()}{parsed.path.rstrip('/').lower()}"
        if identity in seen:
            removed += 1
            continue
        seen.add(identity)
        result.append(url + (f" | {caption.strip()}" if separator else ""))
    return result, removed


def load_sources(sources_file: Path, store: StateStore, default_caption: str) -> int:
    """Satır biçimi: 'URL' veya 'URL | açıklama'. Yeni eklenen sayısını döner."""
    added = 0
    for line_number, raw_line in enumerate(
        sources_file.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        url, _, caption = (part.strip() for part in line.partition("|"))
        try:
            shortcode = extract_shortcode(url)
        except ValueError as exc:
            LOGGER.warning("Atlandı (%s:%d): %s", sources_file.name, line_number, exc)
            continue
        caption_text = (caption or default_caption).replace("{source_url}", url)
        if store.enqueue(shortcode, url, caption_text):
            added += 1
    return added
