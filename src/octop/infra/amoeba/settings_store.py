"""Amoeba MCP source configuration in settings + secrets tables."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from octop.infra.crypto.fernet import PURPOSE_SETTINGS, open_secret_bytes, seal_secret_bytes
from octop.infra.db.repos.secrets import SecretRepo
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.errors import ErrorCode, OctopError

_KEY_ENABLED = "amoeba_source_enabled"
_KEY_URL = "amoeba_source_url"
_KEY_SYNC_DAYS = "amoeba_sync_days"
_KEY_AUTO_SYNC = "amoeba_auto_sync"
_KEY_SYNC_SCHEDULE = "amoeba_sync_schedule"
_KEY_ASOF = "amoeba_asof"
_KEY_SOURCE_NAME = "amoeba_source_name"
_KEY_LAST_SYNC = "amoeba_last_sync_at"
_SECRET_TOKEN = "amoeba_source_token"

DEFAULT_SYNC_DAYS = 400
DEFAULT_SYNC_SCHEDULE = "0 3 * * *"


@dataclass(frozen=True)
class AmoebaSourceSettings:
    """Admin-visible source configuration (token value never leaves the store)."""

    enabled: bool
    url: str
    token_set: bool
    sync_days: int
    auto_sync: bool
    sync_schedule: str

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.url and self.token_set)


class AmoebaSourceSettingsStore:
    """Read/write the amoeba MCP source settings."""

    def __init__(self, *, settings_repo: SettingsRepo, secret_repo: SecretRepo) -> None:
        self._settings = settings_repo
        self._secrets = secret_repo

    def load(self) -> AmoebaSourceSettings:
        return AmoebaSourceSettings(
            enabled=(self._settings.get(_KEY_ENABLED) or "").lower() in {"1", "true", "yes"},
            url=(self._settings.get(_KEY_URL) or "").strip(),
            token_set=self._secrets.get(_SECRET_TOKEN) is not None,
            sync_days=_parse_int(self._settings.get(_KEY_SYNC_DAYS), DEFAULT_SYNC_DAYS),
            auto_sync=(self._settings.get(_KEY_AUTO_SYNC) or "").lower() in {"1", "true", "yes"},
            sync_schedule=(self._settings.get(_KEY_SYNC_SCHEDULE) or "").strip()
            or DEFAULT_SYNC_SCHEDULE,
        )

    def save(
        self,
        *,
        enabled: bool,
        url: str,
        token: str | None = None,
        sync_days: int | None = None,
        auto_sync: bool | None = None,
        sync_schedule: str | None = None,
    ) -> AmoebaSourceSettings:
        url = url.strip()
        if enabled and not url:
            raise OctopError(ErrorCode.SLASH_BAD_ARGS, "url is required when the source is enabled")
        if enabled and not (token or self._secrets.get(_SECRET_TOKEN) is not None):
            raise OctopError(
                ErrorCode.SLASH_BAD_ARGS, "token is required when the source is enabled"
            )
        self._settings.set(_KEY_ENABLED, "true" if enabled else "false")
        self._settings.set(_KEY_URL, url)
        if sync_days is not None:
            self._settings.set(_KEY_SYNC_DAYS, str(max(1, int(sync_days))))
        if auto_sync is not None:
            self._settings.set(_KEY_AUTO_SYNC, "true" if auto_sync else "false")
        if sync_schedule is not None and sync_schedule.strip():
            self._settings.set(_KEY_SYNC_SCHEDULE, sync_schedule.strip())
        if token:
            encoded = seal_secret_bytes(self._secrets, PURPOSE_SETTINGS, token.encode("utf-8"))
            existing = self._secrets.get(_SECRET_TOKEN)
            if existing is not None:
                self._secrets.rotate(_SECRET_TOKEN, encoded)
            else:
                self._secrets.get_or_create(_SECRET_TOKEN, lambda: encoded)
        return self.load()

    def read_token(self) -> str | None:
        raw = self._secrets.get(_SECRET_TOKEN)
        if raw is None:
            return None
        return open_secret_bytes(self._secrets, PURPOSE_SETTINGS, raw).decode("utf-8")

    def record_sync(self, *, asof: str, source_name: str = "") -> None:
        import time

        self._settings.set(_KEY_ASOF, asof)
        self._settings.set(_KEY_SOURCE_NAME, source_name)
        self._settings.set(_KEY_LAST_SYNC, str(int(time.time())))

    def status(self) -> dict[str, Any]:
        import time

        last = _parse_int(self._settings.get(_KEY_LAST_SYNC), 0)
        return {
            "asof": self._settings.get(_KEY_ASOF) or "",
            "source_name": self._settings.get(_KEY_SOURCE_NAME) or "",
            "last_sync_at": last or None,
            "last_sync_at_age_s": max(0, int(time.time()) - last) if last else None,
        }


def _parse_int(raw: str | None, default: int) -> int:
    try:
        return int(raw) if raw else default
    except (TypeError, ValueError):
        return default


__all__ = ["AmoebaSourceSettings", "AmoebaSourceSettingsStore"]
