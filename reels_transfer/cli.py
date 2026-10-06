"""Komut satırı arayüzü: python -m reels_transfer <komut>"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

from .config import ConfigError, Settings, load_settings
from .media import MediaError
from .pipeline import run_once
from .publisher import InstagramApiError, InstagramPublisher
from .sources import load_sources
from .state import StateStore

LOGGER = logging.getLogger("reels_transfer")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="reels_transfer", description="Reel indir ve paylaş")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="Kaynakları kuyruğa ekle ve paylaş")
    run.add_argument("--sources", type=Path, default=Path("sources.txt"))
    run.add_argument("--dry-run", action="store_true", help="İndirme/yayın yapmadan kuyruğu göster")
    run.add_argument(
        "--loop-minutes",
        type=int,
        default=0,
        help="0: tek sefer; N>0: her N dakikada bir tekrarla",
    )

    commands.add_parser("status", help="Kuyruk özetini göster")
    commands.add_parser("retry-failed", help="Başarısız işleri tekrar kuyruğa al")
    commands.add_parser("gui", help="Masaüstü arayüzünü aç")
    return parser


def _publisher(settings: Settings) -> InstagramPublisher:
    return InstagramPublisher(
        settings.access_token,
        settings.ig_user_id,
        settings.graph_version,
        settings.status_poll_seconds,
        settings.status_poll_attempts,
    )


def _run_command(args: argparse.Namespace, settings: Settings, store: StateStore) -> int:
    if not args.sources.exists():
        print(f"Kaynak dosyası bulunamadı: {args.sources}", file=sys.stderr)
        return 2

    publisher = _publisher(settings)
    while True:
        added = load_sources(args.sources, store, settings.default_caption)
        LOGGER.info("%d yeni reel kuyruğa eklendi.", added)

        if args.dry_run:
            pending = store.pending_jobs(settings.max_posts_per_run)
            if not pending:
                print("[DRY-RUN] Kuyrukta bekleyen iş yok.")
            for job in pending:
                print(f"[DRY-RUN] {job.source_url} | açıklama: {job.caption!r}")
            return 0

        try:
            result = run_once(settings, store, publisher)
            LOGGER.info("Tur tamamlandı: %s", result)
            exit_code = 0 if result["failed"] == 0 else 1
        except (InstagramApiError, MediaError) as exc:
            LOGGER.error("Çalıştırma durdu: %s", exc)
            exit_code = 1

        if args.loop_minutes <= 0:
            return exit_code
        LOGGER.info("%d dakika bekleniyor...", args.loop_minutes)
        time.sleep(args.loop_minutes * 60)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.command == "gui":
        from .gui import main as gui_main

        return gui_main()

    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"Yapılandırma hatası: {exc}", file=sys.stderr)
        return 2

    store = StateStore(settings.db_path)
    try:
        if args.command == "status":
            print(store.summary() or "Kuyruk boş.")
            return 0
        if args.command == "retry-failed":
            print(f"{store.reset_failed()} iş tekrar kuyruğa alındı.")
            return 0
        return _run_command(args, settings, store)
    except KeyboardInterrupt:
        return 130
    finally:
        store.close()
