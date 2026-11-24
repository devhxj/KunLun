/*
 * Icons, identity colours and the small chart pieces used across the Amoeba
 * board. Each metric keeps one identity colour everywhere it appears, so a
 * reader who learns "油品 = orange" can rely on it in every section.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import cx from "classnames";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowRightLeft,
  Banknote,
  CalendarDays,
  ChartColumn,
  ChartLine,
  Coins,
  CreditCard,
  Droplet,
  Eye,
  FileChartColumn,
  Flame,
  Fuel,
  Gauge,
  IdCard,
  Info,
  Layers,
  Lightbulb,
  Package,
  PackageX,
  Percent,
  PlugZap,
  Receipt,
  Scale,
  ShoppingBag,
  Snowflake,
  Tag,
  Target,
  TicketPercent,
  TrendingUp,
  TriangleAlert,
  Truck,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  AmoebaInsightLevel,
  AmoebaMetricCard,
} from "../../api/modules/amoeba";
import { formatMetricValue } from "./formatMetricValue";
import styles from "./index.module.less";

/* --------------------------------------------------------------- colours -- */

/**
 * Six identity hues, validated as an ordered categorical palette (adjacent
 * CVD and normal-vision separation) on the light and dark card surfaces.
 * The hex steps live in index.module.less as `--tone-<name>`.
 */
export type Tone = "orange" | "blue" | "teal" | "gold" | "rose" | "violet";

const METRIC_TONES: Record<string, Tone> = {
  // fuel
  oil: "orange",
  gas: "orange",
  gasgp: "orange",
  dis_gas: "orange",
  lossrate: "orange",
  guntimes: "orange",
  gunvol: "orange",
  die: "blue",
  dis_die: "blue",
  eff: "blue",
  cardratio: "blue",
  dis: "blue",
  // natural gas
  ng: "teal",
  lng: "teal",
  nggp: "teal",
  cng: "gold",
  // charging
  kwh: "violet",
  chgpergun: "violet",
  chgfee: "violet",
  chggp: "violet",
  // non-fuel retail
  rev: "rose",
  nonoilgp: "rose",
  tonnonoilgp: "rose",
  dis_non: "rose",
  gprate: "rose",
  noncust: "rose",
  conv: "rose",
  tonnonoil: "rose",
  invdays: "rose",
  deadsku: "rose",
  // money
  profit: "gold",
  pay: "gold",
  oilPay: "orange",
  nonPay: "rose",
};

export function toneOf(metricKey: string): Tone | undefined {
  return METRIC_TONES[metricKey];
}

export function toneStyle(tone: Tone | undefined): CSSProperties {
  return {
    "--tone": tone ? `var(--tone-${tone})` : "var(--board-chart)",
  } as CSSProperties;
}

/* ----------------------------------------------------------------- icons -- */

const METRIC_ICONS: Record<string, LucideIcon> = {
  oil: Fuel,
  gas: Fuel,
  gasgp: Fuel,
  dis_gas: Fuel,
  die: Truck,
  dis_die: Truck,
  ng: Flame,
  nggp: Flame,
  lng: Snowflake,
  cng: Gauge,
  kwh: Zap,
  chgpergun: PlugZap,
  chgfee: Receipt,
  chggp: Zap,
  rev: ShoppingBag,
  nonoilgp: ShoppingBag,
  dis_non: ShoppingBag,
  tonnonoilgp: Scale,
  tonnonoil: Scale,
  profit: Banknote,
  pay: Wallet,
  oilPay: Fuel,
  nonPay: ShoppingBag,
  dis: TicketPercent,
  lossrate: Droplet,
  guntimes: Fuel,
  gunvol: Gauge,
  eff: CreditCard,
  cardratio: IdCard,
  gprate: Percent,
  noncust: Users,
  conv: ArrowRightLeft,
  invdays: Package,
  deadsku: PackageX,
};

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  core: Gauge,
  category: Layers,
  profit: Coins,
  pay: Wallet,
  discount: TicketPercent,
  ops: Activity,
  trend: ChartLine,
  wall: ChartColumn,
  ai: Lightbulb,
  static: FileChartColumn,
};

export const QUICK_ICONS: Record<string, LucideIcon> = {
  dailyOil: CalendarDays,
  fuelMix: Scale,
  gasDiscount: TicketPercent,
  nonFuelMargin: Percent,
  nonFuelPerTonne: ShoppingBag,
  conversion: ArrowRightLeft,
  oilBudget: Target,
  monthlyPay: Wallet,
};

export const LEVEL_ICONS: Record<AmoebaInsightLevel, LucideIcon> = {
  risk: TriangleAlert,
  warn: Eye,
  opp: TrendingUp,
  info: Info,
};

export function SectionIcon({
  category,
  size = 16,
}: {
  category: string;
  size?: number;
}) {
  const Icon = CATEGORY_ICONS[category] ?? Layers;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}

/** Metric glyph; `badge` wraps it in a tinted circle for the headline tiles. */
export function MetricIcon({
  card,
  size = 14,
  badge = false,
}: {
  card: Pick<AmoebaMetricCard, "metric_key" | "category">;
  size?: number;
  badge?: boolean;
}) {
  const Icon =
    METRIC_ICONS[card.metric_key] ?? CATEGORY_ICONS[card.category] ?? Tag;
  return (
    <span
      className={badge ? styles.iconBadge : styles.iconInline}
      aria-hidden="true"
    >
      <Icon size={size} strokeWidth={1.8} />
    </span>
  );
}

/* -------------------------------------------------------- composition -- */

export interface Part {
  key: string;
  label: string;
  value: number;
  tone?: Tone;
}

const percentOf = (value: number, total: number) =>
  total > 0 ? (value / total) * 100 : 0;

/**
 * One whole split into at most six parts. `thin` drops the printed shares and
 * the legend for use beside cards that already name each part.
 */
export function SegmentedBar({
  title,
  parts,
  format,
  unit,
  locale,
  thin = false,
}: {
  title?: string;
  parts: Part[];
  format: string;
  unit?: string;
  locale: string;
  thin?: boolean;
}) {
  const visible = parts.filter((part) => part.value > 0);
  const total = visible.reduce((sum, part) => sum + part.value, 0);
  if (!visible.length || total <= 0) return null;
  const label = visible
    .map((part) => `${part.label} ${percentOf(part.value, total).toFixed(1)}%`)
    .join("，");
  return (
    <div className={cx(styles.mix, thin && styles.mixThin)}>
      {title && (
        <div className={styles.mixHead}>
          <span>{title}</span>
          <b>
            {formatMetricValue(total, format, "", locale)}
            {unit && <small>{unit}</small>}
          </b>
        </div>
      )}
      <div className={styles.segBar} role="img" aria-label={label}>
        {visible.map((part) => {
          const share = percentOf(part.value, total);
          return (
            <span
              key={part.key}
              className={styles.segment}
              data-tone={part.tone}
              style={{ ...toneStyle(part.tone), flexGrow: part.value }}
              title={`${part.label} ${share.toFixed(1)}%`}
            >
              {!thin && share >= 14 && `${share.toFixed(0)}%`}
            </span>
          );
        })}
      </div>
      {!thin && (
        <ul className={styles.legend}>
          {visible.map((part) => (
            <li key={part.key} style={toneStyle(part.tone)}>
              <i aria-hidden="true" />
              <span>{part.label}</span>
              <b>{formatMetricValue(part.value, format, "", locale)}</b>
              <small>{percentOf(part.value, total).toFixed(1)}%</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ranked rows comparing parts of a total: name, bar, figure, share. */
export function MeterList({
  title,
  parts,
  format,
  locale,
}: {
  title: string;
  parts: Part[];
  format: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const rows = [...parts].sort((a, b) => b.value - a.value);
  const max = Math.max(0, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  if (!rows.length) return null;
  return (
    <div className={styles.mix}>
      <div className={styles.mixHead}>
        <span>{title}</span>
        <b>{formatMetricValue(total, format, "", locale)}</b>
      </div>
      <ul className={styles.meterList}>
        {rows.map((row) => (
          <li key={row.key} style={toneStyle(row.tone)}>
            <span className={styles.meterName}>{row.label}</span>
            <span className={styles.meterTrack} aria-hidden="true">
              <i
                style={{
                  width: `${
                    max > 0 ? (Math.max(0, row.value) / max) * 100 : 0
                  }%`,
                }}
              />
            </span>
            <b className={cx(row.value < 0 && styles.down)}>
              {formatMetricValue(row.value, format, "", locale)}
            </b>
            <small title={t("amoeba.charts.share")}>
              {total > 0 && row.value > 0
                ? `${percentOf(row.value, total).toFixed(1)}%`
                : "—"}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Single attainment figure drawn as a ring; values past 100% fill it. */
export function BudgetRing({ pct, label }: { pct: number; label: string }) {
  const radius = 30;
  const length = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <div
      className={styles.ring}
      role="img"
      aria-label={`${label} ${pct.toFixed(1)}%`}
    >
      <svg viewBox="0 0 76 76" aria-hidden="true">
        <circle className={styles.ringTrack} cx="38" cy="38" r={radius} />
        <circle
          className={styles.ringValue}
          cx="38"
          cy="38"
          r={radius}
          strokeDasharray={`${length * filled} ${length}`}
          transform="rotate(-90 38 38)"
        />
      </svg>
      <b>
        {pct.toFixed(1)}
        <small>%</small>
      </b>
    </div>
  );
}

/* ---------------------------------------------------------- trend view -- */

type Point = { date: string; value: number | null; ma7: number | null };

function withMovingAverage(
  spark: AmoebaMetricCard["spark"],
  window = 7,
): Point[] {
  return spark.map((point, index) => {
    const recent = spark
      .slice(Math.max(0, index - window + 1), index + 1)
      .map((p) => p.value)
      .filter((v): v is number => v != null);
    return {
      date: point.date,
      value: point.value,
      ma7: recent.length
        ? recent.reduce((sum, v) => sum + v, 0) / recent.length
        : null,
    };
  });
}

function lastValue(card: AmoebaMetricCard) {
  for (let i = card.spark.length - 1; i >= 0; i -= 1) {
    const value = card.spark[i].value;
    if (value != null) return value;
  }
  return null;
}

/**
 * Metric picker on the left, one large daily chart on the right: daily
 * columns with a 7-day moving average drawn over them on the same axis.
 */
export function TrendExplorer({
  cards,
  locale,
  nameOf,
}: {
  cards: AmoebaMetricCard[];
  locale: string;
  nameOf: (card: AmoebaMetricCard) => string;
}) {
  const { t } = useTranslation();
  const plottable = cards.filter((card) =>
    card.spark.some((point) => point.value != null),
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active =
    plottable.find((card) => card.metric_key === activeKey) ?? plottable[0];
  const data = useMemo(
    () => (active ? withMovingAverage(active.spark) : []),
    [active],
  );
  const compact = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumSignificantDigits: 3,
      }),
    [locale],
  );

  if (!active) {
    return (
      <p className={styles.trendMissing}>{t("amoeba.workspace.trendEmpty")}</p>
    );
  }
  const format = (value: unknown) =>
    formatMetricValue(Number(value), active.format, "", locale);
  const dailyName = t("amoeba.charts.daily");
  const averageName = t("amoeba.charts.ma7");

  return (
    <div className={styles.trendExplorer}>
      <div
        className={styles.trendTabs}
        role="tablist"
        aria-label={t("amoeba.workspace.trendMetric")}
      >
        {plottable.map((card) => {
          const selected = card.metric_key === active.metric_key;
          return (
            <button
              key={card.metric_key}
              type="button"
              role="tab"
              aria-selected={selected}
              className={cx(styles.trendTab, selected && styles.trendTabOn)}
              style={toneStyle(toneOf(card.metric_key))}
              onClick={() => setActiveKey(card.metric_key)}
            >
              <MetricIcon card={card} size={14} badge />
              <span>{nameOf(card)}</span>
              <b>
                {formatMetricValue(lastValue(card), card.format, "", locale)}
              </b>
            </button>
          );
        })}
      </div>
      <div
        className={styles.trendStage}
        role="tabpanel"
        style={toneStyle(toneOf(active.metric_key))}
      >
        <div className={styles.trendStageHead}>
          <strong>
            {nameOf(active)}
            {active.unit && <small>{active.unit}</small>}
          </strong>
          <ul className={styles.chartLegend}>
            <li>
              <i className={styles.keyBar} aria-hidden="true" />
              {dailyName}
            </li>
            <li>
              <i className={styles.keyLine} aria-hidden="true" />
              {averageName}
            </li>
          </ul>
        </div>
        <div className={styles.trendChartBox}>
          <ResponsiveContainer width="100%" height="100%" minWidth={1}>
            <ComposedChart
              data={data}
              margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
              barCategoryGap="28%"
            >
              <CartesianGrid vertical={false} stroke="var(--board-line-2)" />
              <XAxis
                dataKey="date"
                tickFormatter={(value: string) => value.slice(5)}
                tick={{ fill: "var(--board-hint)", fontSize: 11 }}
                axisLine={{ stroke: "var(--board-line)" }}
                tickLine={false}
                minTickGap={18}
              />
              <YAxis
                width={52}
                tickFormatter={(value: number) => compact.format(value)}
                tick={{ fill: "var(--board-hint)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: "var(--board-soft)" }}
                formatter={(value, name) => [format(value), name]}
                contentStyle={{
                  background: "var(--board-card)",
                  border: "1px solid var(--board-line)",
                  borderRadius: 8,
                  boxShadow: "var(--board-shadow)",
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--board-ink)", fontWeight: 600 }}
                itemStyle={{ color: "var(--board-ink-2)" }}
              />
              <Bar
                dataKey="value"
                name={dailyName}
                fill="var(--tone)"
                radius={[4, 4, 0, 0]}
                maxBarSize={11}
                fillOpacity={0.88}
                isAnimationActive={false}
              />
              <Line
                dataKey="ma7"
                name={averageName}
                type="monotone"
                stroke="var(--board-ink-2)"
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 4,
                  strokeWidth: 2,
                  stroke: "var(--board-card)",
                }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
