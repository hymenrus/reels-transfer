"""İndirilen videoyu Instagram Reels'in beklediği biçime hazırlar (ffmpeg).

Not: Bu modül gönderilen dosyalar arasında yoktu; `pipeline.py` onu import ettiği
için ffmpeg tabanlı olarak eklendi.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REQUIRED_TOOLS = ("ffmpeg", "ffprobe")
TARGET_WIDTH = 1080
TARGET_HEIGHT = 1920
MAX_DURATION_SECONDS = 15 * 60  # Reels üst sınırı: 15 dakika
FALLBACK_SILENT_AUDIO = "anullsrc=channel_layout=stereo:sample_rate=44100"


class MediaError(RuntimeError):
    """Medya inceleme/dönüştürme hatası."""


def ensure_tools_available() -> None:
    """ffmpeg/ffprobe kurulu mu? Değilse anlaşılır bir hata verir."""
    missing = [tool for tool in REQUIRED_TOOLS if shutil.which(tool) is None]
    if missing:
        raise MediaError(
            "Eksik araç(lar): "
            + ", ".join(missing)
            + ". Kurulum: macOS 'brew install ffmpeg', Ubuntu 'sudo apt install ffmpeg', "
            "Windows 'winget install ffmpeg'."
        )


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, capture_output=True, text=True, check=True)
    except FileNotFoundError as exc:  # ffmpeg/ffprobe yok
        raise MediaError(f"Araç bulunamadı: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip().splitlines()
        tail = " | ".join(detail[-3:]) if detail else "bilinmeyen hata"
        raise MediaError(f"ffmpeg hata verdi: {tail}") from exc


def probe(path: Path) -> dict:
    """ffprobe ile akış bilgisini döner."""
    result = _run(
        [
            "ffprobe", "-v", "error",
            "-print_format", "json",
            "-show_format", "-show_streams",
            str(path),
        ]
    )
    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise MediaError("ffprobe çıktısı okunamadı.") from exc


def _has_audio(info: dict) -> bool:
    return any(stream.get("codec_type") == "audio" for stream in info.get("streams", []))


def _duration(info: dict) -> float:
    try:
        return float(info.get("format", {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def prepare_for_reels(source_file: Path, output_dir: Path) -> Path:
    """Videoyu 1080x1920 (boşluklara siyah dolgu), H.264 + AAC mp4 olarak yeniden kodlar."""
    if not source_file.exists():
        raise MediaError(f"Kaynak dosya yok: {source_file}")

    ensure_tools_available()
    info = probe(source_file)
    duration = _duration(info)
    if duration and duration > MAX_DURATION_SECONDS:
        raise MediaError(
            f"Video çok uzun: {duration:.0f} sn (üst sınır {MAX_DURATION_SECONDS} sn)."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / f"{source_file.stem}_reel.mp4"

    scale_filter = (
        f"scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=decrease:"
        "force_divisible_by=2,"
        f"pad={TARGET_WIDTH}:{TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,"
        "setsar=1"
    )

    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(source_file)]
    if _has_audio(info):
        command += ["-map", "0:v:0", "-map", "0:a:0"]
    else:
        # Sessiz videolarda Instagram için boş bir ses kanalı ekle.
        command += ["-f", "lavfi", "-i", FALLBACK_SILENT_AUDIO, "-map", "0:v:0", "-map", "1:a:0"]
    command += [
        "-vf", scale_filter,
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level", "4.1",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-movflags", "+faststart",
        "-shortest",
        str(target),
    ]
    _run(command)

    if not target.exists() or target.stat().st_size == 0:
        raise MediaError(f"Dönüştürme çıktısı üretilemedi: {target}")
    return target