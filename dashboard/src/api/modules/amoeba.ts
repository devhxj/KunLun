import { request } from "../request";

export type AmoebaDim = "d" | "m" | "y";

export interface AmoebaDepartmentNode {
  department_id: string;
  parent_id: string | null;
  name: string;
}

export interface AmoebaTree {
  departments: AmoebaDepartmentNode[];
  restricted: boolean;
}

export interface AmoebaMetricCard {
  metric_key: string;
  category: string;
  sort: number;
  name_zh: string;
  name_en: string;
  unit: string;
  format: string;
  color: string;
  note_zh: string;
  note_en: string;
  formula: string;
  dims: Partial<Record<AmoebaDim, number | null>>;
  delta_pct: number | null;
  delta_kind: "mom" | "yoy" | null;
  budget_value: number | null;
  budget_pct: number | null;
  spark: Array<{ date: string; value: number | null }>;
}

export interface AmoebaOverview {
  asof: string | null;
  dim: AmoebaDim;
  period_days: number;
  groups: Array<{ category: string; metric_keys: string[] }>;
  metrics: Record<string, AmoebaMetricCard>;
}

export interface AmoebaMetricDetail {
  metric: AmoebaMetricCard;
  trend: Array<{ date: string; value: number | null }>;
  ranking: Array<{ department_id: string; name: string; value: number }>;
}

export interface AmoebaInsight {
  text: string;
  source: "rule" | "llm";
}

export interface AmoebaStatus {
  asof: string;
  last_sync_at: number | null;
  last_sync_at_age_s: number | null;
  source_configured: boolean;
}

export interface AmoebaSourceConfig {
  enabled: boolean;
  url: string;
  token_set: boolean;
  configured: boolean;
  sync_days: number;
  auto_sync: boolean;
  sync_schedule: string;
}

export interface AmoebaMetricAdmin {
  metric_key: string;
  name_zh: string;
  name_en: string;
  unit: string;
  category: string;
  formula: string;
  note_zh: string;
  note_en: string;
  format: string;
  color: string;
  sort: number;
  enabled: boolean;
  builtin: boolean;
}

const path = "/amoeba";

function qs(
  params: Record<string, string | number | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const amoebaApi = {
  tree: () => request<AmoebaTree>(`${path}/tree`),
  overview: (opts: { dept?: string | null; dim: AmoebaDim }) =>
    request<AmoebaOverview>(
      `${path}/overview${qs({ dept: opts.dept, dim: opts.dim })}`,
    ),
  metricDetail: (
    metricKey: string,
    opts: { dept?: string | null; dim: AmoebaDim },
  ) =>
    request<AmoebaMetricDetail>(
      `${path}/metrics/${encodeURIComponent(metricKey)}${qs({
        dept: opts.dept,
        dim: opts.dim,
      })}`,
    ),
  summary: (opts: { dept?: string | null; dim: AmoebaDim }) =>
    request<{ items: AmoebaInsight[] }>(
      `${path}/summary${qs({ dept: opts.dept, dim: opts.dim })}`,
    ),
  status: () => request<AmoebaStatus>(`${path}/status`),
  getSource: () => request<AmoebaSourceConfig>(`${path}/source`),
  saveSource: (body: Partial<AmoebaSourceConfig> & { token?: string }) =>
    request<AmoebaSourceConfig>(`${path}/source`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testSource: (body: { url?: string | null; token?: string | null }) =>
    request<{
      ok: boolean;
      tools?: string[];
      missing?: string[];
      error?: string;
    }>(`${path}/source/test`, { method: "POST", body: JSON.stringify(body) }),
  sync: () =>
    request<{
      units: number;
      snapshot_rows: number;
      budget_rows: number;
      asof: string;
    }>(`${path}/sync`, { method: "POST", body: JSON.stringify({}) }),
  listMetrics: () =>
    request<{ metrics: AmoebaMetricAdmin[] }>(`${path}/metrics`),
  createMetric: (body: Partial<AmoebaMetricAdmin>) =>
    request<{ metric_key: string }>(`${path}/metrics`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchMetric: (metricKey: string, body: Partial<AmoebaMetricAdmin>) =>
    request<{ metric_key: string }>(
      `${path}/metrics/${encodeURIComponent(metricKey)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  deleteMetric: (metricKey: string) =>
    request<{ metric_key: string; deleted?: boolean; disabled?: boolean }>(
      `${path}/metrics/${encodeURIComponent(metricKey)}`,
      { method: "DELETE" },
    ),
  getBindings: (userId: number) =>
    request<{ user_id: number; department_ids: string[] }>(
      `${path}/bindings${qs({ user_id: userId })}`,
    ),
  saveBindings: (userId: number, departmentIds: string[]) =>
    request<{ user_id: number; department_ids: string[] }>(`${path}/bindings`, {
      method: "PUT",
      body: JSON.stringify({ user_id: userId, department_ids: departmentIds }),
    }),
};
