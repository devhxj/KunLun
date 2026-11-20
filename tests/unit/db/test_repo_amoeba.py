"""Repo-level tests for amoeba persistence (snapshots, budgets, bindings)."""

from __future__ import annotations

from pathlib import Path

from octop.infra.amoeba.builtin_metrics import BUILTIN_METRICS, ensure_builtin_metrics
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.amoeba import AmoebaRepo
from octop.infra.db.repos.departments import DepartmentRepo


def _db(tmp_path: Path) -> SqlitePool:
    db = SqlitePool(tmp_path / "octop.db")
    run_migrations(db)
    return db


def test_snapshot_upsert_overwrites_and_subtree_filters(tmp_path: Path) -> None:
    db = _db(tmp_path)
    dept_repo = DepartmentRepo(db)
    amoeba = AmoebaRepo(db)
    root = dept_repo.create("全省", None)
    assert root is not None
    am = dept_repo.create("武汉", root.department_id)
    assert am is not None
    st1 = dept_repo.create("雄楚站", am.department_id)
    assert st1 is not None
    st2 = dept_repo.create("珞喻站", am.department_id)
    assert st2 is not None

    amoeba.upsert_snapshots(
        [
            (st1.department_id, "2026-11-10", "gas", 100.0),
            (st2.department_id, "2026-11-10", "gas", 50.0),
        ]
    )
    # Upsert overwrites instead of duplicating.
    amoeba.upsert_snapshots([(st1.department_id, "2026-11-10", "gas", 110.0)])

    assert set(amoeba.subtree_ids([am.department_id])) == {
        am.department_id,
        st1.department_id,
        st2.department_id,
    }
    ids = amoeba.subtree_ids([am.department_id])
    sums = amoeba.sum_snapshots(ids, ["gas"], "2026-11-01", "2026-11-30")
    assert sums == {"gas": 160.0}
    assert amoeba.sum_snapshots(ids, ["gas"], "2026-12-01", "2026-12-31") == {}

    series = amoeba.daily_series(ids, ["gas"], "2026-11-01", "2026-11-30")
    assert series["gas"] == {"2026-11-10": 160.0}

    rows = amoeba.sum_by_department(
        [st1.department_id, st2.department_id], ["gas"], "2026-11-01", "2026-11-30"
    )
    assert sorted(rows) == [
        (st1.department_id, "gas", 110.0),
        (st2.department_id, "gas", 50.0),
    ]
    assert amoeba.latest_snapshot_date() == "2026-11-10"


def test_budget_upsert_and_sum(tmp_path: Path) -> None:
    db = _db(tmp_path)
    dept_repo = DepartmentRepo(db)
    amoeba = AmoebaRepo(db)
    st1 = dept_repo.create("雄楚站", None)
    assert st1 is not None
    st2 = dept_repo.create("珞喻站", None)
    assert st2 is not None

    amoeba.upsert_budgets(
        [
            (st1.department_id, "2026-11", "gas", 6000.0),
            (st2.department_id, "2026-11", "gas", 3000.0),
        ]
    )
    amoeba.upsert_budgets([(st1.department_id, "2026-11", "gas", 5000.0)])
    total = amoeba.sum_budgets([st1.department_id, st2.department_id], ["gas"], "2026-11")
    assert total == {"gas": 8000.0}
    assert amoeba.sum_budgets([st1.department_id], ["gas"], "2026-12") == {}


def test_user_department_binding_scopes(tmp_path: Path) -> None:
    db = _db(tmp_path)
    dept_repo = DepartmentRepo(db)
    amoeba = AmoebaRepo(db)
    root = dept_repo.create("全省", None)
    assert root is not None
    am = dept_repo.create("武汉", root.department_id)
    assert am is not None

    with db.connect() as conn:
        conn.execute(
            "INSERT INTO users(username, password_hash, role, created_at) "
            "VALUES ('alice', 'x', 'user', 1)"
        )
        user_id = conn.execute("SELECT id FROM users WHERE username = 'alice'").fetchone()["id"]

    assert amoeba.user_department_ids(user_id) == []
    assert amoeba.set_user_departments(user_id, [am.department_id]) == [am.department_id]
    assert amoeba.user_department_ids(user_id) == [am.department_id]
    assert amoeba.bound_user_ids(am.department_id) == [user_id]

    # Replace semantics + unknown department rejected.
    assert amoeba.set_user_departments(user_id, []) == []
    assert amoeba.set_user_departments(user_id, ["missing"]) is None
    assert amoeba.user_department_ids(user_id) == []


def test_builtin_metric_seed_and_crud(tmp_path: Path) -> None:
    db = _db(tmp_path)
    amoeba = AmoebaRepo(db)

    assert amoeba.list_metrics() == []
    ensure_builtin_metrics(amoeba)
    rows = amoeba.list_metrics()
    assert len(rows) == len(BUILTIN_METRICS)
    assert all(r.builtin for r in rows)
    # Idempotent refresh keeps one row per key.
    ensure_builtin_metrics(amoeba)
    assert len(amoeba.list_metrics(include_disabled=True)) == len(BUILTIN_METRICS)

    created = amoeba.create_metric(
        metric_key="custom1",
        name_zh="自定义",
        name_en="Custom",
        unit="元",
        category="ops",
    )
    assert created is not None and created.metric_key == "custom1"
    assert (
        amoeba.create_metric(
            metric_key="custom1", name_zh="x", name_en="x", unit="", category="ops"
        )
        is None
    )  # duplicate key

    patched = amoeba.update_metric("custom1", {"enabled": False})
    assert patched is not None and patched.enabled is False
    assert len(amoeba.list_metrics()) == len(BUILTIN_METRICS)  # disabled one dropped

    # Builtin metrics refuse deletion; custom metrics delete.
    assert amoeba.delete_metric("gas") is False
    assert amoeba.delete_metric("custom1") is True
    assert amoeba.get_metric("custom1") is None
