"""Persistence for the amoeba board: metric catalog, daily snapshots, budgets and
user↔department bindings (the board's row-level data scope)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from psycopg.errors import ForeignKeyViolation

from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos._base import DbRow, bool_int, map_rows, sql_in_placeholders

SnapshotRow = tuple[str, str, str, float]
BudgetRow = tuple[str, str, str, float]


@dataclass(frozen=True)
class AmoebaMetricRow:
    metric_key: str
    name_zh: str
    name_en: str
    unit: str
    category: str
    formula: str
    note_zh: str
    note_en: str
    format: str
    agg: str
    color: str
    sort: int
    enabled: bool
    builtin: bool

    @classmethod
    def from_row(cls, row: DbRow) -> AmoebaMetricRow:
        return cls(
            metric_key=row["metric_key"],
            name_zh=row["name_zh"],
            name_en=row["name_en"],
            unit=row["unit"],
            category=row["category"],
            formula=row["formula"],
            note_zh=row["note_zh"],
            note_en=row["note_en"],
            format=row["format"],
            agg=row["agg"],
            color=row["color"],
            sort=int(row["sort"]),
            enabled=bool(row["enabled"]),
            builtin=bool(row["builtin"]),
        )


def _is_foreign_key_violation(exc: Exception) -> bool:
    return isinstance(exc, ForeignKeyViolation) or (
        isinstance(exc, sqlite3.IntegrityError)
        and exc.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
    )


def _subtree_cte(roots: Sequence[str]) -> str:
    """Recursive CTE selecting every department below (and including) the roots."""
    placeholders = sql_in_placeholders(len(roots))
    return (
        "WITH RECURSIVE subtree(department_id) AS ("
        f"SELECT department_id FROM departments WHERE department_id IN ({placeholders}) "
        "UNION ALL "
        "SELECT d.department_id FROM departments d "
        "JOIN subtree s ON d.parent_id = s.department_id)"
    )


class AmoebaRepo:
    def __init__(self, db: DatabasePool) -> None:
        self._db = db

    # ---- metric catalog -------------------------------------------------

    def list_metrics(self, *, include_disabled: bool = False) -> list[AmoebaMetricRow]:
        where = "" if include_disabled else "WHERE enabled = 1"
        with self._db.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM amoeba_metrics {where} ORDER BY category, sort, metric_key"
            ).fetchall()
        return map_rows(rows, AmoebaMetricRow)

    def get_metric(self, metric_key: str) -> AmoebaMetricRow | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM amoeba_metrics WHERE metric_key = ?", (metric_key,)
            ).fetchone()
        return AmoebaMetricRow.from_row(row) if row else None

    def create_metric(
        self,
        *,
        metric_key: str,
        name_zh: str,
        name_en: str,
        unit: str,
        category: str,
        formula: str = "",
        note_zh: str = "",
        note_en: str = "",
        format: str = "number",
        agg: str = "sum",
        color: str = "",
        sort: int = 0,
    ) -> AmoebaMetricRow | None:
        try:
            with self._db.transaction() as conn:
                conn.execute(
                    "INSERT INTO amoeba_metrics(metric_key, name_zh, name_en, unit, category, "
                    "formula, note_zh, note_en, format, agg, color, sort, enabled, builtin) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)",
                    (
                        metric_key,
                        name_zh,
                        name_en,
                        unit,
                        category,
                        formula,
                        note_zh,
                        note_en,
                        format,
                        agg,
                        color,
                        sort,
                    ),
                )
        except (sqlite3.IntegrityError, ForeignKeyViolation) as exc:
            if isinstance(exc, sqlite3.IntegrityError):
                return None
            raise
        row = self.get_metric(metric_key)
        assert row is not None
        return row

    def update_metric(self, metric_key: str, updates: dict[str, Any]) -> AmoebaMetricRow | None:
        columns = (
            "name_zh",
            "name_en",
            "unit",
            "category",
            "formula",
            "note_zh",
            "note_en",
            "format",
            "agg",
            "color",
            "sort",
            "enabled",
        )
        sets = [c for c in columns if c in updates]
        if not sets:
            return self.get_metric(metric_key)
        params = [updates[c] for c in sets]
        if "enabled" in sets:
            idx = sets.index("enabled")
            params[idx] = bool_int(bool(params[idx]))
        params.append(metric_key)
        with self._db.transaction() as conn:
            row = conn.execute(
                f"UPDATE amoeba_metrics SET {', '.join(f'{c} = ?' for c in sets)} "
                "WHERE metric_key = ? RETURNING *",
                params,
            ).fetchone()
        return AmoebaMetricRow.from_row(row) if row else None

    def upsert_builtin_metrics(self, metrics: Sequence[AmoebaMetricRow]) -> None:
        """Seed/refresh code-owned metrics; user edits to them are overwritten."""
        with self._db.transaction() as conn:
            for m in metrics:
                conn.execute(
                    "INSERT INTO amoeba_metrics(metric_key, name_zh, name_en, unit, category, "
                    "formula, note_zh, note_en, format, agg, color, sort, enabled, builtin) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1) "
                    "ON CONFLICT(metric_key) DO UPDATE SET "
                    "name_zh = EXCLUDED.name_zh, name_en = EXCLUDED.name_en, "
                    "unit = EXCLUDED.unit, category = EXCLUDED.category, "
                    "formula = EXCLUDED.formula, note_zh = EXCLUDED.note_zh, "
                    "note_en = EXCLUDED.note_en, "
                    "format = EXCLUDED.format, agg = EXCLUDED.agg, "
                    "color = EXCLUDED.color, sort = EXCLUDED.sort, "
                    "builtin = 1",
                    (
                        m.metric_key,
                        m.name_zh,
                        m.name_en,
                        m.unit,
                        m.category,
                        m.formula,
                        m.note_zh,
                        m.note_en,
                        m.format,
                        m.agg,
                        m.color,
                        m.sort,
                    ),
                )

    # ---- subtree helpers ------------------------------------------------

    def delete_metric(self, metric_key: str) -> bool:
        """Delete a metric; builtin metrics must be disabled instead."""
        with self._db.transaction() as conn:
            row = conn.execute(
                "SELECT builtin FROM amoeba_metrics WHERE metric_key = ?", (metric_key,)
            ).fetchone()
            if row is None or row["builtin"]:
                return False
            conn.execute("DELETE FROM amoeba_metrics WHERE metric_key = ?", (metric_key,))
            return True

    def subtree_ids(self, roots: Sequence[str]) -> list[str]:
        if not roots:
            return []
        with self._db.connect() as conn:
            rows = conn.execute(
                f"{_subtree_cte(roots)} SELECT department_id FROM subtree",
                list(roots),
            ).fetchall()
        return [r["department_id"] for r in rows]

    # ---- snapshots ------------------------------------------------------

    def upsert_snapshots(self, rows: Iterable[SnapshotRow]) -> int:
        rows = list(rows)
        if not rows:
            return 0
        with self._db.transaction() as conn:
            conn.executemany(
                "INSERT INTO amoeba_snapshots(department_id, stat_date, metric_key, value) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(department_id, stat_date, metric_key) "
                "DO UPDATE SET value = EXCLUDED.value",
                rows,
            )
        return len(rows)

    def sum_snapshots(
        self,
        department_ids: Sequence[str],
        metric_keys: Sequence[str],
        date_from: str,
        date_to: str,
    ) -> dict[str, float]:
        """SUM of absolute values across the given departments (the board's roll-up)."""
        if not department_ids or not metric_keys:
            return {}
        dept_ph = sql_in_placeholders(len(department_ids))
        metric_ph = sql_in_placeholders(len(metric_keys))
        params: list[Any] = [*department_ids, *metric_keys, date_from, date_to]
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT metric_key, SUM(value) AS total FROM amoeba_snapshots "
                f"WHERE department_id IN ({dept_ph}) AND metric_key IN ({metric_ph}) "
                "AND stat_date >= ? AND stat_date <= ? GROUP BY metric_key",
                params,
            ).fetchall()
        return {r["metric_key"]: float(r["total"] or 0.0) for r in rows}

    def last_snapshots(
        self,
        department_ids: Sequence[str],
        metric_keys: Sequence[str],
        date_from: str,
        date_to: str,
    ) -> dict[str, float]:
        """Point-in-time roll-up: each department's newest window value, summed.

        For stock-like metrics (inventory, gun counts) where summing daily rows
        would inflate the magnitude.
        """
        if not department_ids or not metric_keys:
            return {}
        dept_ph = sql_in_placeholders(len(department_ids))
        metric_ph = sql_in_placeholders(len(metric_keys))
        params: list[Any] = [*department_ids, *metric_keys, date_from, date_to]
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT s.metric_key, SUM(s.value) AS total FROM amoeba_snapshots s "
                "JOIN (SELECT department_id, metric_key, MAX(stat_date) AS maxd "
                f"FROM amoeba_snapshots WHERE department_id IN ({dept_ph}) "
                f"AND metric_key IN ({metric_ph}) AND stat_date >= ? AND stat_date <= ? "
                "GROUP BY department_id, metric_key) m "
                "ON s.department_id = m.department_id AND s.metric_key = m.metric_key "
                "AND s.stat_date = m.maxd "
                "GROUP BY s.metric_key",
                params,
            ).fetchall()
        return {r["metric_key"]: float(r["total"] or 0.0) for r in rows}

    def daily_series(
        self,
        department_ids: Sequence[str],
        metric_keys: Sequence[str],
        date_from: str,
        date_to: str,
    ) -> dict[str, dict[str, float]]:
        """Per-day SUM per metric: ``{metric_key: {date: value}}``."""
        if not department_ids or not metric_keys:
            return {}
        dept_ph = sql_in_placeholders(len(department_ids))
        metric_ph = sql_in_placeholders(len(metric_keys))
        params: list[Any] = [*department_ids, *metric_keys, date_from, date_to]
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT metric_key, stat_date, SUM(value) AS total FROM amoeba_snapshots "
                f"WHERE department_id IN ({dept_ph}) AND metric_key IN ({metric_ph}) "
                "AND stat_date >= ? AND stat_date <= ? "
                "GROUP BY metric_key, stat_date ORDER BY stat_date",
                params,
            ).fetchall()
        out: dict[str, dict[str, float]] = {}
        for r in rows:
            out.setdefault(r["metric_key"], {})[r["stat_date"]] = float(r["total"] or 0.0)
        return out

    def sum_by_department(
        self,
        department_ids: Sequence[str],
        metric_keys: Sequence[str],
        date_from: str,
        date_to: str,
    ) -> list[tuple[str, str, float]]:
        """``(department_id, metric_key, total)`` rows for per-unit rankings."""
        if not department_ids or not metric_keys:
            return []
        dept_ph = sql_in_placeholders(len(department_ids))
        metric_ph = sql_in_placeholders(len(metric_keys))
        params: list[Any] = [*department_ids, *metric_keys, date_from, date_to]
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT department_id, metric_key, SUM(value) AS total FROM amoeba_snapshots "
                f"WHERE department_id IN ({dept_ph}) AND metric_key IN ({metric_ph}) "
                "AND stat_date >= ? AND stat_date <= ? "
                "GROUP BY department_id, metric_key",
                params,
            ).fetchall()
        return [(r["department_id"], r["metric_key"], float(r["total"] or 0.0)) for r in rows]

    def latest_snapshot_date(self, department_ids: Sequence[str] | None = None) -> str | None:
        where = ""
        params: list[Any] = []
        if department_ids:
            where = f"WHERE department_id IN ({sql_in_placeholders(len(department_ids))})"
            params = list(department_ids)
        with self._db.connect() as conn:
            row = conn.execute(
                f"SELECT MAX(stat_date) AS d FROM amoeba_snapshots {where}", params
            ).fetchone()
        return row["d"] if row and row["d"] else None

    # ---- budgets ----------------------------------------------------------

    def upsert_budgets(self, rows: Iterable[BudgetRow]) -> int:
        rows = list(rows)
        if not rows:
            return 0
        with self._db.transaction() as conn:
            conn.executemany(
                "INSERT INTO amoeba_budgets(department_id, period, metric_key, value) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(department_id, period, metric_key) "
                "DO UPDATE SET value = EXCLUDED.value",
                rows,
            )
        return len(rows)

    def sum_budgets(
        self, department_ids: Sequence[str], metric_keys: Sequence[str], period: str
    ) -> dict[str, float]:
        if not department_ids or not metric_keys:
            return {}
        dept_ph = sql_in_placeholders(len(department_ids))
        metric_ph = sql_in_placeholders(len(metric_keys))
        params: list[Any] = [*department_ids, *metric_keys, period]
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT metric_key, SUM(value) AS total FROM amoeba_budgets "
                f"WHERE department_id IN ({dept_ph}) AND metric_key IN ({metric_ph}) "
                "AND period = ? GROUP BY metric_key",
                params,
            ).fetchall()
        return {r["metric_key"]: float(r["total"] or 0.0) for r in rows}

    # ---- user↔department bindings (data scope) ---------------------------

    def user_department_ids(self, user_id: int) -> list[str]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT department_id FROM user_departments WHERE user_id = ? ORDER BY department_id",
                (user_id,),
            ).fetchall()
        return [r["department_id"] for r in rows]

    def set_user_departments(self, user_id: int, department_ids: Sequence[str]) -> list[str] | None:
        """Replace a user's bindings; None signals an unknown department id."""
        wanted = list(dict.fromkeys(department_ids))
        with self._db.transaction() as conn:
            if wanted:
                ph = sql_in_placeholders(len(wanted))
                known = {
                    r["department_id"]
                    for r in conn.execute(
                        f"SELECT department_id FROM departments WHERE department_id IN ({ph})",
                        wanted,
                    ).fetchall()
                }
                if known != set(wanted):
                    return None
            conn.execute("DELETE FROM user_departments WHERE user_id = ?", (user_id,))
            conn.executemany(
                "INSERT INTO user_departments(user_id, department_id) VALUES (?, ?)",
                [(user_id, d) for d in wanted],
            )
        return wanted

    def bound_user_ids(self, department_id: str) -> list[int]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT user_id FROM user_departments WHERE department_id = ?",
                (department_id,),
            ).fetchall()
        return [int(r["user_id"]) for r in rows]
