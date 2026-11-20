"""Roll-up and presentation assembly for the amoeba board.

Caliber rules inherited from the reference demo:

* Fact rows live on leaf departments; any parent view is the SUM over its
  subtree (``WITH RECURSIVE`` expansion happens in ``AmoebaRepo``).
* Derived metrics are evaluated *after* roll-up from absolute sums — ratio
  metrics are never averaged across departments.
* ``d`` compares against the previous day, ``m`` against the period budget,
  ``y`` against the same span last year. Month/year values are
  cumulative-to-date windows anchored on the latest snapshot date.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import cast

from octop.infra.amoeba.builtin_metrics import BUILTIN_GROUP_LAYOUT
from octop.infra.amoeba.formula import evaluate_formula, formula_dependencies
from octop.infra.db.repos.amoeba import AmoebaMetricRow, AmoebaRepo
from octop.infra.db.repos.departments import DepartmentRow

SPARK_DAYS = 7
TREND_DAYS = 30
DIMS = ("d", "m", "y")


def resolve_asof(repo: AmoebaRepo) -> date | None:
    latest = repo.latest_snapshot_date()
    return date.fromisoformat(latest) if latest else None


def _window(asof: date, dim: str) -> tuple[str, str, int]:
    """``(date_from, date_to, in_progress_days)`` for the requested dimension."""
    if dim == "d":
        return asof.isoformat(), asof.isoformat(), 1
    if dim == "m":
        start = asof.replace(day=1)
        return start.isoformat(), asof.isoformat(), asof.day
    start = asof.replace(month=1, day=1)
    return start.isoformat(), asof.isoformat(), asof.timetuple().tm_yday


def _prev_window(asof: date, dim: str) -> tuple[str, str, int] | None:
    if dim == "d":
        prev = asof - timedelta(days=1)
        return prev.isoformat(), prev.isoformat(), 1
    if dim == "y":
        try:
            anchor = asof.replace(year=asof.year - 1)
        except ValueError:  # Feb 29
            anchor = asof.replace(year=asof.year - 1, day=28)
        start = anchor.replace(month=1, day=1)
        return start.isoformat(), anchor.isoformat(), anchor.timetuple().tm_yday
    return None


def _budget_period(asof: date, dim: str) -> str | None:
    if dim == "m":
        return asof.strftime("%Y-%m")
    if dim == "y":
        return asof.strftime("%Y")
    return None


def rolled_values(
    repo: AmoebaRepo,
    department_ids: list[str],
    metrics: list[AmoebaMetricRow],
    date_from: str,
    date_to: str,
    days: int,
) -> dict[str, float | None]:
    """Absolute-value roll-up for one window: raw SUMs plus derived evaluation."""
    raw_keys = [m.metric_key for m in metrics if not m.formula]
    values: dict[str, float | None] = dict.fromkeys(raw_keys, 0.0)
    values.update(repo.sum_snapshots(department_ids, raw_keys, date_from, date_to))
    return _resolve_derived(values, metrics, days)


def _resolve_derived(
    values: dict[str, float | None], metrics: list[AmoebaMetricRow], days: int
) -> dict[str, float | None]:
    """Evaluate derived formulas over raw sums, to a fixed point.

    Iterating lets derived formulas reference other derived keys (e.g.
    ``dis = dis_gas + dis_die + dis_non``).
    """
    pending = [m for m in metrics if m.formula]
    for _ in range(len(pending) + 1):
        if not pending:
            break
        progressed = False
        remaining: list[AmoebaMetricRow] = []
        for m in pending:
            deps = formula_dependencies(m.formula)
            if all(d in values for d in deps):
                values[m.metric_key] = evaluate_formula(m.formula, values, extra={"days": days})
                progressed = True
            else:
                remaining.append(m)
        pending = remaining
        if not progressed:
            break
    return values


def _series_for_keys(
    repo: AmoebaRepo,
    department_ids: list[str],
    metrics: list[AmoebaMetricRow],
    date_from: str,
    date_to: str,
    wanted: list[str],
) -> dict[str, list[dict[str, object]]]:
    """Daily roll-up series ``{key: [{date, value}]}`` including derived keys."""
    raw_keys = [m.metric_key for m in metrics if not m.formula]
    series = repo.daily_series(department_ids, raw_keys, date_from, date_to)
    dates = sorted({d for per_metric in series.values() for d in per_metric})
    per_day: dict[str, dict[str, float | None]] = {}
    for d in dates:
        day_values: dict[str, float | None] = dict.fromkeys(raw_keys, 0.0)
        day_values.update({k: per.get(d, 0.0) for k, per in series.items()})
        per_day[d] = _resolve_derived(day_values, metrics, days=1)
    out: dict[str, list[dict[str, object]]] = {}
    for key in wanted:
        rows: list[dict[str, object]] = []
        for d in dates:
            value = per_day[d].get(key, 0.0)
            rows.append({"date": d, "value": value})
        out[key] = rows
    return out


def _delta(value: float | None, base: float | None) -> float | None:
    if value is None or base is None or base == 0:
        return None
    return (value / base - 1.0) * 100.0


def _card(
    metric: AmoebaMetricRow,
    dims: dict[str, float | None],
    *,
    delta_pct: float | None,
    delta_kind: str | None,
    budget_value: float | None,
    budget_pct: float | None,
    spark: list[dict[str, object]] | None,
) -> dict[str, object]:
    return {
        "metric_key": metric.metric_key,
        "category": metric.category,
        "sort": metric.sort,
        "name_zh": metric.name_zh,
        "name_en": metric.name_en,
        "unit": metric.unit,
        "format": metric.format,
        "color": metric.color,
        "note_zh": metric.note_zh,
        "note_en": metric.note_en,
        "formula": metric.formula,
        "dims": dims,
        "delta_pct": delta_pct,
        "delta_kind": delta_kind,
        "budget_value": budget_value,
        "budget_pct": budget_pct,
        "spark": spark or [],
    }


def build_overview(
    repo: AmoebaRepo,
    *,
    department_ids: list[str],
    metrics: list[AmoebaMetricRow],
    asof: date,
    dim: str,
) -> dict[str, object]:
    """Assemble the full board payload for one department scope."""
    visible = [m for m in metrics if m.enabled and m.category != "hidden"]
    window_values = {
        d: rolled_values(repo, department_ids, metrics, *_window(asof, d)) for d in DIMS
    }
    prev = _prev_window(asof, dim)
    prev_values = rolled_values(repo, department_ids, metrics, *prev) if prev else {}
    budget_period = _budget_period(asof, dim)
    budgets = (
        repo.sum_budgets(department_ids, [m.metric_key for m in visible], budget_period)
        if budget_period
        else {}
    )
    spark_from = (asof - timedelta(days=SPARK_DAYS - 1)).isoformat()
    spark_to = asof.isoformat()
    sparks = _series_for_keys(
        repo, department_ids, metrics, spark_from, spark_to, [m.metric_key for m in visible]
    )

    cards: dict[str, dict[str, object]] = {}
    for m in visible:
        value = window_values[dim].get(m.metric_key)
        base = prev_values.get(m.metric_key)
        budget = budgets.get(m.metric_key)
        if dim == "m":
            delta_pct, delta_kind = None, None
        else:
            delta_pct = _delta(value, base)
            delta_kind = "mom" if dim == "d" else "yoy"
        budget_pct = (value / budget * 100.0) if value is not None and budget else None
        cards[m.metric_key] = _card(
            m,
            {d: window_values[d].get(m.metric_key) for d in DIMS},
            delta_pct=delta_pct,
            delta_kind=delta_kind,
            budget_value=budget,
            budget_pct=budget_pct,
            spark=sparks.get(m.metric_key),
        )

    known = set(cards)
    groups: list[dict[str, object]] = []
    laid_out: set[str] = set()
    for category, keys in BUILTIN_GROUP_LAYOUT:
        present = [k for k in keys if k in known]
        if not present:
            continue
        groups.append({"category": category, "metric_keys": present})
        laid_out.update(present)
    # Custom metrics (and custom categories) append after the builtin layout.
    rest = [m for m in visible if m.metric_key not in laid_out]
    by_category: dict[str, list[str]] = {}
    for m in rest:
        by_category.setdefault(m.category, []).append(m.metric_key)
    for category, keys in by_category.items():
        if not any(g["category"] == category for g in groups):
            groups.append({"category": category, "metric_keys": keys})
        else:
            for g in groups:
                if g["category"] == category:
                    existing_keys = cast(list[str], g["metric_keys"])
                    g["metric_keys"] = [*existing_keys, *keys]
    _, _, days = _window(asof, dim)
    return {
        "asof": asof.isoformat(),
        "dim": dim,
        "period_days": days,
        "groups": groups,
        "metrics": cards,
    }


def build_metric_detail(
    repo: AmoebaRepo,
    *,
    department_ids: list[str],
    departments: list[DepartmentRow],
    metrics: list[AmoebaMetricRow],
    metric_key: str,
    asof: date,
    dim: str,
) -> dict[str, object] | None:
    """Metric drawer payload: dims, comparisons, trend and per-leaf ranking."""
    metric = next((m for m in metrics if m.metric_key == metric_key), None)
    if metric is None:
        return None
    wanted = _closure_for(metric, metrics)
    window_values = {
        d: rolled_values(repo, department_ids, wanted, *_window(asof, d)) for d in DIMS
    }
    prev = _prev_window(asof, dim)
    prev_values = rolled_values(repo, department_ids, wanted, *prev) if prev else {}
    budget_period = _budget_period(asof, dim)
    budgets = (
        repo.sum_budgets(department_ids, [metric.metric_key], budget_period)
        if budget_period
        else {}
    )
    trend_from = (asof - timedelta(days=TREND_DAYS - 1)).isoformat()
    trend = _series_for_keys(
        repo, department_ids, wanted, trend_from, asof.isoformat(), [metric.metric_key]
    ).get(metric.metric_key, [])

    children = _leaf_scope(departments, department_ids)
    ranking: list[dict[str, object]] = []
    if children:
        # Rank leaves by the metric itself: sum each leaf's raw closure, then
        # evaluate the formula per leaf (ratio metrics stay per-leaf correct).
        date_from, date_to, rank_days = _window(asof, dim)
        raw_keys = [m.metric_key for m in wanted if not m.formula]
        per_leaf: dict[str, dict[str, float | None]] = {
            dept: dict.fromkeys(raw_keys, 0.0) for dept in children
        }
        for dept, key, val in repo.sum_by_department(children, raw_keys, date_from, date_to):
            per_leaf[dept][key] = val
        names = {d.department_id: d.name for d in departments}
        ranked: list[tuple[str, str, float]] = []
        for dept in children:
            resolved = _resolve_derived(per_leaf[dept], wanted, rank_days)
            value = resolved.get(metric.metric_key)
            if value is not None:
                ranked.append((dept, names.get(dept, dept), value))
        ranked.sort(key=lambda r: r[2], reverse=True)
        ranking = [
            {"department_id": dept, "name": name, "value": val} for dept, name, val in ranked
        ]
    value = window_values[dim].get(metric.metric_key)
    budget = budgets.get(metric.metric_key)
    if dim == "m":
        delta_pct, delta_kind = None, None
    else:
        delta_pct = _delta(value, prev_values.get(metric.metric_key))
        delta_kind = "mom" if dim == "d" else "yoy"
    return {
        "metric": _card(
            metric,
            {d: window_values[d].get(metric.metric_key) for d in DIMS},
            delta_pct=delta_pct,
            delta_kind=delta_kind,
            budget_value=budget,
            budget_pct=(value / budget * 100.0) if value is not None and budget else None,
            spark=None,
        ),
        "trend": trend,
        "ranking": ranking,
    }


def _closure_for(metric: AmoebaMetricRow, metrics: list[AmoebaMetricRow]) -> list[AmoebaMetricRow]:
    """The metric plus every (transitive) formula dependency."""
    by_key = {m.metric_key: m for m in metrics}
    seen: dict[str, AmoebaMetricRow] = {}

    def visit(key: str) -> None:
        if key in seen:
            return
        m = by_key.get(key)
        if m is None:
            return
        seen[key] = m
        for dep in formula_dependencies(m.formula):
            visit(dep)

    visit(metric.metric_key)
    return list(seen.values())


def _leaf_scope(departments: list[DepartmentRow], scope_ids: list[str]) -> list[str]:
    """Departments inside the scope that have no child department."""
    scope = set(scope_ids)
    parents = {d.parent_id for d in departments if d.parent_id in scope}
    return [
        d.department_id
        for d in departments
        if d.department_id in scope and d.department_id not in parents
    ]


__all__ = [
    "DIMS",
    "SPARK_DAYS",
    "TREND_DAYS",
    "build_metric_detail",
    "build_overview",
    "resolve_asof",
    "rolled_values",
]
