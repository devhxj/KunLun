import { request, requestBlob, requestUpload } from "../request";
import type { ResourceVisibilityMode } from "./userGroups";

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
  // Day-over-day change, monthly budget attainment and year-over-year change.
  comparisons?: Partial<Record<AmoebaDim, number | null>>;
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
  comparison?: {
    metric_keys: string[];
    rows: Array<{
      department_id: string;
      name: string;
      values: Partial<Record<string, number | null>>;
    }>;
  };
}

export interface AmoebaMetricDetail {
  metric: AmoebaMetricCard;
  trend: Array<{ date: string; value: number | null }>;
  ranking: Array<{ department_id: string; name: string; value: number }>;
}

export type AmoebaInsightLevel = "risk" | "warn" | "opp" | "info";

export interface AmoebaInsight {
  level: AmoebaInsightLevel;
  title: string;
  evidence: string;
  action: string;
  source: "rule" | "llm";
}

export interface AmoebaNarrative {
  lead: string;
  items: AmoebaInsight[];
}

export interface AmoebaLeafRow {
  department_id: string;
  name: string;
  value: number;
  delta_pct: number | null;
  share: number | null;
}

export interface AmoebaStatus {
  asof: string;
  source_name?: string;
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

export interface AmoebaSharedBoard {
  id: string;
  filename: string;
  created_at: number;
  can_withdraw: boolean;
  visibility: ResourceVisibilityMode;
  group_ids: string[];
}

export type AmoebaBoardAudience = Pick<
  AmoebaSharedBoard,
  "visibility" | "group_ids"
>;

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
  sharedBoards: (mine = false) =>
    request<AmoebaSharedBoard[]>(
      `${path}/shared-boards${mine ? "?mine=1" : ""}`,
    ),
  boardGroups: () =>
    request<Array<{ id: string; name: string }>>(
      `${path}/shared-boards/groups`,
    ),
  readSharedBoard: (id: string, signal?: AbortSignal) =>
    requestBlob(`${path}/shared-boards/${encodeURIComponent(id)}`, { signal }),
  shareBoard: (file: Blob, filename: string, audience: AmoebaBoardAudience) => {
    const form = new FormData();
    form.append("file", file, filename);
    form.append("visibility", audience.visibility);
    audience.group_ids.forEach((id) => form.append("group_ids", id));
    return requestUpload<AmoebaSharedBoard>(`${path}/shared-boards`, form);
  },
  replaceBoard: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return requestUpload<AmoebaSharedBoard>(
      `${path}/shared-boards/${encodeURIComponent(id)}/file`,
      form,
      { method: "PUT" },
    );
  },
  updateBoardAudience: (id: string, audience: AmoebaBoardAudience) =>
    request<AmoebaSharedBoard>(
      `${path}/shared-boards/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(audience),
      },
    ),
  deleteBoard: (id: string) =>
    request<void>(`${path}/shared-boards/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  tree: () => request<AmoebaTree>(`${path}/tree`),
  overview: (opts: {
    dept?: string | null;
    dim: AmoebaDim;
    includeComparison?: boolean;
  }) =>
    request<AmoebaOverview>(
      `${path}/overview${qs({
        dept: opts.dept,
        dim: opts.dim,
        include_comparison: opts.includeComparison ? 1 : undefined,
      })}`,
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
    request<AmoebaNarrative>(
      `${path}/summary${qs({ dept: opts.dept, dim: opts.dim })}`,
    ),
  leaves: (opts: { metric: string; dept?: string | null; dim: AmoebaDim }) =>
    request<{ rows: AmoebaLeafRow[] }>(
      `${path}/leaves${qs({
        metric: opts.metric,
        dept: opts.dept,
        dim: opts.dim,
      })}`,
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
