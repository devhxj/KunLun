import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Progress,
  Segmented,
  Select,
  Spin,
  Table,
  Tag,
  Tree,
} from "antd";
import type { DataNode } from "antd/es/tree";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowUpRight,
  Coins,
  GitBranch,
  MapPin,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import cx from "classnames";
import {
  amoebaApi,
  type AmoebaDepartmentNode,
  type AmoebaDim,
  type AmoebaInsight,
  type AmoebaInsightLevel,
  type AmoebaLeafRow,
  type AmoebaMetricCard,
  type AmoebaNarrative,
  type AmoebaOverview,
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

const WALL_METRICS = ["oil", "kwh", "rev", "profit", "dis"] as const;
const COMPARISON_LABELS = {
  d: "amoeba.mom",
  m: "amoeba.budget",
  y: "amoeba.yoy",
} as const;
const METRIC_COLORS: Record<string, string> = {
  amber: "amber",
  cy: "cyan",
  mint: "mint",
  purple: "purple",
  yellow: "yellow",
  red: "red",
  blue: "blue",
};
const SECTION_COLORS: Record<string, string> = {
  core: "cyan",
  category: "blue",
  profit: "yellow",
  pay: "amber",
  discount: "red",
  ops: "mint",
  ai: "purple",
  trend: "blue",
  wall: "mint",
};

function metricStyle(color: string | undefined): CSSProperties {
  return {
    "--metric-accent": color ? `var(--metric-${color})` : "var(--board-accent)",
  } as CSSProperties;
}

/* ------------------------------------------------------------------ tree -- */

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
      .map((node) => ({
        ...node,
        key: node.department_id,
        title: node.name,
        children: convert(node.department_id),
      }));
  const tree = convert(null);
  return { tree, rootKeys: tree.map((n) => n.key) };
}

/* ------------------------------------------------------------- fragments -- */

function useLocaleName() {
  const { i18n } = useTranslation();
  const locale = i18n.language ?? "en";
  return useCallback(
    (card: AmoebaMetricCard) =>
      locale.toLowerCase().startsWith("zh") ? card.name_zh : card.name_en,
    [locale],
  );
}

function useLocaleNote() {
  const { i18n } = useTranslation();
  const locale = i18n.language ?? "en";
  return useCallback(
    (card: AmoebaMetricCard) =>
      locale.toLowerCase().startsWith("zh") ? card.note_zh : card.note_en,
    [locale],
  );
}

function DeltaTag({ card }: { card: AmoebaMetricCard }) {
  const { t } = useTranslation();
  if (card.delta_pct !== null && card.delta_pct !== undefined) {
    const direction =
      card.delta_pct > 0 ? "up" : card.delta_pct < 0 ? "down" : null;
    return (
      <span className={cx(styles.delta, direction && styles[direction])}>
        {direction === "up" ? "↑ " : direction === "down" ? "↓ " : ""}
        {formatDelta(card.delta_pct)}
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

function PeriodComparison({
  card,
  period,
}: {
  card: AmoebaMetricCard;
  period: AmoebaDim;
}) {
  const { t } = useTranslation();
  const value = card.comparisons?.[period];
  return (
    <span
      className={cx(
        styles.periodComparison,
        value != null &&
          (period === "m" ? value >= 100 : value >= 0) &&
          styles.up,
        value != null &&
          (period === "m" ? value < 100 : value < 0) &&
          styles.down,
      )}
    >
      {t(COMPARISON_LABELS[period])}{" "}
      {period === "m"
        ? formatBudgetPct(value) || "—"
        : formatDelta(value) || "—"}
    </span>
  );
}

/** Signed mini bar around a center axis: left = negative, right = positive. */
function DeltaBar({ pct }: { pct: number | null }) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) {
    return <span className={styles.deltaBarEmpty}>—</span>;
  }
  const clamped = Math.max(-50, Math.min(50, pct));
  const width = Math.abs(clamped) / 50;
  const negative = clamped < 0;
  return (
    <span className={styles.deltaBar} title={formatDelta(pct)}>
      <i
        className={cx(negative ? styles.deltaBarNeg : styles.deltaBarPos)}
        style={{ width: `${width * 50}%` }}
      />
    </span>
  );
}

/* ------------------------------------------------------------- card kinds -- */

function KpiCard({
  card,
  dim,
  nameOf,
  note,
  locale,
  onClick,
}: {
  card: AmoebaMetricCard;
  dim: AmoebaDim;
  nameOf: (c: AmoebaMetricCard) => string;
  note: string;
  locale: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const compactNumber = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumSignificantDigits: 3,
    useGrouping: false,
  });
  const formatSecondary = (value: number | null | undefined) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    card.format !== "percent"
      ? compactNumber.format(value)
      : formatMetricValue(value, card.format, "", locale);
  return (
    <button
      type="button"
      className={cx(styles.card, styles.kpi)}
      style={metricStyle(METRIC_COLORS[card.color])}
      onClick={onClick}
    >
      <div className={styles.kpiTop}>
        <span className={styles.kpiLabel}>{nameOf(card)}</span>
        {note && (
          <span className={styles.kpiHint} title={note}>
            {note}
          </span>
        )}
        <ArrowUpRight size={14} aria-hidden />
      </div>
      <div className={styles.kpiMain}>
        <b title={formatMetricValue(card.dims[dim], card.format, "", locale)}>
          {formatMetricValue(card.dims[dim], card.format, "", locale)}
        </b>
        <small>{card.unit}</small>
        {card.comparisons ? (
          <PeriodComparison card={card} period={dim} />
        ) : (
          <DeltaTag card={card} />
        )}
      </div>
      <div className={styles.kpiPeriods}>
        {DIM_OPTIONS.filter((period) => period !== dim).map((period) => (
          <span key={period}>
            <small>{t(`amoeba.dim.${period}`)}</small>
            <b
              title={formatMetricValue(
                card.dims[period],
                card.format,
                "",
                locale,
              )}
            >
              {formatSecondary(card.dims[period])}
            </b>
            {card.comparisons && (
              <PeriodComparison card={card} period={period} />
            )}
          </span>
        ))}
      </div>
      {card.spark.some((point) => point.value !== null) && (
        <div className={styles.microTrend} aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={card.spark}>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Area
                dataKey="value"
                type="monotone"
                stroke="var(--metric-accent)"
                fill="var(--metric-accent)"
                fillOpacity={0.13}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </button>
  );
}

function TriCard({
  card,
  dim,
  nameOf,
  locale,
  note,
  color,
  onClick,
}: {
  card: AmoebaMetricCard;
  dim: AmoebaDim;
  nameOf: (c: AmoebaMetricCard) => string;
  locale: string;
  note?: string;
  color?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumSignificantDigits: 3,
    useGrouping: false,
  });
  return (
    <button
      type="button"
      className={cx(styles.card, styles.triCard)}
      style={metricStyle(METRIC_COLORS[card.color] ?? color)}
      onClick={onClick}
    >
      <div className={styles.triLabel}>
        <span title={note}>{nameOf(card)}</span>
        <small>{card.unit}</small>
      </div>
      <div className={styles.triCells}>
        {DIM_OPTIONS.map((d) => {
          const value = card.dims[d];
          const full = formatMetricValue(value, card.format, "", locale);
          return (
            <span
              key={d}
              className={cx(styles.triCell, d === dim && styles.triCellActive)}
            >
              <small>{t(`amoeba.dim.${d}`)}</small>
              <b title={full}>
                {typeof value === "number" &&
                Number.isFinite(value) &&
                card.format !== "percent"
                  ? compact.format(value)
                  : full}
              </b>
              {card.comparisons && <PeriodComparison card={card} period={d} />}
            </span>
          );
        })}
      </div>
      {!card.comparisons && <DeltaTag card={card} />}
    </button>
  );
}

function PayBand({
  cards,
  locale,
  onOpen,
}: {
  cards: Record<string, AmoebaMetricCard | undefined>;
  locale: string;
  onOpen: (key: string) => void;
}) {
  const { t } = useTranslation();
  const pay = cards.pay;
  const oilPay = cards.oilPay;
  const nonPay = cards.nonPay;
  if (!pay && !oilPay && !nonPay) return null;
  return (
    <div className={styles.payBand}>
      <div className={styles.paySlogan}>
        <Coins size={14} />
        {t("amoeba.pay.slogan")}
      </div>
      <div className={styles.payCells}>
        {pay && (
          <button
            type="button"
            className={styles.payMain}
            onClick={() => onOpen("pay")}
          >
            <small>{t("amoeba.pay.monthPayout")}</small>
            <b>{formatMetricValue(pay.dims.m, pay.format, "", locale)}</b>
            <span className={styles.paySub}>
              {t("amoeba.pay.today")}{" "}
              {formatMetricValue(pay.dims.d, pay.format, "", locale)} ·{" "}
              {t("amoeba.pay.yearTotal")}{" "}
              {formatMetricValue(pay.dims.y, pay.format, "", locale)}
            </span>
          </button>
        )}
        {oilPay && (
          <button
            type="button"
            className={styles.payCell}
            onClick={() => onOpen("oilPay")}
          >
            <small>{t("amoeba.pay.oilPayout")}</small>
            <b>{formatMetricValue(oilPay.dims.m, oilPay.format, "", locale)}</b>
            <em>{oilPay.note_zh || oilPay.formula}</em>
          </button>
        )}
        {nonPay && (
          <button
            type="button"
            className={styles.payCell}
            onClick={() => onOpen("nonPay")}
          >
            <small>{t("amoeba.pay.nonPayout")}</small>
            <b>{formatMetricValue(nonPay.dims.m, nonPay.format, "", locale)}</b>
            <em>{nonPay.note_zh || nonPay.formula}</em>
          </button>
        )}
        {pay && pay.budget_pct !== null && pay.budget_pct !== undefined && (
          <div className={styles.payBudget}>
            <small>{t("amoeba.pay.progress")}</small>
            <Progress
              percent={Math.min(100, Math.round(pay.budget_pct))}
              trailColor="var(--fn-bg-hover)"
            />
            <span>
              {formatBudgetPct(pay.budget_pct)} · {t("amoeba.pay.monthBudget")}{" "}
              {formatMetricValue(pay.budget_value, pay.format, "", locale)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------- narrative layer (demo 2) ----- */

function TrendPanel({
  cards,
  locale,
}: {
  cards: AmoebaMetricCard[];
  locale: string;
}) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState("oil");
  const nameOf = useLocaleName();
  const card = cards.find((item) => item.metric_key === metric) ?? cards[0];
  if (!card) return null;

  return (
    <section id="amoeba-section-trend" className={styles.trendPanel}>
      <div className={styles.panelHeading}>
        <div>
          <h3 className={styles.sectionTitle}>{t("amoeba.workspace.trend")}</h3>
          <span className={styles.trendUnit}>
            {nameOf(card)} · {card.unit}
          </span>
        </div>
        <Select
          size="small"
          aria-label={t("amoeba.workspace.trendMetric")}
          value={card.metric_key}
          onChange={setMetric}
          options={cards.map((item) => ({
            value: item.metric_key,
            label: nameOf(item),
          }))}
        />
      </div>
      {card.spark.some((point) => point.value !== null) ? (
        <div className={styles.trendPlot}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={card.spark}
              margin={{ top: 12, right: 12, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--board-line)"
                strokeDasharray="3 4"
              />
              <XAxis
                dataKey="date"
                tickFormatter={(date: string) => date.slice(5)}
                minTickGap={28}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: "var(--board-muted)" }}
              />
              <YAxis
                width={64}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: "var(--board-muted)" }}
                tickFormatter={(value: number) =>
                  formatMetricValue(value, card.format, "", locale)
                }
              />
              <RechartsTooltip
                formatter={(value) => [
                  formatMetricValue(Number(value), card.format, "", locale),
                  nameOf(card),
                ]}
              />
              <Area
                dataKey="value"
                type="monotone"
                stroke="var(--board-accent)"
                fill="var(--board-accent)"
                fillOpacity={0.13}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("amoeba.workspace.trendEmpty")}
        />
      )}
    </section>
  );
}

const LEVEL_CLASS: Record<AmoebaInsightLevel, string> = {
  risk: styles.lvRisk,
  warn: styles.lvWarn,
  opp: styles.lvOpp,
  info: styles.lvInfo,
};

function InsightList({ items }: { items: AmoebaInsight[] }) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <ul className={styles.insightList}>
      {items.map((item, idx) => (
        <li key={idx} className={cx(styles.insight, LEVEL_CLASS[item.level])}>
          <div className={styles.insightHeading}>
            <span className={styles.insightBadge}>
              {t(`amoeba.insights.levels.${item.level}`)}
            </span>
            <b>{item.title}</b>
          </div>
          <p>{item.evidence}</p>
          {item.action && (
            <span className={styles.insightAction}>{item.action}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------- peer comparison wall -- */

function LeafWall({
  rows,
  metricOptions,
  metric,
  onMetric,
  onDrill,
}: {
  rows: AmoebaLeafRow[];
  metricOptions: Array<{ key: string; label: string }>;
  metric: string;
  onMetric: (key: string) => void;
  onDrill: (departmentId: string) => void;
}) {
  const { t } = useTranslation();
  const scale = Math.max(1, ...rows.map((row) => Math.abs(row.value)));
  return (
    <div className={styles.wall}>
      <div className={styles.wallHead}>
        <Select
          size="small"
          aria-label={t("amoeba.insights.wall.metric")}
          value={metric}
          onChange={onMetric}
          style={{ minWidth: 150 }}
          options={metricOptions.map(({ key, label }) => ({
            value: key,
            label,
          }))}
        />
      </div>
      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("amoeba.tree.empty")}
        />
      ) : (
        <div className={styles.wallGrid}>
          {rows.map((row, idx) => (
            <button
              type="button"
              key={row.department_id}
              className={cx(styles.wallCard, idx < 3 && styles.wallCardTop)}
              onClick={() => onDrill(row.department_id)}
            >
              <span className={styles.wallRank}>{idx + 1}</span>
              <span className={styles.wallName}>{row.name}</span>
              <span className={styles.wallValue}>
                {row.value.toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                })}
              </span>
              {row.delta_pct !== null && row.delta_pct !== undefined && (
                <span
                  className={cx(
                    styles.wallDelta,
                    row.delta_pct > 0 ? styles.up : styles.down,
                  )}
                >
                  {formatDelta(row.delta_pct)}
                </span>
              )}
              <span className={styles.wallTrack}>
                <i
                  className={styles.wallFill}
                  style={{ width: `${(Math.abs(row.value) / scale) * 100}%` }}
                />
              </span>
              {row.share !== null && row.share !== undefined && (
                <span className={styles.wallShare}>
                  {row.share.toFixed(1)}%
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- sections -- */

function SectionTitle({ category, hint }: { category: string; hint?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={styles.sectionHead}
      style={metricStyle(SECTION_COLORS[category])}
    >
      <h3 className={styles.sectionTitle}>
        {t(`amoeba.categories.${category}`, { defaultValue: category })}
      </h3>
      {hint && <span className={styles.sectionHint}>{hint}</span>}
    </div>
  );
}

function QuickRead({
  overview,
  locale,
}: {
  overview: AmoebaOverview;
  locale: string;
}) {
  const { t } = useTranslation();
  const metrics = overview.metrics;
  const ratio = (
    numerator: number | null | undefined,
    denominator: number | null | undefined,
  ) => (numerator != null && denominator ? numerator / denominator : null);
  const monthDays = Number(overview.asof?.slice(-2));
  const items = [
    [
      "dailyOil",
      ratio(metrics.oil?.dims.m, monthDays),
      "number",
      t("amoeba.workspace.tonnes"),
      "amber",
    ],
    [
      "fuelMix",
      ratio(metrics.gas?.dims[overview.dim], metrics.die?.dims[overview.dim]),
      "number",
      "",
      "blue",
    ],
    [
      "gasDiscount",
      ratio(
        metrics.dis_gas?.dims[overview.dim],
        metrics.gas?.dims[overview.dim],
      ),
      "number",
      metrics.tonnonoil?.unit ?? "",
      "red",
    ],
    [
      "nonFuelMargin",
      metrics.gprate?.dims[overview.dim],
      "percent",
      "",
      "purple",
    ],
    [
      "nonFuelPerTonne",
      metrics.tonnonoil?.dims[overview.dim],
      "number",
      metrics.tonnonoil?.unit ?? "",
      "purple",
    ],
    ["conversion", metrics.conv?.dims[overview.dim], "percent", "", "mint"],
    ["oilBudget", metrics.oil?.comparisons?.m, "percent", "", "cyan"],
    [
      "monthlyPay",
      metrics.pay?.dims.m,
      "money",
      metrics.pay?.unit ?? "",
      "yellow",
    ],
  ] as const;
  return (
    <dl
      className={styles.quickRead}
      aria-label={t("amoeba.workspace.quickRead")}
    >
      {items.map(([key, value, format, unit, color]) => (
        <div key={key} style={metricStyle(color)}>
          <dt>{t(`amoeba.workspace.quickMetrics.${key}`)}</dt>
          <dd>
            {formatMetricValue(value, format, "", locale)}
            {value != null && unit && <small>{unit}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SummarySection({ narrative }: { narrative: AmoebaNarrative }) {
  if (!narrative.items.length) return null;
  return (
    <section id="amoeba-section-ai" className={styles.diagnosisPanel}>
      <SectionTitle category="ai" />
      {narrative.lead && <p className={styles.summaryLead}>{narrative.lead}</p>}
      <InsightList items={narrative.items} />
    </section>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function AmoebaPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language ?? "en";
  const zh = locale.toLowerCase().startsWith("zh");
  const role = useUserRole();
  const isAdmin = role === "admin";
  const nameOf = useLocaleName();
  const noteOf = useLocaleNote();

  const [tree, setTree] = useState<AmoebaDepartmentNode[]>([]);
  const [restricted, setRestricted] = useState(false);
  const [dept, setDept] = useState<string | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [dim, setDim] = useState<AmoebaDim>("d");
  const [showTree, setShowTree] = useState(false);
  const [activeSection, setActiveSection] = useState("core");
  const [overview, setOverview] = useState<AmoebaOverview | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [narrative, setNarrative] = useState<AmoebaNarrative>({
    lead: "",
    items: [],
  });
  const [leafRows, setLeafRows] = useState<AmoebaLeafRow[]>([]);
  const [wallMetric, setWallMetric] = useState<string>("oil");
  const [loading, setLoading] = useState(false);
  const boardRequest = useRef(0);
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
    const requestId = ++boardRequest.current;
    setLoading(true);
    setError(null);
    try {
      const [data, summary, status] = await Promise.all([
        amoebaApi.overview({ dept, dim }),
        amoebaApi
          .summary({ dept, dim })
          .catch(() => ({ lead: "", items: [] as AmoebaInsight[] })),
        amoebaApi.status().catch(() => null),
      ]);
      if (boardRequest.current === requestId) {
        setOverview(data);
        setNarrative(summary);
        if (status) setSourceName(status.source_name ?? "");
      }
    } catch (exc) {
      if (boardRequest.current === requestId) {
        setError(String(exc));
        setOverview(null);
        setNarrative({ lead: "", items: [] });
      }
    } finally {
      if (boardRequest.current === requestId) setLoading(false);
    }
  }, [dept, dim]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    let cancelled = false;
    amoebaApi
      .leaves({ metric: wallMetric, dept, dim })
      .then((data) => {
        if (!cancelled) setLeafRows(data.rows);
      })
      .catch(() => {
        if (!cancelled) setLeafRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wallMetric, dept, dim]);

  const { tree: treeData, rootKeys } = useMemo(
    () => buildTree(tree, treeFilter),
    [tree, treeFilter],
  );

  const deptName = useMemo(
    () =>
      tree.find((d) => d.department_id === dept)?.name ?? t("amoeba.tree.all"),
    [tree, dept, t],
  );

  const coreCards = (
    overview?.groups.find((group) => group.category === "core")?.metric_keys ??
    []
  )
    .map((key) => overview?.metrics[key])
    .filter((card): card is AmoebaMetricCard => Boolean(card));
  const groups = overview?.groups ?? [];
  const operatingGroups = groups.filter(({ category }) =>
    ["discount", "ops"].includes(category),
  );
  const mainGroups = groups.filter((group) => !operatingGroups.includes(group));
  const navigation = [
    ...mainGroups.map(({ category }) => category),
    ...operatingGroups.map(({ category }) => category),
    ...(narrative.items.length ? ["ai"] : []),
    "trend",
    "wall",
  ];
  const hasData = Boolean(overview?.asof);

  function selectDepartment(departmentId: string | null) {
    setDept(departmentId);
    setShowTree(false);
  }

  const wallMetricOptions = useMemo(() => {
    if (!overview) return [];
    return WALL_METRICS.map((key) => overview.metrics[key])
      .filter((card): card is AmoebaMetricCard => Boolean(card))
      .map((card) => ({
        key: card.metric_key,
        label: zh ? card.name_zh : card.name_en,
      }));
  }, [overview, zh]);

  const renderGroup = (category: string, keys: string[]) => {
    if (!overview) return null;
    const cards = keys.map((key) => overview.metrics[key]).filter(Boolean);
    if (!cards.length) return null;
    const open = (key: string) => () => setDrawerKey(key);
    const byKey: Record<string, AmoebaMetricCard | undefined> =
      Object.fromEntries(cards.map((c) => [c.metric_key, c]));

    let body: React.ReactNode = null;
    if (category === "core") {
      body = (
        <>
          <div className={styles.kpiGrid}>
            {cards.map((card) => (
              <KpiCard
                key={card.metric_key}
                card={card}
                dim={dim}
                nameOf={nameOf}
                note={noteOf(card)}
                locale={locale}
                onClick={open(card.metric_key)}
              />
            ))}
          </div>
        </>
      );
    } else if (category === "pay") {
      body = (
        <PayBand
          cards={byKey}
          locale={locale}
          onOpen={(key) => setDrawerKey(key)}
        />
      );
    } else if (category === "discount") {
      const rollups = cards.filter((c) =>
        ["dis_gas", "dis_die", "dis_non"].includes(c.metric_key),
      );
      const items = cards.filter((c) => !rollups.includes(c));
      const disTotal = overview.metrics.dis;
      body = (
        <div className={styles.discountLayout}>
          <div className={styles.discountCats}>
            {rollups.map((card) => (
              <button
                type="button"
                key={card.metric_key}
                className={cx(styles.card, styles.discountCat)}
                onClick={open(card.metric_key)}
              >
                <div className={styles.discountCatHead}>
                  <span>{nameOf(card)}</span>
                  <DeltaTag card={card} />
                </div>
                <div className={styles.discountCatValue}>
                  {formatMetricValue(card.dims[dim], card.format, "", locale)}
                </div>
                {noteOf(card) && (
                  <Tag className={styles.discountBadge}>{noteOf(card)}</Tag>
                )}
              </button>
            ))}
          </div>
          <Table
            className={styles.discountTable}
            size="small"
            rowKey="metric_key"
            pagination={false}
            scroll={{ x: "max-content" }}
            dataSource={items}
            summary={() => {
              if (!disTotal) return null;
              return (
                <Table.Summary.Row className={styles.discountTotalRow}>
                  <Table.Summary.Cell index={0}>
                    {t("amoeba.discount.total")}
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1}>&nbsp;</Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <b>
                      {formatMetricValue(
                        disTotal.dims.d,
                        disTotal.format,
                        "",
                        locale,
                      )}
                    </b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">
                    <b>
                      {formatMetricValue(
                        disTotal.dims.m,
                        disTotal.format,
                        "",
                        locale,
                      )}
                    </b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">
                    <b>
                      {formatMetricValue(
                        disTotal.dims.y,
                        disTotal.format,
                        "",
                        locale,
                      )}
                    </b>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">
                    {dim === "m" ? (
                      formatBudgetPct(disTotal.budget_pct) || "—"
                    ) : (
                      <DeltaBar pct={disTotal.delta_pct} />
                    )}
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">
                    100%
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              );
            }}
            columns={[
              {
                title: t("amoeba.discount.item"),
                render: (_v: unknown, record: AmoebaMetricCard) =>
                  nameOf(record),
              },
              {
                title: t("amoeba.discount.rule"),
                render: (_v: unknown, record: AmoebaMetricCard) => (
                  <Tag>{noteOf(record)}</Tag>
                ),
              },
              ...DIM_OPTIONS.map((d) => ({
                title: t(`amoeba.dim.${d}`),
                align: "right" as const,
                render: (_v: unknown, record: AmoebaMetricCard) =>
                  formatMetricValue(record.dims[d], record.format, "", locale),
              })),
              {
                title: t(
                  dim === "m"
                    ? "amoeba.budget"
                    : dim === "y"
                    ? "amoeba.yoy"
                    : "amoeba.mom",
                ),
                align: "center" as const,
                render: (_v: unknown, record: AmoebaMetricCard) =>
                  dim === "m" ? (
                    formatBudgetPct(record.budget_pct) || "—"
                  ) : (
                    <DeltaBar pct={record.delta_pct} />
                  ),
              },
              {
                title: t("amoeba.discount.share"),
                align: "right" as const,
                render: (_v: unknown, record: AmoebaMetricCard) => {
                  const total = disTotal?.dims[dim];
                  const value = record.dims[dim];
                  if (!total || value == null) return "—";
                  return `${((value / total) * 100).toFixed(1)}%`;
                },
              },
            ]}
          />
        </div>
      );
    } else {
      body = (
        <div className={styles.triGrid}>
          {cards.map((card) => (
            <TriCard
              key={card.metric_key}
              card={card}
              dim={dim}
              nameOf={nameOf}
              note={noteOf(card)}
              color={SECTION_COLORS[category]}
              locale={locale}
              onClick={open(card.metric_key)}
            />
          ))}
        </div>
      );
    }
    return (
      <section
        id={`amoeba-section-${category}`}
        className={styles.section}
        key={category}
      >
        <SectionTitle
          category={category}
          hint={category === "core" ? t("amoeba.section.hint") : undefined}
        />
        {body}
      </section>
    );
  };

  return (
    <>
      <div className={styles.page}>
        <header className={styles.masthead}>
          <div className={styles.mastheadContext}>
            <div className={styles.mastheadTitle}>
              <h1>{t("pageShell.amoeba.title")}</h1>
              <span className={styles.region}>
                <MapPin size={13} aria-hidden />
                {t("amoeba.workspace.region")}
              </span>
            </div>
            <div className={styles.scopeDate}>
              <span>{deptName}</span>
              {overview?.asof && (
                <time dateTime={overview.asof}>
                  {t("amoeba.workspace.dataDate", { date: overview.asof })}
                </time>
              )}
              {overview?.asof && sourceName === "amoeba-stub" && (
                <Tag color="gold">{t("amoeba.workspace.sampleData")}</Tag>
              )}
            </div>
          </div>
          <div className={styles.headerControls}>
            <div className={styles.periodControl}>
              <Segmented
                size="small"
                aria-label={t("amoeba.workspace.period")}
                value={dim}
                onChange={setDim}
                options={DIM_OPTIONS.map((d) => ({
                  value: d,
                  label: t(`amoeba.dim.${d}`),
                }))}
              />
            </div>
            {isAdmin && (
              <Button
                icon={<Settings2 size={14} />}
                onClick={() => setAdminOpen(true)}
              >
                {t("amoeba.admin.title")}
              </Button>
            )}
            <Button
              aria-label={t("common.refresh")}
              title={t("common.refresh")}
              icon={<RefreshCw size={14} />}
              loading={loading}
              onClick={() => {
                void loadBoard();
                void loadTree();
              }}
            />
          </div>
        </header>

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

        <div className={cx(styles.layout, hasData && styles.withNavigation)}>
          <button
            className={styles.treeToggle}
            type="button"
            aria-expanded={showTree}
            aria-controls="amoeba-organization"
            onClick={() => setShowTree(!showTree)}
          >
            <GitBranch size={16} aria-hidden />{" "}
            {t("amoeba.workspace.organization")}
          </button>
          <aside
            id="amoeba-organization"
            className={cx(styles.treePanel, showTree && styles.treeOpen)}
          >
            <div className={styles.treeCaption}>
              <GitBranch size={16} aria-hidden />
              {t("amoeba.workspace.organization")}
            </div>
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
                onClick={() => selectDepartment(null)}
              >
                {t("amoeba.tree.all")}
              </button>
            </div>
            {treeData.length ? (
              <Tree
                blockNode
                showLine={{ showLeafIcon: false }}
                treeData={treeData as unknown as DataNode[]}
                expandedKeys={
                  treeFilter.trim()
                    ? tree.map((node) => node.department_id)
                    : treeExpanded ?? rootKeys
                }
                onExpand={(keys) => setTreeExpanded(keys)}
                selectedKeys={dept ? [dept] : []}
                onSelect={(keys) =>
                  selectDepartment(keys.length ? String(keys[0]) : null)
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
                <QuickRead overview={overview} locale={locale} />
                {mainGroups.map((g) => renderGroup(g.category, g.metric_keys))}
                {operatingGroups.length > 0 && (
                  <div className={styles.operatingGrid}>
                    {operatingGroups.map((g) =>
                      renderGroup(g.category, g.metric_keys),
                    )}
                  </div>
                )}
                <SummarySection narrative={narrative} />
                <div className={styles.analysisGrid}>
                  <TrendPanel cards={coreCards} locale={locale} />
                  <section
                    id="amoeba-section-wall"
                    className={cx(styles.section, styles.rankingPanel)}
                  >
                    <SectionTitle category="wall" />
                    <LeafWall
                      rows={leafRows}
                      metricOptions={wallMetricOptions}
                      metric={wallMetric}
                      onMetric={setWallMetric}
                      onDrill={selectDepartment}
                    />
                  </section>
                </div>
              </>
            )}
          </div>
          {hasData && (
            <nav
              className={styles.metricNavigation}
              aria-label={t("amoeba.workspace.metricNavigation")}
            >
              <h2>{t("amoeba.workspace.metricNavigation")}</h2>
              {navigation.map((category) => (
                <button
                  type="button"
                  key={category}
                  style={metricStyle(SECTION_COLORS[category])}
                  aria-current={
                    activeSection === category ? "location" : undefined
                  }
                  onClick={() => {
                    document
                      .getElementById(`amoeba-section-${category}`)
                      ?.scrollIntoView({ block: "start" });
                    setActiveSection(category);
                  }}
                >
                  {category === "trend"
                    ? t("amoeba.workspace.trend")
                    : t(`amoeba.categories.${category}`, {
                        defaultValue: category,
                      })}
                </button>
              ))}
            </nav>
          )}
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
    </>
  );
}
