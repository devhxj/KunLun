import { useEffect, useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import { useTranslation } from "react-i18next";
import { amoebaApi, type AmoebaSharedBoard } from "../../api/modules/amoeba";
import { message } from "../../utils/antdMessage";
import { saveBlobAsFile } from "../../utils/saveBlobAsFile";
import styles from "./index.module.less";

// The preview has an opaque origin, no scripts and no external subresources.
const previewHead = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri about:"><base href="about:srcdoc">`;

export default function SharedBoardPreview({
  board,
  onClose,
}: {
  board: AmoebaSharedBoard;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void amoebaApi
      .readSharedBoard(board.id, controller.signal)
      .then((blob) => blob.text())
      .then((text) => {
        if (!controller.signal.aborted) setHtml(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [board.id]);

  const download = async () => {
    setDownloading(true);
    try {
      await saveBlobAsFile(
        await amoebaApi.readSharedBoard(board.id),
        board.filename,
      );
    } catch {
      message.error(t("workspace.downloadFailed"));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal
      open
      title={board.filename}
      width={1120}
      onCancel={onClose}
      footer={
        <Button
          disabled={html === null}
          loading={downloading}
          onClick={() => void download()}
        >
          {t("common.download")}
        </Button>
      }
    >
      {failed ? (
        <Alert type="error" message={t("amoeba.sharedBoards.loadFailed")} />
      ) : html === null ? (
        <Spin />
      ) : (
        <iframe
          className={styles.frame}
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={previewHead + html}
          title={board.filename}
        />
      )}
    </Modal>
  );
}
