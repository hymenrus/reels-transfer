"""SQLite tabanlı kuyruk: aynı reel'in iki kez paylaşılmasını engeller."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

PENDING = "pending"
DOWNLOADED = "downloaded"
PUBLISHED = "published"
FAILED = "failed"

TERMINAL_STATUSES = (PUBLISHED,)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reels (
    shortcode  TEXT PRIMARY KEY,
    source_url TEXT NOT NULL,
    caption    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL,
    file_path  TEXT,
    media_id   TEXT,
    error      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class ReelJob:
    shortcode: str
    source_url: str
    caption: str
    file_path: str | None


class StateStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "StateStore":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def enqueue(self, shortcode: str, source_url: str, caption: str) -> bool:
        """Yeni kayıt eklenirse True, zaten varsa False döner."""
        now = _now()
        cursor = self._conn.execute(
            "INSERT OR IGNORE INTO reels "
            "(shortcode, source_url, caption, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (shortcode, source_url, caption, PENDING, now, now),
        )
        self._conn.commit()
        return cursor.rowcount == 1

    def pending_jobs(self, limit: int) -> list[ReelJob]:
        """Sıradaki pending/downloaded işleri döner. limit <= 0 ise boş liste."""
        if limit <= 0:
            return []
        rows = self._conn.execute(
            "SELECT shortcode, source_url, caption, file_path FROM reels "
            "WHERE status IN (?, ?) ORDER BY created_at, rowid LIMIT ?",
            (PENDING, DOWNLOADED, limit),
        ).fetchall()
        return [ReelJob(**dict(row)) for row in rows]

    def mark_downloaded(self, shortcode: str, file_path: str) -> None:
        self._update(shortcode, DOWNLOADED, file_path=file_path)

    def mark_published(self, shortcode: str, media_id: str) -> None:
        self._update(shortcode, PUBLISHED, media_id=media_id)

    def mark_failed(self, shortcode: str, error: str) -> None:
        self._update(shortcode, FAILED, error=error[:1000])

    def reset_failed(self) -> int:
        """Başarısız işleri tekrar kuyruğa alır; etkilenen satır sayısını döner."""
        cursor = self._conn.execute(
            "UPDATE reels SET status = ?, error = NULL, updated_at = ? WHERE status = ?",
            (PENDING, _now(), FAILED),
        )
        self._conn.commit()
        return cursor.rowcount

    def summary(self) -> dict[str, int]:
        rows = self._conn.execute(
            "SELECT status, COUNT(*) AS total FROM reels GROUP BY status"
        ).fetchall()
        return {row["status"]: row["total"] for row in rows}

    def failure_details(self, limit: int = 20) -> list[tuple[str, str, str]]:
        """Son başarısız işlerin shortcode, kaynak URL ve hata metnini döner."""
        rows = self._conn.execute(
            "SELECT shortcode, source_url, COALESCE(error, '') AS error "
            "FROM reels WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
            (FAILED, max(0, limit)),
        ).fetchall()
        return [(row["shortcode"], row["source_url"], row["error"]) for row in rows]

    def _update(
        self,
        shortcode: str,
        status: str,
        *,
        file_path: str | None = None,
        media_id: str | None = None,
        error: str | None = None,
    ) -> None:
        self._conn.execute(
            "UPDATE reels SET status = ?, file_path = COALESCE(?, file_path), "
            "media_id = COALESCE(?, media_id), error = ?, updated_at = ? "
            "WHERE shortcode = ?",
            (status, file_path, media_id, error, _now(), shortcode),
        )
        self._conn.commit()
