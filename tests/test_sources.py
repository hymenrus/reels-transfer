from pathlib import Path

import pytest

from reels_transfer.sources import deduplicate_source_lines, extract_shortcode, load_sources
from reels_transfer.state import StateStore


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://www.instagram.com/reel/Cxyz123-/_/", "Cxyz123-"),
        ("https://instagram.com/reels/AbC_9/", "AbC_9"),
        ("https://www.instagram.com/username/p/DEF456/", "DEF456"),
    ],
)
def test_extract_shortcode(url: str, expected: str) -> None:
    assert extract_shortcode(url) == expected


def test_extract_shortcode_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        extract_shortcode("https://example.com/video/1")


def test_load_sources_skips_comments_and_duplicates(tmp_path: Path) -> None:
    sources = tmp_path / "sources.txt"
    sources.write_text(
        "\n".join(
            [
                "# yorum",
                "",
                "https://www.instagram.com/reel/AAA/ | Kendi açıklamam",
                "https://www.instagram.com/reel/AAA/ | tekrar",
                "https://www.instagram.com/reel/BBB/",
                "https://example.com/gecersiz",
            ]
        ),
        encoding="utf-8",
    )
    store = StateStore(tmp_path / "state.sqlite3")
    added = load_sources(sources, store, default_caption="Varsayılan {source_url}")

    assert added == 2
    jobs = {job.shortcode: job.caption for job in store.pending_jobs(10)}
    assert jobs["AAA"] == "Kendi açıklamam"
    assert jobs["BBB"] == "Varsayılan https://www.instagram.com/reel/BBB/"
    store.close()


def test_deduplicate_source_lines_uses_shortcode_not_query_string() -> None:
    lines = [
        "https://www.instagram.com/reel/ABC/?igsh=first | ilk açıklama",
        "https://instagram.com/reels/ABC?igsh=second | tekrarlanan açıklama",
    ]
    unique, removed = deduplicate_source_lines(lines)
    assert removed == 1
    assert unique == ["https://www.instagram.com/reel/ABC/?igsh=first | ilk açıklama"]


def test_load_sources_does_not_requeue_previously_published_reel(tmp_path: Path) -> None:
    sources = tmp_path / "sources.txt"
    sources.write_text("https://www.instagram.com/reel/AAA/?again=1\n", encoding="utf-8")
    store = StateStore(tmp_path / "state.sqlite3")
    store.enqueue("AAA", "https://www.instagram.com/reel/AAA/", "ilk")
    store.mark_published("AAA", "media-1")
    assert load_sources(sources, store, "") == 0
    assert store.summary() == {"published": 1}
    store.close()
