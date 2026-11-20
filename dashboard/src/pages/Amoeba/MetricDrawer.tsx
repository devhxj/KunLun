/**
 * Metric detail drawer: dims side by side, 30-day trend, leaf ranking.
 */

import { useCallback, useEffect, useState } from "react";
import { Drawer, Empty, Segmented, Spin } from "antd";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTranslation } from "react-i18next";
import cx from "classnames";
import {
  amoebaApi,
  type AmoebaDim,
  type AmoebaMetricDetail,
} from "../../api/modules/amoeba";
import {
  formatBudgetPct,
  formatDelta,
  formatMetricValue,
} from "./formatMetricValue";
import styles from "./index.module.less";

interface Props {
  metricKey: string | null;
  dept: string | null;
  dim: AmoebaDim;
  locale: string;
  onClose: () => void;
}

export default function MetricDrawer({
  metricKey,
  dept,
  dim,
  locale,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AmoebaMetricDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [localDim, setLocalDim] = useState<AmoebaDim>(dim);

  useEffect(() => setLocalDim(dim), [dim, metricKey]);

  const load = useCallback(async () => {
    if (!metricKey) return;
    setLoading(true);
    try {
      setDetail(
        await amoebaApi.metricDetail(metricKey, { dept, dim: localDim }),
      );
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [metricKey, dept, localDim]);

  useEffect(() => {
    void load();
  }, [load]);

  const zh = locale.toLowerCase().startsWith("zh");
  const card = detail?.metric;
  const trend = (detail?.trend ?? []).map((p) => ({
    date: p.date.slice(5),
    value: p.value ?? 0,
  }));
  const maxValue = detail?.ranking?.[0]?.value ?? 1;

  return (
    <Drawer
      open={Boolean(metricKey)}
      onClose={onClose}
      width={560}
      destroyOnHidden
      title={
        card ? (zh ? card.name_zh : card.name_en) : t("amoeba.drawer.title")
      }
    >
      {loading && !detail ? (
        <div className={styles.center}>
          <Spin />
        </div>
      ) : !card ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t("amoeba.empty")}
        />
      ) : (
        <div className={styles.drawerBody}>
          <Segmented
            value={localDim}
            onChange={(v) => setLocalDim(v as AmoebaDim)}
            options={(["d", "m", "y"] as const).map((d) => ({
              value: d,
              label: t(`amoeba.dim.${d}`),
            }))}
          />

          <div className={styles.drawerValue}>
            {formatMetricValue(
              card.dims[localDim],
              card.format,
              card.unit,
              locale,
            )}
            {card.delta_pct !== null && card.delta_pct !== undefined && (
              <span
                className={cx(
                  styles.delta,
                  card.delta_pct > 0 ? styles.up : styles.down,
                )}
              >
                {formatDelta(card.delta_pct)}
              </span>
            )}
            {card.budget_pct !== null && card.budget_pct !== undefined && (
              <span className={styles.delta}>
                {t("amoeba.budget")} {formatBudgetPct(card.budget_pct)}
              </span>
            )}
          </div>

          <h4 className={styles.drawerSection}>{t("amoeba.drawer.trend")}</h4>
          <div className={styles.trendChart}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={trend}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  stroke="var(--fn-border-secondary)"
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "var(--fn-text-tertiary)", fontSize: 11 }}
                />
                <YAxis
                  tick={{ fill: "var(--fn-text-tertiary)", fontSize: 11 }}
                  width={56}
                />
                <RechartsTooltip
                  formatter={(v) => Number(v ?? 0).toLocaleString("en-US")}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="var(--fn-color-brand)"
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <h4 className={styles.drawerSection}>{t("amoeba.drawer.ranking")}</h4>
          {detail && detail.ranking.length > 0 ? (
            <ul className={styles.ranking}>
              {detail.ranking.map((row, idx) => (
                <li key={row.department_id}>
                  <span className={styles.rankNo}>{idx + 1}</span>
                  <span className={styles.rankName}>{row.name}</span>
                  <span className={styles.rankBarWrap}>
                    <span
                      className={styles.rankBar}
                      style={{
                        width: `${Math.max(2, (row.value / maxValue) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className={styles.rankValue}>
                    {formatMetricValue(row.value, card.format, "", locale)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("amoeba.drawer.noRanking")}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
