from pathlib import Path

import pytest

from reels_transfer.config import ConfigError, load_settings

BASE_ENV = {
    "IG_ACCESS_TOKEN": "token",
    "IG_USER_ID": "123",
    "CONTENT_RIGHTS_CONFIRMED": "true",
    "MAX_POSTS_PER_RUN": "3",
    "STATUS_POLL_SECONDS": "5",
    "STATUS_POLL_ATTEMPTS": "2",
    "DATA_DIR": "./data",
}


def clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(BASE_ENV) + ["GRAPH_API_VERSION", "DEFAULT_CAPTION", "COOKIES_FILE"]:
        monkeypatch.delenv(key, raising=False)


def set_env(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    clear_env(monkeypatch)
    for key, value in {**BASE_ENV, **overrides}.items():
        monkeypatch.setenv(key, value)


def test_loads_defaults(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch)
    settings = load_settings(env_file=tmp_path / "yok.env")

    assert settings.graph_version == "v26.0"
    assert settings.max_posts_per_run == 3
    assert settings.cookies_file is None
    assert settings.db_path == Path("./data/state.sqlite3")


def test_requires_rights_confirmation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, CONTENT_RIGHTS_CONFIRMED="false")
    with pytest.raises(ConfigError, match="hakkına sahip"):
        load_settings(env_file=tmp_path / "yok.env")


def test_requires_credentials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, IG_ACCESS_TOKEN="")
    with pytest.raises(ConfigError, match="IG_ACCESS_TOKEN"):
        load_settings(env_file=tmp_path / "yok.env")


def test_rejects_non_numeric_setting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, MAX_POSTS_PER_RUN="üç")
    with pytest.raises(ConfigError, match="MAX_POSTS_PER_RUN"):
        load_settings(env_file=tmp_path / "yok.env")


def test_rejects_missing_cookies_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_env(monkeypatch, COOKIES_FILE=str(tmp_path / "yok.txt"))
    with pytest.raises(ConfigError, match="COOKIES_FILE"):
        load_settings(env_file=tmp_path / "yok.env")


def test_accepts_existing_cookies_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
    set_env(monkeypatch, COOKIES_FILE=str(cookies))
    settings = load_settings(env_file=tmp_path / "yok.env")
    assert settings.cookies_file == cookies
