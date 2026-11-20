import cx from "classnames";

import KunlunMascot from "../KunlunMascot";
import styles from "./EmptyState.module.less";

interface OctopEmptyMascotProps {
  className?: string;
  /** Square edge in px; default 160. */
  size?: number;
}

/**
 * Empty-state mascot image with shared sizing.
 * Use inside custom empty UIs or pass as ``EmptyState`` icon /
 * antd ``Empty`` ``image``.
 */
export function OctopEmptyMascot({
  className,
  size = 160,
}: OctopEmptyMascotProps) {
  return (
    <KunlunMascot
      className={cx(styles.mascot, className)}
      style={size === 160 ? undefined : { width: size, height: size }}
    />
  );
}
