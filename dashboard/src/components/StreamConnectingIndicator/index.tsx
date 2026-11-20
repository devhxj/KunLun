import type { ReactNode } from "react";
import cx from "classnames";
import KunlunMascot from "../KunlunMascot";
import styles from "./StreamConnectingIndicator.module.less";

interface StreamConnectingIndicatorProps {
  /** Status line under the animation (e.g. 「连接中」). */
  label: ReactNode;
  /** Optional secondary hint. */
  hint?: ReactNode;
  /** Light page chrome vs dark stream surfaces (phone / browser viewport). */
  tone?: "default" | "onDark";
  /** Compact for phone bezel / dock panels. */
  size?: "md" | "sm";
}

/**
 * Shared connecting / waiting-frame indicator for remote browser & desktop.
 * Uses the same worker animation as chat thinking bubbles.
 */
export default function StreamConnectingIndicator({
  label,
  hint,
  tone = "default",
  size = "md",
}: StreamConnectingIndicatorProps) {
  const rootClass = cx(
    styles.root,
    tone === "onDark" && styles.onDark,
    size === "sm" && styles.sizeSm,
  );

  return (
    <div className={rootClass}>
      <KunlunMascot className={styles.mascot} focused />
      <div className={styles.label}>{label}</div>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}
