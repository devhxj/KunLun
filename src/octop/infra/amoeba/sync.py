"""Sync engine: pull leaf-unit facts from the MCP source into local cache.

Unit alignment maps each source ``unit_key`` onto a ``departments`` row: an
existing binding stored in the department profile (``amoeba_unit_key`` in
``details_json``) wins, then a unique name match, otherwise the department is
created under its mapped parent — so board data scope and the departments tree
stay one and the same.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, timedelta
from typing import Any

from octop.infra.amoeba import source
from octop.infra.amoeba.settings_store import AmoebaSourceSettingsStore
from octop.infra.db.services import SharedServices
from octop.infra.errors import ErrorCode, OctopError

logger = logging.getLogger(__name__)

_UNIT_KEY_FIELD = "amoeba_unit_key"
_SYNC_JOB_ID = "amoeba_daily_sync"


async def run_sync(*, services: SharedServices, store: AmoebaSourceSettingsStore) -> dict[str, Any]:
    """Pull units, snapshots and budgets from the configured MCP source."""
    loop = asyncio.get_running_loop()
    settings = await loop.run_in_executor(None, store.load)
    if not settings.configured:
        raise OctopError(ErrorCode.AMOEBA_SOURCE_NOT_CONFIGURED, "amoeba source is not configured")
    token = await loop.run_in_executor(None, store.read_token)
    assert token is not None  # configured() guarantees a stored token

    units = await source.fetch_units(settings.url, token)
    mapping = await loop.run_in_executor(None, _align_departments, services, units)

    metric_keys = await loop.run_in_executor(None, _raw_metric_keys, services)
    date_to = date.today()
    date_from = date_to - timedelta(days=settings.sync_days)
    rows = await source.fetch_metrics_data(
        settings.url,
        token,
        unit_keys=list(mapping),
        metric_keys=metric_keys,
        date_from=date_from.isoformat(),
        date_to=date_to.isoformat(),
    )
    snap_rows: list[tuple[str, str, str, float]] = []
    skipped = 0
    for row in rows:
        dept = mapping.get(str(row.get("unit_key", "")))
        stat_date = str(row.get("date", ""))
        key = str(row.get("metric_key", ""))
        value = row.get("value")
        if dept is None or not stat_date or not key or not isinstance(value, (int, float)):
            skipped += 1
            continue
        snap_rows.append((dept, stat_date, key, float(value)))
    amoeba_repo = services.repos.amoeba_repo
    written = await loop.run_in_executor(None, amoeba_repo.upsert_snapshots, snap_rows)

    periods = [date_to.strftime("%Y-%m"), date_to.strftime("%Y")]
    budget_rows_raw = await source.fetch_budgets(
        settings.url, token, unit_keys=list(mapping), metric_keys=metric_keys, periods=periods
    )
    budget_rows: list[tuple[str, str, str, float]] = []
    for row in budget_rows_raw:
        dept = mapping.get(str(row.get("unit_key", "")))
        period = str(row.get("period", ""))
        key = str(row.get("metric_key", ""))
        value = row.get("value")
        if dept is None or not period or not key or not isinstance(value, (int, float)):
            skipped += 1
            continue
        budget_rows.append((dept, period, key, float(value)))
    budgets_written = await loop.run_in_executor(None, amoeba_repo.upsert_budgets, budget_rows)

    meta = await source.fetch_meta(settings.url, token)
    asof = ""
    if isinstance(meta, dict) and meta.get("asof"):
        asof = str(meta["asof"])
    if not asof:
        latest = await loop.run_in_executor(None, amoeba_repo.latest_snapshot_date)
        asof = latest or date_to.isoformat()
    await loop.run_in_executor(None, lambda: store.record_sync(asof=asof))
    return {
        "units": len(mapping),
        "snapshot_rows": written,
        "budget_rows": budgets_written,
        "skipped_rows": skipped,
        "asof": asof,
    }


def _raw_metric_keys(services: SharedServices) -> list[str]:
    metrics = services.repos.amoeba_repo.list_metrics()
    return [m.metric_key for m in metrics if not m.formula and m.enabled]


def _align_departments(services: SharedServices, units: list[dict[str, Any]]) -> dict[str, str]:
    """Map source ``unit_key`` → department_id, creating departments as needed."""
    dept_repo = services.repos.department_repo
    existing = dept_repo.list_all()
    by_unit_key: dict[str, str] = {}
    by_name: dict[str, str] = {}
    bound_departments: set[str] = set()
    for row in existing:
        profile = dept_repo.get_profile(row.department_id)
        details: dict[str, Any] = {}
        if profile:
            try:
                loaded = json.loads(profile[1].details_json or "{}")
                if isinstance(loaded, dict):
                    details = loaded
            except json.JSONDecodeError:
                details = {}
        unit_key = details.get(_UNIT_KEY_FIELD)
        if isinstance(unit_key, str) and unit_key:
            by_unit_key[unit_key] = row.department_id
            bound_departments.add(row.department_id)
        by_name.setdefault(row.name, row.department_id)

    mapping: dict[str, str] = {}
    remaining = [u for u in units if isinstance(u, dict)]
    while remaining:
        progressed = False
        deferred: list[dict[str, Any]] = []
        for unit in remaining:
            unit_key = unit.get("unit_key")
            name = unit.get("name")
            parent_key = unit.get("parent_key")
            if (
                not isinstance(unit_key, str)
                or not unit_key
                or not isinstance(name, str)
                or not name
            ):
                continue
            if unit_key in mapping:
                progressed = True
                continue
            if unit_key in by_unit_key:
                mapping[unit_key] = by_unit_key[unit_key]
                progressed = True
                continue
            candidate = by_name.get(name)
            if candidate is not None and candidate not in bound_departments:
                mapping[unit_key] = candidate
                by_unit_key[unit_key] = candidate
                bound_departments.add(candidate)
                _save_unit_key(dept_repo, candidate, name, unit_key)
                progressed = True
                continue
            parent_id: str | None = None
            if parent_key:
                parent_id = mapping.get(parent_key) or by_unit_key.get(parent_key)
                if parent_id is None:
                    deferred.append(unit)
                    continue
            created = dept_repo.create(name, parent_id)
            if created is None:
                continue
            mapping[unit_key] = created.department_id
            by_unit_key[unit_key] = created.department_id
            bound_departments.add(created.department_id)
            _save_unit_key(dept_repo, created.department_id, name, unit_key)
            progressed = True
        remaining = deferred
        if not progressed:
            break
    return mapping


def _save_unit_key(dept_repo: Any, department_id: str, name: str, unit_key: str) -> None:
    profile = dept_repo.get_profile(department_id)
    details: dict[str, Any] = {}
    sort_order: int | None = None
    if profile:
        sort_order = profile[1].sort_order
        try:
            loaded = json.loads(profile[1].details_json or "{}")
            if isinstance(loaded, dict):
                details = loaded
        except json.JSONDecodeError:
            details = {}
    details[_UNIT_KEY_FIELD] = unit_key
    dept_repo.save_profile(department_id, name, sort_order, json.dumps(details, ensure_ascii=False))


async def _amoeba_daily_sync(server: Any) -> None:
    try:
        services = server.services
        assert services is not None
        store = AmoebaSourceSettingsStore(
            settings_repo=services.repos.settings_repo, secret_repo=services.repos.secret_repo
        )
        result = await run_sync(services=services, store=store)
        logger.info("amoeba daily sync done: %s", result)
    except Exception:
        logger.warning("amoeba daily sync failed", exc_info=True)


def install_amoeba_sync_job(cron_mgr: Any, server: Any) -> None:
    """Register the daily sync system job when the source asks for it."""
    services = server.services
    if services is None:
        return
    store = AmoebaSourceSettingsStore(
        settings_repo=services.repos.settings_repo, secret_repo=services.repos.secret_repo
    )
    settings = store.load()
    if not (settings.configured and settings.auto_sync):
        return
    trigger = f"cron:{settings.sync_schedule}"
    cron_mgr.schedule_system_job(
        _SYNC_JOB_ID, trigger=trigger, func=lambda: _amoeba_daily_sync(server)
    )
    logger.info("amoeba auto sync installed: %s", trigger)


__all__ = ["install_amoeba_sync_job", "run_sync"]
