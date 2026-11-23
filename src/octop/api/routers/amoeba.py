"""Amoeba board API: board reads, AI summary, source config, sync and admin."""

from __future__ import annotations

import asyncio
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from octop.api.deps import current_user, get_server, require_admin, require_permission
from octop.infra.amoeba import source as amoeba_source
from octop.infra.amoeba import sync as amoeba_sync
from octop.infra.amoeba.aggregate import (
    build_leaf_wall,
    build_metric_detail,
    build_overview,
    resolve_asof,
)
from octop.infra.amoeba.builtin_metrics import ensure_builtin_metrics
from octop.infra.amoeba.formula import FormulaError, formula_dependencies
from octop.infra.amoeba.insights import build_insights
from octop.infra.amoeba.settings_store import (
    DEFAULT_SYNC_DAYS,
    DEFAULT_SYNC_SCHEDULE,
    AmoebaSourceSettingsStore,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.locale import resolve_request_locale

router = APIRouter()


def _run(fn: Any, /, *args: Any, **kwargs: Any) -> Any:
    loop = asyncio.get_running_loop()
    if kwargs:
        return loop.run_in_executor(None, lambda: fn(*args, **kwargs))
    return loop.run_in_executor(None, fn, *args)


def _store(server: Any) -> AmoebaSourceSettingsStore:
    services = server.services
    return AmoebaSourceSettingsStore(
        settings_repo=services.repos.settings_repo, secret_repo=services.repos.secret_repo
    )


def _repo(server: Any) -> Any:
    return server.services.repos.amoeba_repo


def _dept_repo(server: Any) -> Any:
    return server.services.repos.department_repo


def _ensure_catalog(server: Any) -> None:
    repo = _repo(server)
    if not repo.list_metrics():
        ensure_builtin_metrics(repo)


def _visible_ids(user: Any, repo: Any) -> list[str] | None:
    """Departments the user may see; None means unrestricted (admin)."""
    if user.is_admin:
        return None
    bound = repo.user_department_ids(int(user.id))
    if not bound:
        return []
    ids: list[str] = repo.subtree_ids(bound)
    return ids


def _scope_ids(*, user: Any, repo: Any, dept: str | None, departments: list[Any]) -> list[str]:
    """Resolve the board scope: a department subtree clamped to the user's visibility."""
    visible = _visible_ids(user, repo)
    if dept:
        known = {d.department_id for d in departments}
        if dept not in known:
            raise OctopError(ErrorCode.NOT_FOUND, "department not found")
        if visible is not None and dept not in visible:
            raise OctopError(ErrorCode.FORBIDDEN, "department out of scope")
        scope = repo.subtree_ids([dept])
        return scope if visible is None else [d for d in scope if d in set(visible)]
    return visible if visible is not None else [d.department_id for d in departments]


def _soft_host_models(server: Any) -> Any:
    runtime = getattr(server, "app_runtime", None)
    registry = getattr(runtime, "agent_registry", None)
    return getattr(registry, "host_models", None)


# ---- board reads ---------------------------------------------------------


@router.get("/tree", summary="List departments visible to the board")
async def get_tree(
    user: Any = Depends(current_user),
    _: Any = Depends(require_permission("amoeba")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    departments = await _run(_dept_repo(server).list_all)
    visible = await _run(_visible_ids, user, repo)
    allowed = (
        departments
        if visible is None
        else [d for d in departments if d.department_id in set(visible)]
    )
    return {
        "departments": [
            {"department_id": d.department_id, "parent_id": d.parent_id, "name": d.name}
            for d in allowed
        ],
        "restricted": visible is not None,
    }


@router.get(
    "/overview",
    summary="Board payload for one department scope",
    description="Rolled-up KPI cards for the department subtree; `dept` omitted means the user's whole visible scope.",
)
async def get_overview(
    dept: str | None = Query(default=None, description="Department id to drill into"),
    dim: Literal["d", "m", "y"] = Query(default="d"),
    user: Any = Depends(current_user),
    _: Any = Depends(require_permission("amoeba")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    await _run(_ensure_catalog, server)
    departments = await _run(_dept_repo(server).list_all)
    scope = await _run(_scope_ids, user=user, repo=repo, dept=dept, departments=departments)
    if not scope:
        return {"asof": None, "dim": dim, "period_days": 0, "groups": [], "metrics": {}}
    metrics = await _run(repo.list_metrics)
    asof = await _run(resolve_asof, repo)
    if asof is None:
        return {"asof": None, "dim": dim, "period_days": 0, "groups": [], "metrics": {}}
    overview = await _run(
        build_overview, repo, department_ids=scope, metrics=metrics, asof=asof, dim=dim
    )
    return cast(dict[str, Any], overview)


@router.get(
    "/metrics/{metric_key}",
    summary="Metric drawer payload",
    description="Per-metric dims, comparisons, 30-day trend and per-leaf ranking inside the scope.",
)
async def get_metric_detail(
    metric_key: str,
    dept: str | None = Query(default=None),
    dim: Literal["d", "m", "y"] = Query(default="d"),
    user: Any = Depends(current_user),
    _: Any = Depends(require_permission("amoeba")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    departments = await _run(_dept_repo(server).list_all)
    scope = await _run(_scope_ids, user=user, repo=repo, dept=dept, departments=departments)
    if not scope:
        raise OctopError(ErrorCode.NOT_FOUND, "no data in scope")
    metrics = await _run(repo.list_metrics)
    asof = await _run(resolve_asof, repo)
    if asof is None:
        raise OctopError(ErrorCode.NOT_FOUND, "no data in scope")
    detail = await _run(
        build_metric_detail,
        repo,
        department_ids=scope,
        departments=departments,
        metrics=metrics,
        metric_key=metric_key,
        asof=asof,
        dim=dim,
    )
    if detail is None:
        raise OctopError(ErrorCode.NOT_FOUND, "metric not found")
    return cast(dict[str, Any], detail)


@router.get("/summary", summary="AI summary lines for the board (rule fallback)")
async def get_summary(
    request: Request,
    dept: str | None = Query(default=None),
    dim: Literal["d", "m", "y"] = Query(default="d"),
    user: Any = Depends(current_user),
    _: Any = Depends(require_permission("amoeba")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    departments = await _run(_dept_repo(server).list_all)
    scope = await _run(_scope_ids, user=user, repo=repo, dept=dept, departments=departments)
    if not scope:
        return {"lead": "", "items": []}
    metrics = await _run(repo.list_metrics)
    asof = await _run(resolve_asof, repo)
    if asof is None:
        return {"lead": "", "items": []}
    overview = await _run(
        build_overview, repo, department_ids=scope, metrics=metrics, asof=asof, dim=dim
    )
    names = {d.department_id: d.name for d in departments if d.department_id in set(scope)}
    org_name = names.get(dept or "", next(iter(names), "") if names else "")
    locale = resolve_request_locale(request)
    narrative = await build_insights(
        overview=overview,
        locale=locale,
        org_name=org_name,
        models=_soft_host_models(server),
    )
    return narrative


@router.get(
    "/leaves",
    summary="Leaf-unit comparison wall for one metric",
    description="Value, delta and share per leaf department in scope — the peer-comparison view.",
)
async def get_leaves(
    metric: str = Query(default="oil"),
    dept: str | None = Query(default=None),
    dim: Literal["d", "m", "y"] = Query(default="d"),
    user: Any = Depends(current_user),
    _: Any = Depends(require_permission("amoeba")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    await _run(_ensure_catalog, server)
    metrics = await _run(repo.list_metrics)
    if not any(m.metric_key == metric for m in metrics):
        raise OctopError(ErrorCode.NOT_FOUND, "metric not found")
    departments = await _run(_dept_repo(server).list_all)
    scope = await _run(_scope_ids, user=user, repo=repo, dept=dept, departments=departments)
    if not scope:
        return {"rows": []}
    asof = await _run(resolve_asof, repo)
    if asof is None:
        return {"rows": []}
    rows = await _run(
        build_leaf_wall,
        repo,
        department_ids=scope,
        departments=departments,
        metrics=metrics,
        metric_key=metric,
        asof=asof,
        dim=dim,
    )
    if rows is None:
        raise OctopError(ErrorCode.NOT_FOUND, "metric not found")
    return {"rows": rows}


@router.get("/status", summary="Board data freshness and source state")
async def get_status(
    _: Any = Depends(require_permission("amoeba")),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    status = await _run(store.status)
    settings = await _run(store.load)
    return {**status, "source_configured": settings.configured}


# ---- source config & sync (admin) ---------------------------------------


class AmoebaSourceResponse(BaseModel):
    enabled: bool
    url: str
    token_set: bool
    configured: bool
    sync_days: int
    auto_sync: bool
    sync_schedule: str


class AmoebaSourceBody(BaseModel):
    enabled: bool = False
    url: str = Field(default="", description="MCP source base URL (streamable HTTP)")
    token: str | None = Field(default=None, description="Bearer token; omit to keep")
    sync_days: int = Field(
        default=DEFAULT_SYNC_DAYS, ge=1, le=3650, description="History window to pull"
    )
    auto_sync: bool = Field(default=True, description="Install the daily sync job")
    sync_schedule: str = Field(
        default=DEFAULT_SYNC_SCHEDULE, description="Cron expression, e.g. '0 3 * * *'"
    )


def _source_response(cfg: Any) -> AmoebaSourceResponse:
    return AmoebaSourceResponse(
        enabled=cfg.enabled,
        url=cfg.url,
        token_set=cfg.token_set,
        configured=cfg.configured,
        sync_days=cfg.sync_days,
        auto_sync=cfg.auto_sync,
        sync_schedule=cfg.sync_schedule,
    )


@router.get("/source", summary="Get the amoeba MCP source config")
async def get_source(
    _: Any = Depends(require_admin()), server: Any = Depends(get_server)
) -> AmoebaSourceResponse:
    return _source_response(await _run(_store(server).load))


@router.put("/source", summary="Update the amoeba MCP source config")
async def put_source(
    body: AmoebaSourceBody,
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> AmoebaSourceResponse:
    cfg = await _run(
        lambda: _store(server).save(
            enabled=body.enabled,
            url=body.url,
            token=body.token,
            sync_days=body.sync_days,
            auto_sync=body.auto_sync,
            sync_schedule=body.sync_schedule,
        )
    )
    return _source_response(cfg)


class AmoebaSourceTestBody(BaseModel):
    url: str | None = None
    token: str | None = None


@router.post("/source/test", summary="Probe the MCP source and its tools")
async def test_source(
    body: AmoebaSourceTestBody,
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    stored = await _run(store.load)
    url = body.url or stored.url
    token = body.token
    if token is None:
        token = await _run(store.read_token) or ""
    if not url:
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "url is required")
    return await amoeba_source.probe_source(url, token)


@router.post(
    "/sync",
    summary="Sync data from the MCP source now",
    description="Pulls units (aligning the departments tree), snapshots and budgets; also refreshes builtin metrics.",
)
async def post_sync(
    _: Any = Depends(require_admin()), server: Any = Depends(get_server)
) -> dict[str, Any]:
    services = server.services
    await _run(_ensure_catalog, server)
    return await amoeba_sync.run_sync(services=services, store=_store(server))


# ---- metric catalog admin ------------------------------------------------


class AmoebaMetricBody(BaseModel):
    metric_key: str | None = Field(default=None, description="Immutable key (create only)")
    name_zh: str
    name_en: str
    unit: str = ""
    category: str = Field(default="ops", description="Board group, e.g. core/ops/custom")
    formula: str = Field(default="", description="Arithmetic over metric keys; empty = raw metric")
    note_zh: str = ""
    note_en: str = ""
    format: Literal["number", "percent", "money"] = "number"
    agg: Literal["sum", "last"] = Field(
        default="sum", description="sum = flow metric, last = point-in-time metric"
    )
    color: str = ""
    sort: int = 0
    enabled: bool = True


class AmoebaMetricPatch(BaseModel):
    name_zh: str | None = None
    name_en: str | None = None
    unit: str | None = None
    category: str | None = None
    formula: str | None = None
    note_zh: str | None = None
    note_en: str | None = None
    format: Literal["number", "percent", "money"] | None = None
    agg: Literal["sum", "last"] | None = None
    color: str | None = None
    sort: int | None = None
    enabled: bool | None = None


@router.get("/metrics", summary="List all board metrics (admin)")
async def list_metrics_admin(
    _: Any = Depends(require_admin()), server: Any = Depends(get_server)
) -> dict[str, Any]:
    await _run(_ensure_catalog, server)
    rows = await _run(lambda: _repo(server).list_metrics(include_disabled=True))
    return {
        "metrics": [
            {
                "metric_key": m.metric_key,
                "name_zh": m.name_zh,
                "name_en": m.name_en,
                "unit": m.unit,
                "category": m.category,
                "formula": m.formula,
                "note_zh": m.note_zh,
                "note_en": m.note_en,
                "format": m.format,
                "agg": m.agg,
                "color": m.color,
                "sort": m.sort,
                "enabled": m.enabled,
                "builtin": m.builtin,
            }
            for m in rows
        ]
    }


def _validate_formula(formula: str) -> None:
    if not formula.strip():
        return
    try:
        formula_dependencies(formula)
    except FormulaError as exc:
        raise OctopError(ErrorCode.AMOEBA_METRIC_BAD_FORMULA, str(exc)) from None


@router.post("/metrics", status_code=201, summary="Create a custom metric")
async def create_metric(
    body: AmoebaMetricBody,
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    if not body.metric_key or not body.metric_key.replace("_", "").isalnum():
        raise OctopError(
            ErrorCode.AMOEBA_METRIC_BAD_FORMULA,
            "metric_key must be alphanumeric/underscore",
        )
    _validate_formula(body.formula)
    row = await _run(
        lambda: _repo(server).create_metric(
            metric_key=body.metric_key,
            name_zh=body.name_zh,
            name_en=body.name_en,
            unit=body.unit,
            category=body.category,
            formula=body.formula,
            note_zh=body.note_zh,
            note_en=body.note_en,
            format=body.format,
            agg=body.agg,
            color=body.color,
            sort=body.sort,
        )
    )
    if row is None:
        raise OctopError(ErrorCode.AMOEBA_METRIC_TAKEN, "metric key already exists")
    return {"metric_key": row.metric_key}


@router.patch("/metrics/{metric_key}", summary="Update or disable a metric")
async def patch_metric(
    metric_key: str,
    body: AmoebaMetricPatch,
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "formula" in updates:
        _validate_formula(updates["formula"])
    if "metric_key" in updates:
        updates.pop("metric_key")
    row = await _run(lambda: _repo(server).update_metric(metric_key, updates))
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, "metric not found")
    return {"metric_key": row.metric_key}


@router.delete(
    "/metrics/{metric_key}",
    summary="Delete a custom metric (builtin metrics get disabled)",
)
async def delete_metric(
    metric_key: str,
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    deleted = await _run(repo.delete_metric, metric_key)
    if not deleted:
        row = await _run(lambda: repo.update_metric(metric_key, {"enabled": False}))
        if row is None:
            raise OctopError(ErrorCode.NOT_FOUND, "metric not found")
        return {"metric_key": metric_key, "disabled": True}
    return {"metric_key": metric_key, "deleted": True}


# ---- user↔department bindings (data scope, admin) ------------------------


@router.get("/bindings", summary="List a user's department bindings")
async def get_bindings(
    user_id: int = Query(description="Octop user id"),
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    return {"user_id": user_id, "department_ids": await _run(repo.user_department_ids, user_id)}


class AmoebaBindingsBody(BaseModel):
    user_id: int
    department_ids: list[str] = Field(default_factory=list)


@router.put("/bindings", summary="Replace a user's department bindings")
async def put_bindings(
    body: AmoebaBindingsBody,
    _: Any = Depends(require_admin()),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    repo = _repo(server)
    result = await _run(repo.set_user_departments, body.user_id, body.department_ids)
    if result is None:
        raise OctopError(ErrorCode.NOT_FOUND, "unknown department in bindings")
    return {"user_id": body.user_id, "department_ids": result}
