/**
 * Amoeba board — three-level BI dashboard.
 *
 * Left org tree (departments, data-scope filtered) + d/m/y dimension switcher.
 * Board payload comes from ``GET /api/amoeba/overview``: groups of metric
 * cards (core KPIs, categories, benefit, pay, discounts, ops) plus an
 * AI summary. Clicking a card opens the metric drawer (trend + leaf ranking).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Segmented,
  Spin,
  Table,
  Tag,
  Tree,
  Typography,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import {
  BarChart3,
  GitBranch,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import cx from "classnames";
import PageShell from "../../layouts/PageShell";
import {
  amoebaApi,
  type AmoebaDim,
  type AmoebaMetricCard,
  type AmoebaOverview,
  type AmoebaInsight,
  type AmoebaDepartmentNode,
} from "../../api/modules/amoeba";
import { useUserRole } from "../../hooks/useUserRole";
import MetricDrawer from "./MetricDrawer";
import AdminModal from "./AdminModal";
import {
  formatBudgetPct,
  formatDelta,
  formatMetricValue,
} from "./formatMetricValue";
import styles from "./index.module.less";

const DIM_OPTIONS = ["d", "m", "y"] as const;

interface TreeEntry extends AmoebaDepartmentNode {
  title: string;
  key: string;
  children: TreeEntry[];
}

function buildTree(
  departments: AmoebaDepartmentNode[],
  filter: string,
): { tree: TreeEntry[]; rootKeys: React.Key[] } {
  const byParent = new Map<string | null, AmoebaDepartmentNode[]>();
  for (const node of departments) {
    const list = byParent.get(node.parent_id) ?? [];
    list.push(node);
    byParent.set(node.parent_id, list);
  }
  const wanted = filter.trim().toLowerCase();
  const keep = new Set<string>();
  if (wanted) {
    for (const node of departments) {
      if (node.name.toLowerCase().includes(wanted)) {
        keep.add(node.department_id);
        let cursor = node.parent_id;
        while (cursor) {
          keep.add(cursor);
          cursor =
            departments.find((d) => d.department_id === cursor)?.parent_id ??
            null;
        }
      }
    }
  }
  const convert = (parent: string | null): TreeEntry[] =>
    (byParent.get(parent) ?? [])
      .filter((node) => !wanted || keep.has(node.department_id))
      .map((node) => {
        const children = convert(node.department_id);
        return {
          ...node,
          key: node.department_id,
          title: node.name,
          children,
        };
      });
  const tree = convert(null);
  return { tree, rootKeys: tree.map((n) => n.key) };
}

function useMetricName(locale: string): (card: AmoebaMetricCard) => string {
  return useCallback(
    (card: AmoebaMetricCard) =>
      locale.toLowerCase().startsWith("zh") ? card.name_zh : card.name_en,
    [locale],
  );
}

function DeltaTag({ card }: { card: AmoebaMetricCard }) {
  const { t } = useTranslation();
  if (card.delta_pct !== null && card.delta_pct !== undefined) {
    const positive = card.delta_pct > 0;
    return (
      <span className={cx(styles.delta, positive ? styles.up : styles.down)}>
        {positive ? "▲" : "▼"} {formatDelta(Math.abs(card.delta_pct))}
        <small>
          {" "}
          {card.delta_kind === "yoy" ? t("amoeba.yoy") : t("amoeba.mom")}
        </small>
      </span>
    );
  }
  if (card.budget_pct !== null && card.budget_pct !== undefined) {
    const positive = card.budget_pct >= 100;
    return (
      <span className={cx(styles.delta, positive ? styles.up : styles.down)}>
        {t("amoeba.budget")} {formatBudgetPct(card.budget_pct)}
      </span>
    );
  }
  return null;
}

function Sparkline({
  points,
}: {
  points: Array<{ date: string; value: number | null }>;
}) {
  const data = points.map((p) => ({
    date: p.date.slice(5),
    value: p.value ?? 0,
  }));
  if (data.length < 2) return null;
  return (
    <div className={styles.spark} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
        >
          <RechartsTooltip
            formatter={(v) => [Number(v ?? 0).toLocaleString("en-US")]}
            labelFormatter={(l) => String(l ?? "")}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--fn-color-brand)"
            fill="var(--fn-color-brand)"
            fillOpacity={0.12}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function KpiCard({
  card,
  dim,
  locale,
  onClick,
}: {
  card: AmoebaMetricCard;
  dim: AmoebaDim;
  locale: string;
  onClick: () => void;
}) {
  const nameOf = useMetricName(locale);
  const value = card.dims[dim];
  return (
    <button
      type="button"
      className={cx(styles.card, styles.kpi)}
      onClick={onClick}
    >
      <div className={styles.kpiTop}>
        <span className={styles.kpiLabel}>{nameOf(card)}</span>
        <DeltaTag card={card} />
      </div>
      <div className={styles.kpiValue}>
        {formatMetricValue(value, card.format, card.unit, locale)}
      </div>
      <div className={styles.kpiDims}>
        {DIM_OPTIONS.filter((d) => d !== dim).map((d) => (
          <span key={d} className={styles.kpiDim}>
            <small>{d === "d" ? "日" : d === "m" ? "月" : "年"}</small>
            {formatMetricValue(card.dims[d], card.format, "", locale)}
          </span>
        ))}
      </div>
      {card.spark.length > 1 && <Sparkline points={card.spark} />}
    </button>
  );
}

function MetricTile({
  card,
  dim,
  locale,
  onClick,
}: {
  card: AmoebaMetricCard;
  dim: AmoebaDim;
  locale: string;
  onClick: () => void;
}) {
  const nameOf = useMetricName(locale);
  return (
    <button type="button" className={styles.card} onClick={onClick}>
      <div className={styles.tileLabel}>{nameOf(card)}</div>
      <div className={styles.tileValue}>
        {formatMetricValue(card.dims[dim], card.format, card.unit, locale)}
      </div>
      <DeltaTag card={card} />
    </button>
  );
}

function SummaryCards({ items }: { items: AmoebaInsight[] }) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <Sparkles size={14} />
        {t("amoeba.summary.title")}
      </h3>
      <div className={styles.summaryGrid}>
        {items.map((item, idx) => (
          <div key={idx} className={styles.summaryCard}>
            <Typography.Text type="secondary" className={styles.summarySource}>
              {item.source === "llm" ? "AI" : t("amoeba.summary.rule")}
            </Typography.Text>
            <p>{item.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function AmoebaPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language ?? "en";
  const role = useUserRole();
  const isAdmin = role === "admin";

  const [tree, setTree] = useState<AmoebaDepartmentNode[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [dept, setDept] = useState<string | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [dim, setDim] = useState<AmoebaDim>("d");
  const [overview, setOverview] = useState<AmoebaOverview | null>(null);
  const [insights, setInsights] = useState<AmoebaInsight[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState<React.Key[] | null>(null);

  const loadTree = useCallback(async () => {
    try {
      const data = await amoebaApi.tree();
      setTree(data.departments);
      setRestricted(data.restricted);
    } catch (exc) {
      setError(String(exc));
    }
  }, []);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, summary] = await Promise.all([
        amoebaApi.overview({ dept, dim }),
        amoebaApi
          .summary({ dept, dim })
          .catch(() => ({ items: [] as AmoebaInsight[] })),
      ]);
      setOverview(data);
      setInsights(summary.items ?? []);
    } catch (exc) {
      setError(String(exc));
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [dept, dim]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const { tree: treeData, rootKeys } = useMemo(
    () => buildTree(tree, treeFilter),
    [tree, treeFilter],
  );

  const nameOf = useMetricName(locale);
  const deptName = useMemo(
    () => tree.find((d) => d.department_id === dept)?.name ?? "",
    [tree, dept],
  );

  const discountRows = useMemo(() => {
    if (!overview) return [];
    const group = overview.groups.find((g) => g.category === "discount");
    if (!group) return [];
    return group.metric_keys
      .filter(
        (key) =>
          key.startsWith("dis") &&
          key !== "dis_gas" &&
          key !== "dis_die" &&
          key !== "dis_non",
      )
      .map((key) => overview.metrics[key])
      .filter(Boolean);
  }, [overview]);

  const renderGroup = (category: string, keys: string[]) => {
    if (!overview) return null;
    const cards = keys.map((key) => overview.metrics[key]).filter(Boolean);
    if (!cards.length) return null;
    const isCore = category === "core";
    return (
      <section className={styles.section} key={category}>
        <h3 className={styles.sectionTitle}>
          <BarChart3 size={14} />
          {t(`amoeba.categories.${category}`, { defaultValue: category })}
        </h3>
        {category === "discount" && discountRows.length > 0 ? (
          <div className={styles.discountLayout}>
            <div className={styles.tileGrid}>
              {cards
                .filter(
                  (c) =>
                    !discountRows.some((r) => r.metric_key === c.metric_key),
                )
                .map((card) => (
                  <MetricTile
                    key={card.metric_key}
                    card={card}
                    dim={dim}
                    locale={locale}
                    onClick={() => setDrawerKey(card.metric_key)}
                  />
                ))}
            </div>
            <Table
              size="small"
              rowKey="metric_key"
              pagination={false}
              dataSource={discountRows}
              columns={[
                {
                  title: t("amoeba.discount.item"),
                  dataIndex: "metric_key",
                  render: (_v, record: AmoebaMetricCard) => nameOf(record),
                },
                {
                  title: t(`amoeba.dim.${dim}`),
                  dataIndex: "dims",
                  align: "right",
                  render: (_v, record: AmoebaMetricCard) =>
                    formatMetricValue(
                      record.dims[dim],
                      record.format,
                      "",
                      locale,
                    ),
                },
                {
                  title: t("amoeba.budget"),
                  dataIndex: "budget_pct",
                  align: "right",
                  render: (v: number | null) =>
                    v === null || v === undefined ? "—" : formatBudgetPct(v),
                },
                {
                  title: t("amoeba.discount.rule"),
                  dataIndex: "note_zh",
                  render: (_v, record: AmoebaMetricCard) => (
                    <Tag>
                      {locale.toLowerCase().startsWith("zh")
                        ? record.note_zh
                        : record.note_en}
                    </Tag>
                  ),
                },
              ]}
            />
          </div>
        ) : (
          <div className={cx(isCore ? styles.kpiGrid : styles.tileGrid)}>
            {cards.map((card) =>
              isCore ? (
                <KpiCard
                  key={card.metric_key}
                  card={card}
                  dim={dim}
                  locale={locale}
                  onClick={() => setDrawerKey(card.metric_key)}
                />
              ) : (
                <MetricTile
                  key={card.metric_key}
                  card={card}
                  dim={dim}
                  locale={locale}
                  onClick={() => setDrawerKey(card.metric_key)}
                />
              ),
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <PageShell
      title={t("pageShell.amoeba.title")}
      subtitle={t("pageShell.amoeba.subtitle")}
      fill
      actions={
        <>
          {isAdmin && (
            <Button
              icon={<Settings2 size={14} />}
              onClick={() => setAdminOpen(true)}
            >
              {t("amoeba.admin.title")}
            </Button>
          )}
          <Button
            icon={<RefreshCw size={14} />}
            onClick={() => {
              void loadBoard();
              void loadTree();
            }}
          >
            {t("common.refresh")}
          </Button>
        </>
      }
    >
      <div className={styles.page}>
        <div className={styles.toolbar}>
          <Segmented
            value={dim}
            onChange={(v) => setDim(v as AmoebaDim)}
            options={DIM_OPTIONS.map((d) => ({
              value: d,
              label: t(`amoeba.dim.${d}`),
            }))}
          />
          {overview?.asof && (
            <span className={styles.asof}>
              {t("amoeba.asof", { date: overview.asof })}
            </span>
          )}
          {deptName && (
            <span className={styles.scopeTag}>
              <GitBranch size={12} /> {deptName}
            </span>
          )}
        </div>

        {error && (
          <Alert
            type="error"
            showIcon
            className={styles.alert}
            message={error}
          />
        )}
        {restricted && (
          <Alert
            type="info"
            showIcon
            className={styles.alert}
            message={t("amoeba.restricted")}
          />
        )}

        <div className={styles.layout}>
          <aside className={styles.treePanel}>
            <Input.Search
              size="small"
              allowClear
              placeholder={t("amoeba.tree.search")}
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
            />
            <div className={styles.allItem}>
              <button
                type="button"
                className={cx(!dept && styles.allItemActive)}
                onClick={() => setDept(null)}
              >
                {t("amoeba.tree.all")}
              </button>
            </div>
            {treeData.length ? (
              <Tree
                blockNode
                showLine={{ showLeafIcon: false }}
                treeData={treeData as unknown as DataNode[]}
                expandedKeys={treeExpanded ?? rootKeys}
                onExpand={(keys) => setTreeExpanded(keys)}
                selectedKeys={dept ? [dept] : []}
                onSelect={(keys) =>
                  setDept(keys.length ? String(keys[0]) : null)
                }
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("amoeba.tree.empty")}
              />
            )}
          </aside>

          <div className={styles.content}>
            {loading && !overview ? (
              <div className={styles.center}>
                <Spin />
              </div>
            ) : !overview || !overview.asof ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("amoeba.empty")}
                className={styles.center}
              />
            ) : (
              <>
                {overview.groups.map((g) =>
                  renderGroup(g.category, g.metric_keys),
                )}
                <SummaryCards items={insights} />
              </>
            )}
          </div>
        </div>
      </div>

      <MetricDrawer
        metricKey={drawerKey}
        dept={dept}
        dim={dim}
        locale={locale}
        onClose={() => setDrawerKey(null)}
      />
      <AdminModal
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        onSynced={() => {
          void loadTree();
          void loadBoard();
        }}
      />
    </PageShell>
  );
}
