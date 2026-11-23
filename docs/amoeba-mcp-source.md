# Amoeba board MCP data source — interface standard

The amoeba board pulls its facts from an external **MCP server** (streamable
HTTP transport, `Authorization: Bearer <token>`). Octop owns the metric
catalog, the aggregation calibre and the presentation layer; the source only
serves **leaf-unit detail rows**. This document is the contract a conforming
source must implement.

Configuration lives in **Amoeba board → 看板管理 → MCP 数据源**
(`PUT /api/amoeba/source`): `url`, `token`, `sync_days` (history window,
default 400 days), `auto_sync` + `sync_schedule` (cron, default `0 3 * * *`).
`POST /api/amoeba/source/test` probes connectivity and tool availability;
`POST /api/amoeba/sync` runs a sync immediately.

## Tools

| Tool | Required | Purpose |
|------|----------|---------|
| `amoeba_units` | ✔ | Organization tree |
| `amoeba_metrics_data` | ✔ | Daily per-unit raw metric rows |
| `amoeba_budgets` | ✔ | Per-period budget rows |
| `amoeba_meta` | ✖ | Data freshness (`asof`) and source name |
| `amoeba_employees` | ✖ | Per-unit employee pay ranking (reserved) |

All tools respond with a single JSON **text content block**. Errors follow the
MCP protocol (`isError: true`); Octop maps any failure to
`AMOEBA_SYNC_FAILED`.

### `amoeba_units`

No arguments.

```json
{
  "units": [
    { "unit_key": "HB", "name": "湖北销售分公司", "parent_key": null },
    { "unit_key": "HB-WH", "name": "武汉城区阿米巴", "parent_key": "HB" },
    { "unit_key": "HB-WH-XC", "name": "雄楚大道站", "parent_key": "HB-WH" }
  ]
}
```

- `unit_key`: stable string id in the source system.
- `parent_key`: `null` for roots. The tree may be any depth; **fact rows are
  expected on leaf units** (see Calibre).
- Unit alignment: Octop stores the binding as `amoeba_unit_key` inside the
  matched department's profile. Matching order: existing binding → unique name
  match → create the department (under its mapped parent). After the first
  sync the departments tree and the board scope are one and the same.

### `amoeba_metrics_data`

```json
{
  "unit_keys": ["HB-WH-XC", "HB-WH-LY"],
  "metric_keys": ["gas", "die", "kwh", "rev"],
  "date_from": "2025-10-13",
  "date_to": "2026-11-13"
}
```

Response:

```json
{
  "rows": [
    { "unit_key": "HB-WH-XC", "date": "2026-11-11", "metric_key": "gas", "value": 210.565 },
    { "unit_key": "HB-WH-XC", "date": "2026-11-11", "metric_key": "die", "value": 122.823 }
  ]
}
```

- One row per `(unit_key, date, metric_key)`; a repeated row in a later sync
  **overwrites** the stored value (upsert semantics).
- `value` is a JSON number. Money in **yuan**, volumes in the unit declared by
  the metric catalog (吨 / kWh / 人 / 次 …).
- Rows may be paginated/limited by the server as long as one date window can
  be fetched with repeated calls; Octop treats a short response as complete
  for the window requested.
- Rows whose `unit_key` is not in `amoeba_units` are dropped and counted as
  `skipped_rows`.

### `amoeba_budgets`

```json
{
  "unit_keys": ["HB-WH-XC"],
  "metric_keys": ["gas", "oil"],
  "periods": ["2026-11", "2026"]
}
```

Response:

```json
{
  "rows": [
    { "unit_key": "HB-WH-XC", "period": "2026-11", "metric_key": "gas", "value": 6000 }
  ]
}
```

- `period` is `YYYY-MM` (monthly budget) or `YYYY` (yearly budget).
- Budgets are absolute values in the metric's unit, per leaf unit. Octop sums
  them up the tree the same way as facts.

### `amoeba_meta` (optional)

No arguments. `{ "asof": "2026-11-11", "source_name": "ERP-x" }`. When absent,
Octop derives `asof` from the newest synced snapshot date.

### `amoeba_employees` (optional, reserved)

`{ "unit_keys": [...], "date": "2026-11-11" }` →
`{ "rows": [{ "unit_key": "...", "name": "周伟", "value": 11200 }] }` — the
per-employee pay ranking. Reserved for the pay band; not yet rendered.

## Metric keys

The builtin gas-station template (38 raw keys) is seeded by Octop on first
sync; the source only needs to serve the keys that exist in its data. The
current raw key list (see `src/octop/infra/amoeba/builtin_metrics.py`) covers:
sales (`gas`, `die`, `lng`, `cng`, `kwh`), revenue (`rev`), gross profits
(`gasgp`, `nonoilgp`, `nggp`, `chggp`), expenses (`exp`, `tax`, `pay`),
charging (`chgrev`, `chgloss`, `chgchan`, `chgguns`), operations (`guns`,
`guntimes`, `oilcust`, `noncust`, `lossvol`, `invcost`, `excard`, `dcard`,
`deadsku`) and 14 discount components (`d1g` … `d9d`). Derived metrics
(`oil`, `dis`, `chgfee`, `invdays`, …) are computed on the Octop side — the
source never sends them.

Custom metrics can be added at runtime (`POST /api/amoeba/metrics`) with an
arithmetic formula over existing keys.

## Calibre (computed on the Octop side)

- **Roll-up**: facts belong on leaf units. Flow metrics (`agg: sum`) add
  values across dates and units. Snapshot metrics (`agg: last`), such as
  inventory value and fuel gun counts, take each leaf unit's latest value
  within the window and then sum those values across the subtree.
- **Ratios recomputed after roll-up** — per-unit ratio metrics are never
  averaged across units.
- **Dimensions**: `d` = the as-of day (compares to the previous day), `m` =
  month-to-date (compares to the period budget), `y` = year-to-date (compares
  to the same span last year).
- Formulas may reference the in-progress day count via `{{days}}`
  (e.g. `gunvol = oil/(guns*{{days}})`).

## Minimal reference server

```python
# pip install "mcp[cli]"
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("amoeba-source")

@mcp.tool()
def amoeba_units() -> dict:
    return {"units": [{"unit_key": "U1", "name": "一站", "parent_key": None}]}

@mcp.tool()
def amoeba_metrics_data(unit_keys: list[str], metric_keys: list[str],
                        date_from: str, date_to: str) -> dict:
    return {"rows": [...]}          # your detail rows

@mcp.tool()
def amoeba_budgets(unit_keys: list[str], metric_keys: list[str],
                   periods: list[str]) -> dict:
    return {"rows": [...]}

mcp.run(transport="streamable-http")  # serves /mcp
```

Point the board at the resulting URL (e.g. `http://host:8000/mcp`), set the
bearer token, hit **Test**, then **Sync now**.
