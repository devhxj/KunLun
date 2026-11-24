import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Segmented, Table, Tree } from "antd";
import type { DataNode } from "antd/es/tree";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import {
  ChevronRight,
  FolderUp,
  GitBranch,
  MapPin,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import cx from "classnames";
import {
  amoebaApi,
  type AmoebaDepartmentNode,
  type AmoebaDim,
  type AmoebaInsight,
  type AmoebaInsightLevel,
  type AmoebaMetricCard,
  type AmoebaNarrative,
  type AmoebaOverview,
  type AmoebaSharedBoard,
} from "../../api/modules/amoeba";
import { useUserRole } from "../../hooks/useUserRole";
import MetricDrawer from "./MetricDrawer";
import AdminModal from "./AdminModal";
import PumpjackLoader from "./PumpjackLoader";
import SharedBoards from "./SharedBoards";
import {
  BudgetRing,
  LEVEL_ICONS,
  MeterList,
  MetricIcon,
  QUICK_ICONS,
  SectionIcon,
  SegmentedBar,
  TrendExplorer,
  toneOf,
  toneStyle,
  type Part,
} from "./boardVisuals";
import {
  formatBudgetPct,
  formatDelta,
  formatMetricValue,
} from "./formatMetricValue";
import styles from "./index.module.less";

const DIM_OPTIONS = ["d", "m", "y"] as const;

const COMPARISON_LABELS = {
  d: "amoeba.mom",
  m: "amoeba.budget",
  y: "amoeba.yoy",
} as const;

/** Fuel volumes split in the 分品类 section, in validated colour order. */
const FUEL_MIX_KEYS = ["gas", "die", "lng", "cng"] as const;
/** Gross-margin lines compared in the 效益 section. */
const MARGIN_KEYS = ["gasgp", "nonoilgp", "nggp", "chggp"] as const;
const DISCOUNT_ROLLUPS = ["dis_gas", "dis_die", "dis_non"];

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
  // Month budget attainment gets its own meter, so the text figure is not
  // repeated beside the month value.
  const budget = card.comparisons ? card.comparisons.m : card.budget_pct;
  const hasBudget = budget != null && Number.isFinite(budget);
  return (
    <button
      type="button"
      className={cx(styles.card, styles.kpi)}
      style={toneStyle(toneOf(card.metric_key))}
      onClick={onClick}
    >
      <div className={styles.kpiTop}>
        <MetricIcon card={card} size={16} badge />
        <span className={styles.kpiLabel}>{nameOf(card)}</span>
        {note && (
          <span className={styles.kpiHint} title={note}>
            {note}
          </span>
        )}
        <ChevronRight className={styles.cardGo} size={14} aria-hidden />
      </div>
      <div className={styles.kpiMain}>
        <b title={formatMetricValue(card.dims[dim], card.format, "", locale)}>
          {formatMetricValue(card.dims[dim], card.format, "", locale)}
        </b>
        <small>{card.unit}</small>
        {!(dim === "m" && hasBudget) && (
          <span className={styles.kpiChange}>
            {card.comparisons ? (
              <PeriodComparison card={card} period={dim} />
            ) : (
              <DeltaTag card={card} />
            )}
          </span>
        )}
      </div>
      {hasBudget && (
        <div className={styles.kpiBudget}>
          <small>{t("amoeba.charts.budgetMeter")}</small>
          <span className={styles.budgetTrack} aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, budget))}%` }} />
          </span>
          <b className={budget >= 100 ? styles.up : styles.down}>
            {formatBudgetPct(budget)}
          </b>
        </div>
      )}
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
            {card.comparisons && !(period === "m" && hasBudget) && (
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
                stroke="var(--tone)"
                fill="var(--tone)"
                fillOpacity={0.12}
                strokeWidth={1.6}
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
  onClick,
}: {
  card: AmoebaMetricCard;
  dim: AmoebaDim;
  nameOf: (c: AmoebaMetricCard) => string;
  locale: string;
  note?: string;
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
      style={toneStyle(toneOf(card.metric_key))}
      onClick={onClick}
    >
      <div className={styles.triLabel}>
        <MetricIcon card={card} />
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
      <p className={styles.paySlogan}>{t("amoeba.pay.slogan")}</p>
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
            <BudgetRing pct={pay.budget_pct} label={t("amoeba.pay.progress")} />
            <div>
              <small>{t("amoeba.pay.progress")}</small>
              <span>
                {t("amoeba.pay.monthBudget")}{" "}
                {formatMetricValue(pay.budget_value, pay.format, "", locale)}
              </span>
            </div>
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
  no,
}: {
  cards: AmoebaMetricCard[];
  locale: string;
  no?: string;
}) {
  const nameOf = useLocaleName();
  if (!cards.length) return null;
  const dates = cards.find((card) => card.spark.length)?.spark;
  const first = dates?.[0]?.date;
  const last = dates?.at(-1)?.date;

  return (
    <section id="amoeba-section-trend" className={styles.section}>
      <SectionTitle
        no={no}
        category="trend"
        hint={first && last ? `${first} — ${last}` : undefined}
      />
      <div className={styles.panel}>
        <TrendExplorer cards={cards} locale={locale} nameOf={nameOf} />
      </div>
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
      {items.map((item, idx) => {
        const LevelIcon = LEVEL_ICONS[item.level];
        return (
          <li key={idx} className={cx(styles.insight, LEVEL_CLASS[item.level])}>
            <span className={styles.insightBadge}>
              <LevelIcon size={13} strokeWidth={2} aria-hidden="true" />
              {t(`amoeba.insights.levels.${item.level}`)}
            </span>
            <div className={styles.insightBody}>
              <b>{item.title}</b>
              <p>{item.evidence}</p>
              {item.action && (
                <p className={styles.insightAction}>
                  <em>{t("amoeba.insights.action")}</em>
                  {item.action}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function UnitComparison({
  overview,
  locale,
  no,
  onDrill,
}: {
  overview: AmoebaOverview;
  locale: string;
  no?: string;
  onDrill: (departmentId: string) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useLocaleName();
  const rows = overview.comparison?.rows ?? [];
  const metrics = (overview.comparison?.metric_keys ?? [])
    .map((key) => overview.metrics[key])
    .filter(Boolean);
  const columns = metrics.map((card) => ({
    card,
    max: rows.reduce(
      (max, row) => Math.max(max, Math.abs(row.values[card.metric_key] ?? 0)),
      0,
    ),
  }));

  return (
    <section id="amoeba-section-wall" className={styles.section}>
      <SectionTitle no={no} category="wall" />
      <div className={styles.panel}>
        {rows.length && columns.length ? (
          <table
            className={styles.comparisonTable}
            aria-label={t("amoeba.categories.wall")}
          >
            <thead>
              <tr>
                <th scope="col">{t("amoeba.workspace.organization")}</th>
                {columns.map(({ card }) => (
                  <th
                    key={card.metric_key}
                    scope="col"
                    style={toneStyle(toneOf(card.metric_key))}
                  >
                    <MetricIcon card={card} size={13} />
                    {nameOf(card)} <small>{card.unit}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.department_id}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.comparisonUnit}
                      onClick={() => onDrill(row.department_id)}
                    >
                      {row.name}
                    </button>
                  </th>
                  {columns.map(({ card, max }) => {
                    const value = row.values[card.metric_key];
                    return (
                      <td
                        key={card.metric_key}
                        style={toneStyle(toneOf(card.metric_key))}
                      >
                        <span
                          className={styles.comparisonMobileLabel}
                          aria-hidden="true"
                        >
                          {nameOf(card)} <small>{card.unit}</small>
                        </span>
                        <span
                          className={cx(
                            styles.comparisonValue,
                            value != null && value < 0 && styles.down,
                          )}
                        >
                          {formatMetricValue(value, card.format, "", locale)}
                        </span>
                        {value != null && max > 0 && (
                          <span
                            className={styles.comparisonTrack}
                            aria-hidden="true"
                          >
                            <i
                              style={{
                                width: `${(Math.abs(value) / max) * 100}%`,
                              }}
                            />
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("amoeba.workspace.comparisonEmpty")}
          />
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- sections -- */

function useSectionLabel() {
  const { t } = useTranslation();
  return useCallback(
    (category: string) =>
      category === "trend"
        ? t("amoeba.workspace.trend")
        : t(`amoeba.categories.${category}`, { defaultValue: category }),
    [t],
  );
}

function SectionTitle({
  no,
  category,
  hint,
}: {
  no?: string;
  category: string;
  hint?: string;
}) {
  const sectionLabel = useSectionLabel();
  return (
    <div className={styles.sectionHead}>
      {no && (
        <span className={styles.sectionNo} aria-hidden="true">
          {no}
        </span>
      )}
      <h3 className={styles.sectionTitle}>
        <SectionIcon category={category} size={17} />
        {sectionLabel(category)}
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
    ],
    [
      "fuelMix",
      ratio(metrics.gas?.dims[overview.dim], metrics.die?.dims[overview.dim]),
      "number",
      "",
    ],
    [
      "gasDiscount",
      ratio(
        metrics.dis_gas?.dims[overview.dim],
        metrics.gas?.dims[overview.dim],
      ),
      "number",
      metrics.tonnonoil?.unit ?? "",
    ],
    ["nonFuelMargin", metrics.gprate?.dims[overview.dim], "percent", ""],
    [
      "nonFuelPerTonne",
      metrics.tonnonoil?.dims[overview.dim],
      "number",
      metrics.tonnonoil?.unit ?? "",
    ],
    ["conversion", metrics.conv?.dims[overview.dim], "percent", ""],
    ["oilBudget", metrics.oil?.comparisons?.m, "percent", ""],
    ["monthlyPay", metrics.pay?.dims.m, "money", metrics.pay?.unit ?? ""],
  ] as const;
  return (
    <div className={styles.quickRead}>
      <h2 className={styles.quickReadTitle}>
        {t("amoeba.workspace.quickRead")}
      </h2>
      <dl aria-label={t("amoeba.workspace.quickRead")}>
        {items.map(([key, value, format, unit]) => {
          const Icon = QUICK_ICONS[key];
          return (
            <div key={key}>
              <dt>
                {Icon && (
                  <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
                )}
                {t(`amoeba.workspace.quickMetrics.${key}`)}
              </dt>
              <dd>
                {formatMetricValue(value, format, "", locale)}
                {value != null && unit && <small>{unit}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function SummarySection({
  narrative,
  no,
}: {
  narrative: AmoebaNarrative;
  no?: string;
}) {
  if (!narrative.items.length) return null;
  return (
    <section id="amoeba-section-ai" className={styles.section}>
      <SectionTitle no={no} category="ai" />
      <div className={styles.panel}>
        {narrative.lead && (
          <p className={styles.summaryLead}>{narrative.lead}</p>
        )}
        <InsightList items={narrative.items} />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ page -- */

export default function AmoebaPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language ?? "en";
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
  const [loading, setLoading] = useState(true);
  // null while the list is still loading, so the empty state never flashes.
  const [staticBoards, setStaticBoards] = useState<AmoebaSharedBoard[] | null>(
    null,
  );
  const navigate = useNavigate();
  const [staticBoardsFailed, setStaticBoardsFailed] = useState(false);
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
    setNarrative({ lead: "", items: [] });
    const summary = amoebaApi.summary({ dept, dim }).catch(() => null);
    const status = amoebaApi.status().catch(() => null);
    try {
      const data = await amoebaApi.overview({
        dept,
        dim,
        includeComparison: true,
      });
      if (boardRequest.current === requestId) {
        setOverview(data);
        void summary.then((result) => {
          if (result && boardRequest.current === requestId)
            setNarrative(result);
        });
        void status.then((result) => {
          if (result && boardRequest.current === requestId)
            setSourceName(result.source_name ?? "");
        });
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
    return () => {
      boardRequest.current += 1;
    };
  }, [loadBoard]);

  useEffect(() => {
    let active = true;
    void amoebaApi.sharedBoards().then(
      (boards) => {
        if (active) setStaticBoards(boards);
      },
      () => {
        if (active) setStaticBoardsFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

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
  const groups = (overview?.groups ?? []).filter(({ metric_keys }) =>
    metric_keys.some((key) => overview?.metrics[key]),
  );
  const firstLoad = loading && !overview;
  // Always shown once loaded, with an upload entry point when nothing is shared.
  const showStaticBoards = !firstLoad && staticBoards !== null;
  const navigation = [
    ...groups.map(({ category }) => category),
    ...(coreCards.length ? ["trend"] : []),
    "wall",
    ...(narrative.items.length ? ["ai"] : []),
    ...(showStaticBoards ? ["static"] : []),
  ];
  /** Two-digit section number shown in the heading and the navigation. */
  const sectionNo = (category: string) => {
    const index = navigation.indexOf(category);
    return index < 0 ? undefined : String(index + 1).padStart(2, "0");
  };
  const sectionLabel = useSectionLabel();
  const hasData = Boolean(overview?.asof);

  function selectDepartment(departmentId: string | null) {
    setDept(departmentId);
    setShowTree(false);
  }

  const renderGroup = (category: string, keys: string[]) => {
    if (!overview) return null;
    const cards = keys.map((key) => overview.metrics[key]).filter(Boolean);
    if (!cards.length) return null;
    const open = (key: string) => () => setDrawerKey(key);
    const byKey: Record<string, AmoebaMetricCard | undefined> =
      Object.fromEntries(cards.map((c) => [c.metric_key, c]));
    const partsOf = (list: (AmoebaMetricCard | undefined)[]): Part[] =>
      list
        .filter((card): card is AmoebaMetricCard => Boolean(card))
        .map((card) => ({
          key: card.metric_key,
          label: nameOf(card),
          value: card.dims[dim] ?? 0,
          tone: toneOf(card.metric_key),
        }));

    let body: React.ReactNode = null;
    if (category === "core") {
      body = (
        <div className={cx(styles.panel, styles.kpiGrid)}>
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
      const rollups = DISCOUNT_ROLLUPS.map((key) => byKey[key]).filter(
        (card): card is AmoebaMetricCard => Boolean(card),
      );
      const items = cards.filter((c) => !rollups.includes(c));
      const disTotal = overview.metrics.dis;
      body = (
        <div className={cx(styles.panel, styles.discountLayout)}>
          <div className={styles.discountCats}>
            <SegmentedBar
              thin
              parts={partsOf(rollups)}
              format="money"
              locale={locale}
            />
            {rollups.map((card) => (
              <button
                type="button"
                key={card.metric_key}
                className={cx(styles.card, styles.discountCat)}
                style={toneStyle(toneOf(card.metric_key))}
                onClick={open(card.metric_key)}
              >
                <div className={styles.discountCatHead}>
                  <span>
                    <i className={styles.swatch} aria-hidden="true" />
                    {nameOf(card)}
                  </span>
                  <DeltaTag card={card} />
                </div>
                <div className={styles.discountCatValue}>
                  {formatMetricValue(card.dims[dim], card.format, "", locale)}
                </div>
                {noteOf(card) && (
                  <span className={styles.ruleTag}>{noteOf(card)}</span>
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
                render: (_v: unknown, record: AmoebaMetricCard) =>
                  noteOf(record) ? (
                    <span className={styles.ruleTag}>{noteOf(record)}</span>
                  ) : null,
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
                  const share = (value / total) * 100;
                  return (
                    <span className={styles.shareCell}>
                      <span className={styles.shareTrack} aria-hidden="true">
                        <i
                          style={{
                            width: `${Math.max(0, Math.min(100, share))}%`,
                          }}
                        />
                      </span>
                      {share.toFixed(1)}%
                    </span>
                  );
                },
              },
            ]}
          />
        </div>
      );
    } else {
      const tiles = (
        <div
          className={cx(styles.triGrid, category === "ops" && styles.opsGrid)}
        >
          {cards.map((card) => (
            <TriCard
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
      );
      // Each section gets the chart form its data calls for: a split of the
      // whole for fuel volumes, ranked bars for the margin lines.
      const fuelMix = partsOf(FUEL_MIX_KEYS.map((key) => byKey[key]));
      const margins = partsOf(MARGIN_KEYS.map((key) => byKey[key]));
      const aside =
        category === "category" && fuelMix.length > 1 ? (
          <SegmentedBar
            title={t("amoeba.charts.fuelMix")}
            parts={fuelMix}
            format="number"
            unit={byKey.gas?.unit}
            locale={locale}
          />
        ) : category === "profit" && margins.length > 1 ? (
          <MeterList
            title={t("amoeba.charts.marginMix")}
            parts={margins}
            format="money"
            locale={locale}
          />
        ) : null;
      body = aside ? (
        <div className={cx(styles.panel, styles.splitPanel)}>
          <div className={styles.splitAside}>{aside}</div>
          {tiles}
        </div>
      ) : (
        <div className={styles.panel}>{tiles}</div>
      );
    }
    return (
      <section
        id={`amoeba-section-${category}`}
        className={styles.section}
        key={category}
      >
        <SectionTitle
          no={sectionNo(category)}
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
                <span className={styles.samplePill}>
                  {t("amoeba.workspace.sampleData")}
                </span>
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
              disabled={loading}
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

          <div className={styles.content} aria-busy={loading}>
            {firstLoad ? (
              <PumpjackLoader />
            ) : !overview?.asof ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("amoeba.empty")}
                className={styles.center}
              />
            ) : (
              <>
                <QuickRead overview={overview} locale={locale} />
                {groups.map((g) => renderGroup(g.category, g.metric_keys))}
                <TrendPanel
                  cards={coreCards}
                  locale={locale}
                  no={sectionNo("trend")}
                />
                <UnitComparison
                  overview={overview}
                  locale={locale}
                  no={sectionNo("wall")}
                  onDrill={selectDepartment}
                />
                <SummarySection narrative={narrative} no={sectionNo("ai")} />
              </>
            )}
            {showStaticBoards && (
              <section id="amoeba-section-static" className={styles.section}>
                <SectionTitle no={sectionNo("static")} category="static" />
                <div className={styles.panel}>
                  {staticBoards.length ? (
                    <SharedBoards boards={staticBoards} />
                  ) : (
                    <div className={styles.boardsEmpty}>
                      <p>{t("amoeba.sharedBoards.boardEmpty")}</p>
                      <Button
                        icon={<FolderUp size={14} />}
                        onClick={() => navigate("/my-static-boards")}
                      >
                        {t("amoeba.sharedBoards.goUpload")}
                      </Button>
                    </div>
                  )}
                </div>
              </section>
            )}
            {!firstLoad && staticBoardsFailed && (
              <Alert
                type="error"
                message={t("amoeba.sharedBoards.loadFailed")}
              />
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
                  <SectionIcon category={category} size={14} />
                  <span className={styles.navLabel}>
                    {sectionLabel(category)}
                  </span>
                  <span className={styles.navNo} aria-hidden="true">
                    {sectionNo(category)}
                  </span>
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
