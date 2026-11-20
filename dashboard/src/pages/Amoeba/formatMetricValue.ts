/**
 * Value formatting for amoeba board cards.
 *
 * Money amounts are stored in yuan and rendered adaptively (亿 / 万 / yuan for
 * zh, B / M equivalents kept as 万-style compact numbers for en). Percent
 * values arrive as numbers already scaled by 100.
 */

export function formatMetricValue(
  value: number | null | undefined,
  format: string,
  unit: string,
  locale = "en",
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (format === "percent") return `${value.toFixed(1)}%`;
  if (format === "money") return formatMoney(value, locale);
  return `${formatNumber(value)}${unit ? ` ${unit}` : ""}`;
}

export function formatMoney(value: number, locale = "en"): string {
  const abs = Math.abs(value);
  if (abs >= 1e8)
    return `${trim(value / 1e8, 2)} ${locale.startsWith("zh") ? "亿" : "B"}`;
  if (abs >= 1e4)
    return `${trim(value / 1e4, 1)} ${locale.startsWith("zh") ? "万" : "w"}`;
  return formatNumber(value);
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return trim(value, 2);
}

export function formatDelta(deltaPct: number | null | undefined): string {
  if (deltaPct === null || deltaPct === undefined || Number.isNaN(deltaPct))
    return "";
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct.toFixed(2)}%`;
}

export function formatBudgetPct(budgetPct: number | null | undefined): string {
  if (budgetPct === null || budgetPct === undefined || Number.isNaN(budgetPct))
    return "";
  return `${budgetPct.toFixed(1)}%`;
}

function trim(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
}
