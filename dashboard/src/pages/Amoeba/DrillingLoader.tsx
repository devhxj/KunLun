import { useTranslation } from "react-i18next";
import styles from "./DrillingLoader.module.less";

export default function DrillingLoader() {
  const { t } = useTranslation();

  return (
    <div className={styles.loader} role="status">
      <div className={styles.scene} aria-hidden="true">
        <div className={styles.halo} />
        <div className={styles.ground} />
        <div className={styles.rock} />
        <div className={styles.track} />
        <div className={styles.cab} />
        <div className={styles.mast} />
        <div className={styles.drill}>
          <i className={styles.motor} />
          <i className={styles.bit} />
        </div>
        <div className={styles.chips}>
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <span>{t("amoeba.workspace.loading")}</span>
    </div>
  );
}
