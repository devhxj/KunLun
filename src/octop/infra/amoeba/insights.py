"""Board summary lines: LLM-generated with a rule-based fallback."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from octop.i18n import tr
from octop.infra.utils.llm_text import strip_thinking

logger = logging.getLogger(__name__)

_LLM_TIMEOUT_SECONDS = 25.0
_MAX_ITEMS = 5
_MAX_LINE_LEN = 200
# Only cards from these groups feed the rule-based summary.
_RULE_GROUPS = ("core", "profit", "pay")


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _metric_name(card: dict[str, Any], locale: str) -> str:
    name: str = card["name_zh"] if str(locale).startswith("zh") else card["name_en"]
    return name


def rule_insights(overview: dict[str, Any], *, locale: str, org_name: str) -> list[dict[str, Any]]:
    """Deterministic summary from budget attainment / deltas — zero-cost fallback."""
    items: list[dict[str, Any]] = []
    group_keys = {
        key
        for g in overview.get("groups", [])
        if g.get("category") in _RULE_GROUPS
        for key in g.get("metric_keys", [])
    }
    for key in sorted(group_keys):
        card = overview.get("metrics", {}).get(key)
        if not card:
            continue
        name = _metric_name(card, locale)
        value = card.get("dims", {}).get(overview.get("dim", "d"))
        budget_pct = card.get("budget_pct")
        delta_pct = card.get("delta_pct")
        unit = card.get("unit") or ""
        text: str | None = None
        if budget_pct is not None and budget_pct < 90:
            text = tr(
                "amoeba.insights.behindBudget",
                locale,
                name=name,
                value=_fmt(value),
                unit=unit,
                pct=_fmt(budget_pct),
            )
        elif budget_pct is not None and budget_pct >= 100:
            text = tr(
                "amoeba.insights.aheadBudget",
                locale,
                name=name,
                value=_fmt(value),
                unit=unit,
                pct=_fmt(budget_pct),
            )
        elif delta_pct is not None and delta_pct < 0:
            text = tr(
                "amoeba.insights.declining",
                locale,
                name=name,
                value=_fmt(value),
                unit=unit,
                pct=_fmt(delta_pct),
            )
        elif delta_pct is not None and delta_pct > 0:
            text = tr(
                "amoeba.insights.growing",
                locale,
                name=name,
                value=_fmt(value),
                unit=unit,
                pct=_fmt(delta_pct),
            )
        if text:
            items.append({"text": text, "source": "rule"})
        if len(items) >= _MAX_ITEMS:
            break
    if not items:
        return [{"text": tr("amoeba.insights.noSignal", locale, org=org_name), "source": "rule"}]
    return items


def _summary_prompt(overview: dict[str, Any], *, locale: str, org_name: str) -> str:
    lines: list[str] = [f"org: {org_name}", f"dim: {overview.get('dim')}", "metrics:"]
    for _key, card in overview.get("metrics", {}).items():
        if card.get("category") == "hidden":
            continue
        name = _metric_name(card, locale)
        value = card.get("dims", {}).get(overview.get("dim", "d"))
        parts = [f"{name}={_fmt(value)}{card.get('unit') or ''}"]
        if card.get("delta_pct") is not None:
            parts.append(f"delta={_fmt(card['delta_pct'])}%")
        if card.get("budget_pct") is not None:
            parts.append(f"budget={_fmt(card['budget_pct'])}%")
        lines.append(f"- {' '.join(parts)}")
    return "\n".join(lines)


def _parse_items(text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for raw in strip_thinking(text or "").splitlines():
        line = raw.strip().lstrip("-*•").strip()
        for marker in ("1.", "2.", "3.", "4.", "5."):
            if line.startswith(marker):
                line = line[len(marker) :].strip()
        if not line:
            continue
        if len(line) > _MAX_LINE_LEN:
            line = line[:_MAX_LINE_LEN]
        items.append({"text": line, "source": "llm"})
        if len(items) >= _MAX_ITEMS:
            break
    return items


async def build_insights(
    *,
    overview: dict[str, Any],
    locale: str,
    org_name: str,
    models: Any | None,
) -> list[dict[str, Any]]:
    """LLM summary over the rolled-up numbers; falls back to rule templates."""
    fallback = rule_insights(overview, locale=locale, org_name=org_name)
    if models is None:
        return fallback
    try:
        access = models.get(None)
        system = tr("amoeba.insights.system", locale)
        user = _summary_prompt(overview, locale=locale, org_name=org_name)
        result = await asyncio.wait_for(
            access.ainvoke_text(user, system=system, timeout_s=_LLM_TIMEOUT_SECONDS),
            timeout=_LLM_TIMEOUT_SECONDS,
        )
        items = _parse_items(result or "")
        return items or fallback
    except Exception:
        logger.info("amoeba LLM summary failed; using rule fallback", exc_info=True)
        return fallback


__all__ = ["build_insights", "rule_insights"]
