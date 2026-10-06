#!/usr/bin/env bash
# Kurulum + çalıştırma: tüm adımlar tek komutta.
set -euo pipefail
cd "$(dirname "$0")"

# 1) ffmpeg (macOS: brew install ffmpeg | Ubuntu: sudo apt install ffmpeg | Windows: winget install ffmpeg)
command -v ffmpeg >/dev/null 2>&1 || echo "UYARI: ffmpeg bulunamadı, kur: sudo apt install ffmpeg"

# 2) Sanal ortam ve bağımlılıklar
python -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

# 3) .env yoksa örnekten oluştur
[ -f .env ] || cp .env.example .env

echo "--- 1) Önce deneme: hiçbir şey indirmez/yayınlamaz, sadece kuyruğu gösterir"
python -m reels_transfer run --dry-run

echo "--- 2) Tek sefer çalıştır (MAX_POSTS_PER_RUN kadar paylaşır)"
python -m reels_transfer run

echo "--- 3) Kuyruk durumu"
python -m reels_transfer status