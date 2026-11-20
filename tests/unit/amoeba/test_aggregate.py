"""Unit tests for the amoeba roll-up engine (caliber rules from the demo)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from octop.infra.amoeba.aggregate import (
    build_metric_detail,
    build_overview,
    resolve_asof,
    rolled_values,
)
from octop.infra.amoeba.builtin_metrics import ensure_builtin_metrics
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.amoeba import AmoebaRepo
from octop.infra.db.repos.departments import DepartmentRepo


def _setup(tmp_path: Path) -> tuple[AmoebaRepo, DepartmentRepo]:
    db = SqlitePool(tmp_path / "octop.db")
    run_migrations(db)
    amoeba = AmoebaRepo(db)
    ensure_builtin_metrics(amoeba)
    return amoeba, DepartmentRepo(db)


def _tree(dept_repo: DepartmentRepo) -> dict[str, str]:
    root = dept_repo.create("全省", None)
    assert root is not None
    am = dept_repo.create("武汉阿米巴", root.department_id)
    assert am is not None
    st1 = dept_repo.create("雄楚站", am.department_id)
    assert st1 is not None
    st2 = dept_repo.create("珞喻站", am.department_id)
    assert st2 is not None
    return {
        "root": root.department_id,
        "am": am.department_id,
        "st1": st1.department_id,
        "st2": st2.department_id,
    }


def test_rolled_values_derives_and_rejects_zero_division(tmp_path: Path) -> None:
    amoeba, dept_repo = _setup(tmp_path)
    ids = _tree(dept_repo)
    amoeba.upsert_snapshots(
        [
            (ids["st1"], "2026-11-10", "gas", 100.0),
            (ids["st1"], "2026-11-10", "die", 40.0),
            (ids["st2"], "2026-11-10", "gas", 60.0),
            (ids["st2"], "2026-11-10", "die", 20.0),
            (ids["st1"], "2026-11-10", "chgrev", 840.0),
            (ids["st1"], "2026-11-10", "kwh", 2000.0),
            # st2 has no charging data at all → kwh total comes from st1 only.
        ]
    )
    metrics = amoeba.list_metrics()
    values = rolled_values(amoeba, [ids["st1"], ids["st2"]], metrics, "2026-11-10", "2026-11-10", 1)
    assert values["gas"] == 160.0
    assert values["oil"] == 220.0  # gas + die derived after roll-up
    # Ratio metrics are recomputed from aggregated absolutes, never averaged:
    # chgfee = 840/2000 = 0.42 (a per-station average would give (0.42+0)/2).
    assert values["chgfee"] == 0.42
    # Division by zero yields None, not an exception.
    amoeba.upsert_snapshots([])
    empty = rolled_values(amoeba, [ids["st1"]], metrics, "2020-01-01", "2020-01-02", 1)
    assert empty["chgfee"] is None
    assert empty["gas"] == 0.0


def test_days_placeholder_uses_dimension_progress(tmp_path: Path) -> None:
    amoeba, dept_repo = _setup(tmp_path)
    ids = _tree(dept_repo)
    amoeba.upsert_snapshots(
        [
            (ids["st1"], "2026-11-10", "gas", 210.0),
            (ids["st1"], "2026-11-10", "die", 90.0),
            (ids["st2"], "2026-11-10", "gas", 84.0),
            (ids["st2"], "2026-11-10", "die", 36.0),
            (ids["st1"], "2026-11-10", "guns", 10.0),
            (ids["st2"], "2026-11-10", "guns", 14.0),
        ]
    )
    metrics = amoeba.list_metrics()
    # gunvol = oil/(guns*{{days}}); oil = 420 across stations, guns = 24, days = 10.
    values = rolled_values(
        amoeba, [ids["st1"], ids["st2"]], metrics, "2026-11-01", "2026-11-10", 10
    )
    assert values["gunvol"] == 1.75


def test_build_overview_windows_and_groups(tmp_path: Path) -> None:
    amoeba, dept_repo = _setup(tmp_path)
    ids = _tree(dept_repo)
    amoeba.upsert_snapshots(
        [
            # Today (asof).
            (ids["st1"], "2026-11-11", "gas", 100.0),
            (ids["st1"], "2026-11-11", "die", 50.0),
            (ids["st2"], "2026-11-11", "gas", 25.0),
            (ids["st2"], "2026-11-11", "die", 25.0),
            # Yesterday (d prev-day base).
            (ids["st1"], "2026-11-10", "gas", 100.0),
            (ids["st1"], "2026-11-10", "die", 50.0),
            (ids["st2"], "2026-11-10", "gas", 50.0),
            (ids["st2"], "2026-11-10", "die", 50.0),
            # Last year same span (y yoy base).
            (ids["st1"], "2025-11-11", "gas", 400.0),
            (ids["st1"], "2025-11-11", "die", 400.0),
        ]
    )
    amoeba.upsert_budgets(
        [(ids["st1"], "2026-11", "gas", 6000.0), (ids["st2"], "2026-11", "gas", 3000.0)]
    )
    asof = resolve_asof(amoeba)
    assert asof == date(2026, 11, 11)
    metrics = amoeba.list_metrics()
    scope = [ids["am"], ids["st1"], ids["st2"]]
    overview = build_overview(amoeba, department_ids=scope, metrics=metrics, asof=asof, dim="d")

    gas = overview["metrics"]["gas"]
    assert gas["dims"]["d"] == 125.0  # 100 + 25
    assert gas["dims"]["m"] == 275.0  # month-to-date = both days
    assert gas["dims"]["y"] == 275.0  # year-to-date covers this year only
    assert round(gas["delta_pct"], 4) == round((125.0 / 150.0 - 1) * 100, 4)  # vs yesterday
    assert gas["delta_kind"] == "mom"
    assert [p["value"] for p in gas["spark"]] == [150.0, 125.0]
    assert overview["metrics"]["oil"]["dims"]["d"] == 200.0  # 125 gas + 75 die

    categories = [g["category"] for g in overview["groups"]]
    assert categories[0] == "core"
    assert "oil" in overview["groups"][0]["metric_keys"]

    monthly = build_overview(amoeba, department_ids=scope, metrics=metrics, asof=asof, dim="m")
    gas_m = monthly["metrics"]["gas"]
    assert gas_m["dims"]["m"] == 275.0
    assert gas_m["budget_value"] == 9000.0
    assert round(gas_m["budget_pct"], 4) == round(275.0 / 9000.0 * 100, 4)
    assert gas_m["delta_pct"] is None  # month compares against budget, not delta

    yearly = build_overview(amoeba, department_ids=scope, metrics=metrics, asof=asof, dim="y")
    gas_y = yearly["metrics"]["gas"]
    assert gas_y["dims"]["y"] == 275.0
    assert gas_y["delta_kind"] == "yoy"
    assert round(gas_y["delta_pct"], 4) == round((275.0 / 400.0 - 1) * 100, 4)


def test_metric_detail_ranks_leaves_only(tmp_path: Path) -> None:
    amoeba, dept_repo = _setup(tmp_path)
    ids = _tree(dept_repo)
    amoeba.upsert_snapshots(
        [
            (ids["st1"], "2026-11-11", "gas", 100.0),
            (ids["st2"], "2026-11-11", "gas", 40.0),
        ]
    )
    departments = dept_repo.list_all()
    metrics = amoeba.list_metrics()
    detail = build_metric_detail(
        amoeba,
        department_ids=[ids["root"], ids["am"], ids["st1"], ids["st2"]],
        departments=departments,
        metrics=metrics,
        metric_key="gas",
        asof=date(2026, 11, 11),
        dim="d",
    )
    assert detail is not None
    ranked = [(r["department_id"], r["value"]) for r in detail["ranking"]]
    # The amoeba and root are not leaves — ranking covers stations only.
    assert ranked == [(ids["st1"], 100.0), (ids["st2"], 40.0)]
    assert [p["value"] for p in detail["trend"]] == [140.0]
