import { describe, expect, it } from "vitest";
import {
  formatBudgetPct,
  formatDelta,
  formatMetricValue,
  formatMoney,
} from "./formatMetricValue";

describe("formatMetricValue", () => {
  it("renders missing values as a dash", () => {
    expect(formatMetricValue(null, "number", "吨")).toBe("—");
    expect(formatMetricValue(undefined, "money", "元")).toBe("—");
  });

  it("formats percents with one decimal", () => {
    expect(formatMetricValue(12.34, "percent", "%")).toBe("12.3%");
  });

  it("adapts money units to the magnitude (zh)", () => {
    expect(formatMoney(76369.789, "zh")).toBe("7.6 万");
    expect(formatMoney(1539000, "zh")).toBe("153.9 万");
    expect(formatMoney(120000000, "zh")).toBe("1.2 亿");
    expect(formatMoney(980.5, "zh")).toBe("980.5");
  });

  it("appends units to plain numbers", () => {
    expect(formatMetricValue(5024, "number", "吨")).toBe("5,024 吨");
    expect(formatMetricValue(358.8, "number", "kWh")).toBe("358.8 kWh");
  });
});

describe("formatDelta / formatBudgetPct", () => {
  it("signs deltas and keeps null empty", () => {
    expect(formatDelta(1.24)).toBe("+1.24%");
    expect(formatDelta(-3.5)).toBe("-3.50%");
    expect(formatDelta(null)).toBe("");
  });

  it("formats budget attainment", () => {
    expect(formatBudgetPct(99.62)).toBe("99.6%");
    expect(formatBudgetPct(null)).toBe("");
  });
});
