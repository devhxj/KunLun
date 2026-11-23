"""Amoeba board MCP stub — a local data source for demo / integration checks.

Implements the contract from ``docs/amoeba-mcp-source.md``:

* ``amoeba_units``         — demo stations or existing Hubei sales branches
* ``amoeba_metrics_data``  — deterministic per-unit daily rows for all 38
                             raw metrics (weekend uplift, slow YoY growth)
* ``amoeba_budgets``       — monthly + yearly budgets for key metrics
* ``amoeba_meta``          — asof = yesterday

Values are generated from a seeded PRNG so every restart serves the same
numbers; ratios stay self-consistent (chgfee = chgrev/kwh etc.) so derived
metrics on the Octop side render sensibly.

Run:
    uv run python scripts/amoeba_stub_server.py [--port 8765]

For an existing local SQLite instance, pass ``--organization-db PATH`` to
generate sample data for the existing Hubei branches without creating stations.

Then configure the board with url = http://127.0.0.1:<port>/mcp and any token
(auth is not enforced by the stub).
"""

from __future__ import annotations

import argparse
import datetime as dt
import random
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------- topology ---

AMOEBA_STATIONS: list[tuple[str, list[str]]] = [
    ("武汉城区阿米巴", ["雄楚大道站", "珞喻路站", "三环北站", "光谷大道站", "汉阳四新站"]),
    ("江汉平原阿米巴", ["荆州古城站", "沙市江津站", "仙桃汉江站", "孝感槐荫站"]),
    ("鄂西北阿米巴", ["襄阳樊城站", "襄阳东津站", "十堰北京路站", "丹江口大坝站"]),
    ("鄂西南阿米巴", ["宜昌东山站", "宜昌伍家岗站", "恩施舞阳站", "利川腾龙站"]),
    ("鄂东阿米巴", ["黄冈黄州站", "黄石磁湖站", "咸宁温泉站", "赤壁陆水站"]),
    ("鄂中阿米巴", ["荆门象山站", "钟祥明显陵站", "京山温泉站"]),
]

HUBEI_BRANCHES = (
    "武汉分公司",
    "宜昌分公司",
    "黄冈分公司",
    "荆州分公司",
    "襄阳分公司",
    "孝感分公司",
    "黄石分公司",
    "荆门分公司",
    "咸宁分公司",
    "恩施分公司",
    "江汉分公司",
    "十堰分公司",
)
ORGANIZATION_DB: Path | None = None
YOY_GROWTH = 0.04  # ~+4% year over year

# Discount split across the 9 items × fuel grades (sums to ~1.0 per stream).
_DISCOUNT_SPLIT = [
    ("d1", 0.47, 0.55),  # 挂牌直降 gas/die share
    ("d2", 0.08, 0.00),
    ("d3", 0.09, 0.10),
    ("d4", 0.15, 0.12),
    ("d5", 0.06, 0.00),  # 3.0优惠券 also feeds non-oil
    ("d6", 0.03, 0.00),
    ("d7", 0.00, 0.00),  # 洗车 — non-oil only
    ("d8", 0.00, 0.00),  # 组合营销 — non-oil only
    ("d9", 0.04, 0.08),
]
_NON_DISCOUNT_SPLIT = {"d5": 0.35, "d7": 0.22, "d8": 0.43}


def _branch_rows(path: Path) -> list[dict[str, Any]]:
    """Serve only existing, globally unique names that Octop can safely match."""
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        departments = conn.execute(
            "SELECT department_id, name, parent_id FROM departments"
        ).fetchall()
    names = {"湖北销售", *HUBEI_BRANCHES}
    units = [row for row in departments if row[1] in names]
    if len(units) != len(names) or {row[1] for row in units} != names:
        raise ValueError("Hubei sales root and branch names must each match one department")
    root_id, _, root_parent = next(row for row in units if row[1] == "湖北销售")
    parents = {row[2] for row in departments}
    if root_parent is not None or any(
        parent != root_id or department_id in parents
        for department_id, _, parent in units
        if department_id != root_id
    ):
        raise ValueError("Hubei sales branches must be the root's direct leaf departments")
    return [
        {
            "unit_key": f"hubei-branch:{department_id}",
            "name": name,
            "parent_key": f"hubei-branch:{parent}" if parent else None,
        }
        for department_id, name, parent in units
    ]


def _unit_rows() -> list[dict[str, Any]]:
    if ORGANIZATION_DB is not None:
        return _branch_rows(ORGANIZATION_DB)
    rows = [{"unit_key": "HB", "name": "湖北销售分公司", "parent_key": None}]
    for idx, (am_name, stations) in enumerate(AMOEBA_STATIONS):
        am_key = f"HB-{idx + 1:02d}"
        rows.append({"unit_key": am_key, "name": am_name, "parent_key": "HB"})
        for s_idx, station in enumerate(stations):
            rows.append(
                {"unit_key": f"{am_key}-{s_idx + 1:02d}", "name": station, "parent_key": am_key}
            )
    return rows


def _station_profile(unit_key: str) -> dict[str, float]:
    """Stable per-station multipliers (scale, guns, charging …)."""
    rng = random.Random(f"profile|{unit_key}")
    return {
        "scale": round(rng.uniform(0.65, 1.45), 3),
        "gas_share": round(rng.uniform(0.55, 0.65), 3),
        "guns": float(rng.randint(12, 24)),
        "chgguns": float(rng.randint(4, 20)),
        "kwh_base": rng.uniform(1400, 3800),
    }


def _day_factor(unit_key: str, day: dt.date) -> float:
    rng = random.Random(f"day|{unit_key}|{day.isoformat()}")
    weekend = 1.25 if day.weekday() >= 5 else 1.0
    return rng.uniform(0.85, 1.15) * weekend


def _rows_for(
    unit_key: str, day: dt.date, metric_keys: set[str], asof: dt.date
) -> dict[str, float]:
    """Raw metric values for one station-day, internally consistent."""
    prof = _station_profile(unit_key)
    fac = _day_factor(unit_key, day)
    # Year-over-year baseline: same day last year is YOY_GROWTH smaller.
    days_ago = (asof - day).days
    growth = 1.0 if days_ago < 365 else 1.0 / (1.0 + YOY_GROWTH)
    scale = prof["scale"] * fac * growth

    gas = round(prof["gas_share"] * 13.5 * scale, 3)  # 吨
    die = round((1 - prof["gas_share"]) * 11.0 * scale, 3)  # 吨
    lng = round(1.1 * scale, 3)
    cng = round(0.6 * scale, 3)
    kwh = round(prof["kwh_base"] * fac * growth, 1)
    chgrev = round(kwh * 0.42, 2)  # 元/kWh ≈ 0.42
    chgloss = round(kwh * 0.08, 2)
    chgchan = round(chgrev * 0.10, 2)
    rev = round(5300.0 * scale, 2)  # 非油收入 元
    nonoilgp = round(rev * 0.33, 2)
    # Fuel gross ≈ margin − discounts; margins ~590/450 CNY per ton.
    dis_total_gas = gas * 165.0
    dis_total_die = die * 135.0
    gasgp = round(gas * 590.0 - dis_total_gas, 2)
    nggp = round((lng + cng) * 810.0, 2)
    chggp = round((chgrev - chgloss - chgchan) / 1.13, 2)
    exp = round(rev * 0.055 + 1600.0 * scale, 2)
    tax = round((rev + chgrev) * 0.05 + gasgp * 0.03, 2)
    pay = round((gas + die + lng + cng) * 5.4 + nonoilgp * 0.075, 2)

    out = {
        "gas": gas,
        "die": die,
        "lng": lng,
        "cng": cng,
        "kwh": kwh,
        "rev": rev,
        "gasgp": gasgp,
        "nonoilgp": nonoilgp,
        "nggp": nggp,
        "chggp": chggp,
        "exp": exp,
        "tax": tax,
        "pay": pay,
        "chgrev": chgrev,
        "chgloss": chgloss,
        "chgchan": chgchan,
        "guns": prof["guns"],
        "chgguns": prof["chgguns"],
        "guntimes": round((gas + die) * 52 * fac, 0),
        "oilcust": round((gas + die) * 88 * fac, 0),
        "noncust": round(rev / 12.0, 0),
        "lossvol": round((gas + die) * 0.0011 * fac, 4),
        "invcost": round(rev * 6.1, 2),
        "excard": round(gas * 0.52 * fac, 3),
        "dcard": round(die * 0.45 * fac, 3),
        "deadsku": float(int(random.Random(f"dead|{unit_key}").uniform(30, 90))),
    }
    # Discount components per demo shares (fuel streams + non-oil split).
    for name, g_share, d_share in _DISCOUNT_SPLIT:
        out[f"{name}g"] = round(dis_total_gas * g_share, 2)
        out[f"{name}d"] = round(dis_total_die * d_share, 2)
    for name, share in _NON_DISCOUNT_SPLIT.items():
        out[f"{name}n"] = round(rev * 0.045 * share, 2)
    return {k: v for k, v in out.items() if not metric_keys or k in metric_keys}


def _leaf_keys() -> set[str]:
    units = _unit_rows()
    parents = {row["parent_key"] for row in units}
    return {row["unit_key"] for row in units if row["unit_key"] not in parents}


_BUDGET_METRICS = ("oil", "gas", "die", "kwh", "rev", "profit", "pay")


def _budget_rows(
    unit_keys: list[str], metric_keys: list[str], periods: list[str]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    leaves = _leaf_keys()
    for unit in unit_keys:
        if unit not in leaves:
            continue
        prof = _station_profile(unit)
        for period in periods:
            rng = random.Random(f"budget|{unit}|{period}")
            daily = {
                "oil": 24.5 * prof["scale"],
                "gas": 13.5 * prof["gas_share"] * prof["scale"],
                "die": 11.0 * (1 - prof["gas_share"]) * prof["scale"],
                "kwh": prof["kwh_base"],
                "rev": 5300.0 * prof["scale"],
                "profit": 21000.0 * prof["scale"],
                "pay": 420.0 * prof["scale"],
            }
            # YYYY-MM → 30-day budget; YYYY → year-to-date pace.
            days = (
                30
                if len(period) == 7
                else (dt.date.today() - dt.timedelta(days=1)).timetuple().tm_yday
            )
            for metric in _BUDGET_METRICS:
                if metric in metric_keys:
                    rows.append(
                        {
                            "unit_key": unit,
                            "period": period,
                            "metric_key": metric,
                            "value": round(daily[metric] * days * rng.uniform(0.95, 1.12), 2),
                        }
                    )
    return rows


# -------------------------------------------------------------------- MCP ----

mcp = FastMCP("amoeba-stub")


@mcp.tool()
def amoeba_units() -> dict[str, Any]:
    """Organization tree served by this stub."""
    return {"units": _unit_rows()}


@mcp.tool()
def amoeba_metrics_data(
    unit_keys: list[str],
    metric_keys: list[str],
    date_from: str,
    date_to: str,
) -> dict[str, Any]:
    """Daily raw metric rows for the requested units and window."""
    start = dt.date.fromisoformat(date_from)
    asof = dt.date.today() - dt.timedelta(days=1)
    end = min(dt.date.fromisoformat(date_to), asof)
    wanted = set(metric_keys)
    leaves = _leaf_keys()
    rows: list[dict[str, Any]] = []
    for unit in unit_keys:
        if unit not in leaves:
            continue  # facts live on leaf units only
        day = start
        while day <= end:
            for key, value in _rows_for(unit, day, wanted, asof).items():
                rows.append(
                    {"unit_key": unit, "date": day.isoformat(), "metric_key": key, "value": value}
                )
            day += dt.timedelta(days=1)
    return {"rows": rows}


@mcp.tool()
def amoeba_budgets(
    unit_keys: list[str], metric_keys: list[str], periods: list[str]
) -> dict[str, Any]:
    """Budget rows per unit / period / metric."""
    return {"rows": _budget_rows(unit_keys, metric_keys, periods)}


@mcp.tool()
def amoeba_meta() -> dict[str, Any]:
    """Freshness marker for the stub."""
    asof = dt.date.today() - dt.timedelta(days=1)
    return {"asof": asof.isoformat(), "source_name": "amoeba-stub"}


def main() -> None:
    global ORGANIZATION_DB
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--organization-db", type=Path)
    args = parser.parse_args()
    ORGANIZATION_DB = args.organization_db
    _unit_rows()
    print(f"[amoeba-stub] serving on http://{args.host}:{args.port}/mcp")
    mcp.settings.host = args.host
    mcp.settings.port = args.port
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
