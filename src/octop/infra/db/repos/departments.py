"""Persistence for the department tree."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from psycopg.errors import ForeignKeyViolation

from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos._base import DbRow, map_rows
from octop.infra.utils.ulid import new_ulid


@dataclass(frozen=True)
class DepartmentRow:
    department_id: str
    parent_id: str | None
    name: str

    @classmethod
    def from_row(cls, row: DbRow) -> DepartmentRow:
        return cls(row["department_id"], row["parent_id"], row["name"])


@dataclass(frozen=True)
class DepartmentProfileRow:
    sort_order: int | None
    details_json: str
    updated_at: str | None


def _is_foreign_key_violation(exc: Exception) -> bool:
    return isinstance(exc, ForeignKeyViolation) or (
        isinstance(exc, sqlite3.IntegrityError)
        and exc.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
    )


class DepartmentRepo:
    def __init__(self, db: DatabasePool) -> None:
        self._db = db

    def list_all(self) -> list[DepartmentRow]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT d.department_id, d.parent_id, d.name FROM departments d "
                "LEFT JOIN department_profiles p ON p.department_id = d.department_id "
                "ORDER BY p.sort_order NULLS LAST, d.id"
            ).fetchall()
        return map_rows(rows, DepartmentRow)

    def create(self, name: str, parent_id: str | None) -> DepartmentRow | None:
        department_id = new_ulid()
        try:
            with self._db.transaction() as conn:
                conn.execute(
                    "INSERT INTO departments(department_id, parent_id, name) VALUES (?, ?, ?)",
                    (department_id, parent_id, name),
                )
        except (sqlite3.IntegrityError, ForeignKeyViolation) as exc:
            if _is_foreign_key_violation(exc):
                return None
            raise
        return DepartmentRow(department_id, parent_id, name)

    def rename(self, department_id: str, name: str) -> DepartmentRow | None:
        with self._db.transaction() as conn:
            row = conn.execute(
                "UPDATE departments SET name = ? WHERE department_id = ? "
                "RETURNING department_id, parent_id, name",
                (name, department_id),
            ).fetchone()
        return DepartmentRow.from_row(row) if row else None

    def get_profile(self, department_id: str) -> tuple[DepartmentRow, DepartmentProfileRow] | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT d.department_id, d.parent_id, d.name, p.sort_order, "
                "p.details_json, p.updated_at FROM departments d "
                "LEFT JOIN department_profiles p ON p.department_id = d.department_id "
                "WHERE d.department_id = ?",
                (department_id,),
            ).fetchone()
        if row is None:
            return None
        return DepartmentRow.from_row(row), DepartmentProfileRow(
            row["sort_order"], row["details_json"] or "{}", row["updated_at"]
        )

    def save_profile(
        self, department_id: str, name: str, sort_order: int | None, details_json: str
    ) -> tuple[DepartmentRow, DepartmentProfileRow] | None:
        updated_at = datetime.now(UTC).isoformat()
        with self._db.transaction() as conn:
            row = conn.execute(
                "UPDATE departments SET name = ? WHERE department_id = ? "
                "RETURNING department_id, parent_id, name",
                (name, department_id),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "INSERT INTO department_profiles(department_id, sort_order, details_json, updated_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(department_id) DO UPDATE SET "
                "sort_order = EXCLUDED.sort_order, details_json = EXCLUDED.details_json, "
                "updated_at = EXCLUDED.updated_at",
                (department_id, sort_order, details_json, updated_at),
            )
        return DepartmentRow.from_row(row), DepartmentProfileRow(
            sort_order, details_json, updated_at
        )

    def delete(self, department_id: str) -> Literal["deleted", "missing", "has_children"]:
        try:
            with self._db.transaction() as conn:
                cursor = conn.execute(
                    "DELETE FROM departments WHERE department_id = ?", (department_id,)
                )
                return "deleted" if cursor.rowcount else "missing"
        except (sqlite3.IntegrityError, ForeignKeyViolation) as exc:
            if _is_foreign_key_violation(exc):
                return "has_children"
            raise
