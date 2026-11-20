"""MCP client for the amoeba data source (the interface this package defines).

A conforming source is a streamable-HTTP MCP server that implements:

* ``amoeba_units``                      → organization tree (unit_key/name/parent_key)
* ``amoeba_metrics_data``               → daily per-unit raw metric rows
* ``amoeba_budgets``                    → per-period budget rows
* ``amoeba_meta`` (optional)            → {asof, source_name}
* ``amoeba_employees`` (optional)       → per-unit employee pay ranking

See ``docs/amoeba-mcp-source.md`` for the full contract. All aggregation and
derived-metric evaluation happens on the Octop side; the source only serves
leaf-unit detail rows.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from octop.infra.errors import ErrorCode, OctopError

logger = logging.getLogger(__name__)

TOOL_UNITS = "amoeba_units"
TOOL_METRICS = "amoeba_metrics_data"
TOOL_BUDGETS = "amoeba_budgets"
TOOL_META = "amoeba_meta"
TOOL_EMPLOYEES = "amoeba_employees"
REQUIRED_TOOLS = (TOOL_UNITS, TOOL_METRICS, TOOL_BUDGETS)

_TIMEOUT_SECONDS = 60.0


def _validate_url(url: str) -> str:
    url = url.strip()
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.netloc or parts.username:
        raise OctopError(ErrorCode.SLASH_BAD_ARGS, "invalid amoeba source url")
    return url


async def _call_tool(url: str, token: str, name: str, arguments: dict[str, Any]) -> Any:
    url = _validate_url(url)
    async with (
        httpx.AsyncClient(
            headers={"Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=False,
        ) as client,
        streamable_http_client(url, http_client=client) as (read, write, _),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        result = await session.call_tool(name, arguments)
        payload = result.model_dump(mode="json", by_alias=True, exclude_none=True)
    if payload.get("isError"):
        raise OctopError(
            ErrorCode.AMOEBA_SYNC_FAILED,
            f"source tool {name} returned an error: {json.dumps(payload)[:200]}",
        )
    text = _first_text(payload.get("content"))
    if text is None:
        raise OctopError(
            ErrorCode.AMOEBA_SYNC_FAILED, f"source tool {name} returned no text content"
        )
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise OctopError(
            ErrorCode.AMOEBA_SYNC_FAILED, f"source tool {name} returned non-JSON content"
        ) from exc


def _first_text(content: Any) -> str | None:
    if not isinstance(content, list):
        return None
    for part in content:
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
            return str(part["text"])
    return None


async def probe_source(url: str, token: str) -> dict[str, Any]:
    """Connect and verify the required tools exist. Never raises OctopError."""
    try:
        url = _validate_url(url)
    except OctopError as exc:
        return {"ok": False, "error": exc.message}
    try:
        async with (
            httpx.AsyncClient(
                headers={"Authorization": f"Bearer {token}"},
                timeout=30.0,
                follow_redirects=False,
                trust_env=False,
            ) as client,
            streamable_http_client(url, http_client=client) as (read, write, _),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            page = await session.list_tools()
            names = sorted(tool.name for tool in page.tools)
        missing = [t for t in REQUIRED_TOOLS if t not in names]
        return {"ok": not missing, "tools": names, "missing": missing}
    except Exception as exc:
        logger.info("amoeba source probe failed: %s", exc)
        return {"ok": False, "error": str(exc)}


async def fetch_units(url: str, token: str) -> list[dict[str, Any]]:
    data = await _call_tool(url, token, TOOL_UNITS, {})
    units = data.get("units") if isinstance(data, dict) else None
    if not isinstance(units, list):
        raise OctopError(ErrorCode.AMOEBA_SYNC_FAILED, "amoeba_units must return {units: [...]}")
    return units


async def fetch_metrics_data(
    url: str,
    token: str,
    *,
    unit_keys: list[str],
    metric_keys: list[str],
    date_from: str,
    date_to: str,
) -> list[dict[str, Any]]:
    data = await _call_tool(
        url,
        token,
        TOOL_METRICS,
        {
            "unit_keys": unit_keys,
            "metric_keys": metric_keys,
            "date_from": date_from,
            "date_to": date_to,
        },
    )
    rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise OctopError(
            ErrorCode.AMOEBA_SYNC_FAILED, "amoeba_metrics_data must return {rows: [...]}"
        )
    return rows


async def fetch_budgets(
    url: str,
    token: str,
    *,
    unit_keys: list[str],
    metric_keys: list[str],
    periods: list[str],
) -> list[dict[str, Any]]:
    data = await _call_tool(
        url,
        token,
        TOOL_BUDGETS,
        {"unit_keys": unit_keys, "metric_keys": metric_keys, "periods": periods},
    )
    rows = data.get("rows") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise OctopError(ErrorCode.AMOEBA_SYNC_FAILED, "amoeba_budgets must return {rows: [...]}")
    return rows


async def fetch_meta(url: str, token: str) -> dict[str, Any] | None:
    """Optional tool; returns None when the source does not expose it."""
    try:
        data = await _call_tool(url, token, TOOL_META, {})
    except OctopError:
        return None
    return data if isinstance(data, dict) else None


__all__ = [
    "REQUIRED_TOOLS",
    "TOOL_BUDGETS",
    "TOOL_EMPLOYEES",
    "TOOL_META",
    "TOOL_METRICS",
    "TOOL_UNITS",
    "fetch_budgets",
    "fetch_meta",
    "fetch_metrics_data",
    "fetch_units",
    "probe_source",
]
