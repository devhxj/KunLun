import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Modal, Skeleton, Space, Tag } from "antd";
import { FileChartColumn, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { amoebaApi, type AmoebaSharedBoard } from "../../api/modules/amoeba";
import { EmptyState, OctopEmptyMascot } from "../../components/EmptyState";
import SharedBoardEditor from "../../components/StaticBoard/SharedBoardEditor";
import SharedBoardPreview from "../../components/StaticBoard/SharedBoardPreview";
import { useServerTimezone } from "../../hooks/useServerTimezone";
import PageShell from "../../layouts/PageShell";
import { message } from "../../utils/antdMessage";
import { showConfirmModal } from "../../utils/confirmModal";
import { formatServerYmd } from "../../utils/formatMessageTime";
import styles from "./index.module.less";

type BoardAction =
  | { kind: "create" }
  | { kind: "preview" | "audience" | "replace"; board: AmoebaSharedBoard };

function ReplaceBoardFile({
  board,
  onClose,
}: {
  board: AmoebaSharedBoard;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const replace = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      await amoebaApi.replaceBoard(board.id, file);
      message.success(t("amoeba.sharedBoards.replaced"));
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("amoeba.sharedBoards.replaceFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t("amoeba.sharedBoards.replace")}
      onCancel={onClose}
      onOk={() => void replace()}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      okButtonProps={{ disabled: !file }}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
    >
      <p>
        {t("amoeba.sharedBoards.replaceHint", { filename: board.filename })}
      </p>
      <input
        type="file"
        accept=".html,.htm"
        aria-label={t("amoeba.sharedBoards.file")}
        disabled={busy}
        onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
      />
      {error && (
        <Alert className={styles.replaceError} type="error" message={error} />
      )}
    </Modal>
  );
}

export default function MyStaticBoardsPage() {
  const { t } = useTranslation();
  const timezone = useServerTimezone();
  const [boards, setBoards] = useState<AmoebaSharedBoard[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loading = !boards && !loadFailed;
  const [action, setAction] = useState<BoardAction | null>(null);

  useEffect(() => {
    let active = true;
    void amoebaApi.sharedBoards(true).then(
      (items) => {
        if (active) setBoards(items);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const close = () => setAction(null);
  const create = () => setAction({ kind: "create" });
  const save = (board: AmoebaSharedBoard) => {
    setBoards((items) =>
      items?.some((item) => item.id === board.id)
        ? items.map((item) => (item.id === board.id ? board : item))
        : [board, ...(items ?? [])],
    );
    close();
  };
  const remove = (board: AmoebaSharedBoard) => {
    showConfirmModal({
      title: t("amoeba.sharedBoards.deleteTitle"),
      content: board.filename,
      okText: t("common.delete"),
      okType: "danger",
      cancelText: t("common.cancel"),
      onOk: async () => {
        try {
          await amoebaApi.deleteBoard(board.id);
          setBoards(
            (items) => items?.filter((item) => item.id !== board.id) ?? null,
          );
        } catch {
          message.error(t("amoeba.sharedBoards.deleteFailed"));
        }
      },
    });
  };

  let content: ReactNode;
  if (loadFailed) {
    content = (
      <Alert type="error" message={t("amoeba.sharedBoards.loadFailed")} />
    );
  } else if (!boards) {
    content = (
      <div role="status" aria-label={t("common.loading")}>
        <ul className={styles.list} aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <li className={styles.row} key={index}>
              <Skeleton.Avatar shape="square" size={36} />
              <div className={styles.file}>
                <span className={styles.namePlaceholder} />
                <span className={styles.metaPlaceholder} />
              </div>
              <span className={styles.actionsPlaceholder} />
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (!boards.length) {
    content = (
      <EmptyState
        className={styles.empty}
        icon={<OctopEmptyMascot size={128} />}
        title={t("amoeba.sharedBoards.mineEmptyTitle")}
        description={t("amoeba.sharedBoards.mineEmpty")}
        actionLabel={t("amoeba.sharedBoards.create")}
        onAction={create}
      />
    );
  } else {
    content = (
      <ul className={styles.list}>
        {boards.map((board) => (
          <li className={styles.row} key={board.id}>
            <span className={styles.icon} aria-hidden="true">
              <FileChartColumn size={18} />
            </span>
            <div className={styles.file}>
              <Button
                type="link"
                className={styles.name}
                onClick={() => setAction({ kind: "preview", board })}
              >
                {board.filename}
              </Button>
              <span className={styles.meta}>
                <Tag bordered={false}>
                  {t(
                    board.visibility === "all"
                      ? "amoeba.sharedBoards.allViewers"
                      : board.visibility === "groups"
                      ? "resourceVisibility.groups"
                      : "resourceVisibility.owner",
                  )}
                </Tag>
                <span>
                  {formatServerYmd(board.created_at * 1000, timezone)}
                </span>
              </span>
            </div>
            <Space wrap size={4}>
              <Button
                type="text"
                onClick={() => setAction({ kind: "replace", board })}
              >
                {t("amoeba.sharedBoards.replace")}
              </Button>
              <Button
                type="text"
                onClick={() => setAction({ kind: "audience", board })}
              >
                {t("amoeba.sharedBoards.audience")}
              </Button>
              <Button type="text" onClick={() => remove(board)}>
                {t("common.delete")}
              </Button>
            </Space>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <PageShell
      title={t("nav.myStaticBoards")}
      actions={
        (loading || Boolean(boards?.length)) && (
          <Button
            type="primary"
            icon={<Plus size={16} />}
            disabled={loading}
            onClick={create}
          >
            {t("amoeba.sharedBoards.create")}
          </Button>
        )
      }
    >
      <div aria-busy={loading}>{content}</div>
      {action?.kind === "create" && (
        <SharedBoardEditor onClose={close} onSaved={save} />
      )}
      {action?.kind === "audience" && (
        <SharedBoardEditor
          board={action.board}
          onClose={close}
          onSaved={save}
        />
      )}
      {action?.kind === "replace" && (
        <ReplaceBoardFile board={action.board} onClose={close} />
      )}
      {action?.kind === "preview" && (
        <SharedBoardPreview board={action.board} onClose={close} />
      )}
    </PageShell>
  );
}
