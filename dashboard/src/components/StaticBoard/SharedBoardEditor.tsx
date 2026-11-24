import { useEffect, useState } from "react";
import { Alert, Form, Modal, Radio, Select } from "antd";
import { useTranslation } from "react-i18next";
import {
  amoebaApi,
  type AmoebaBoardAudience,
  type AmoebaSharedBoard,
} from "../../api/modules/amoeba";

type Props = {
  board?: AmoebaSharedBoard;
  source?: { filename: string; read: () => Promise<Blob> };
  onClose: () => void;
  onSaved: (board: AmoebaSharedBoard) => void;
};

export default function SharedBoardEditor({
  board,
  source,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const [audience, setAudience] = useState<AmoebaBoardAudience>(
    board ?? { visibility: "owner", group_ids: [] },
  );
  const [groups, setGroups] = useState<Array<{
    id: string;
    name: string;
  }> | null>(null);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void amoebaApi.boardGroups().then(
      (options) => {
        if (active) setGroups(options);
      },
      () => {
        if (active) setGroupsFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const filename = source?.filename ?? file?.name;
  const { visibility, group_ids } = audience;
  const canSave =
    Boolean(board || filename) &&
    (visibility !== "groups" ||
      Boolean(
        groups &&
          group_ids.length &&
          group_ids.every((id) => groups.some((g) => g.id === id)),
      ));

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = { visibility, group_ids };
      if (board) {
        onSaved(await amoebaApi.updateBoardAudience(board.id, body));
      } else if (filename) {
        const html = source ? await source.read() : file;
        if (html) onSaved(await amoebaApi.shareBoard(html, filename, body));
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("amoeba.sharedBoards.submitFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t(
        board
          ? "amoeba.sharedBoards.audience"
          : source
          ? "amoeba.sharedBoards.submit"
          : "amoeba.sharedBoards.create",
      )}
      onCancel={onClose}
      onOk={() => void save()}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      confirmLoading={busy}
      okButtonProps={{ disabled: !canSave }}
      okText={t(
        visibility === "owner" || board
          ? "common.save"
          : "amoeba.sharedBoards.submitButton",
      )}
      cancelText={t("common.cancel")}
    >
      <Form layout="vertical" component="div">
        {board || source ? (
          <p>{board?.filename ?? source?.filename}</p>
        ) : (
          <Form.Item
            label={t("amoeba.sharedBoards.file")}
            htmlFor="amoeba-board-html"
          >
            <input
              id="amoeba-board-html"
              type="file"
              accept=".html,.htm"
              disabled={busy}
              onChange={(event) =>
                setFile(event.currentTarget.files?.[0] ?? null)
              }
            />
          </Form.Item>
        )}
        <Form.Item label={t("amoeba.sharedBoards.audience")}>
          <Radio.Group
            aria-label={t("amoeba.sharedBoards.audience")}
            disabled={busy}
            value={visibility}
            onChange={(event) =>
              setAudience({ visibility: event.target.value, group_ids: [] })
            }
            options={[
              { value: "owner", label: t("resourceVisibility.owner") },
              { value: "groups", label: t("resourceVisibility.groups") },
              { value: "all", label: t("amoeba.sharedBoards.allViewers") },
            ]}
          />
          {visibility === "groups" && (
            <Select
              mode="multiple"
              aria-label={t("resourceVisibility.groupPlaceholder")}
              placeholder={t("resourceVisibility.groupPlaceholder")}
              disabled={busy || groupsFailed}
              loading={groups === null && !groupsFailed}
              open={groupPickerOpen}
              onOpenChange={setGroupPickerOpen}
              value={group_ids}
              options={(groups ?? []).map((group) => ({
                value: group.id,
                label: group.name,
              }))}
              optionFilterProp="label"
              onChange={(group_ids) => {
                setAudience({ visibility, group_ids });
                setGroupPickerOpen(false);
              }}
              style={{ width: "100%", marginTop: 8 }}
            />
          )}
        </Form.Item>
        {(error || (groupsFailed && visibility === "groups")) && (
          <Alert
            type="error"
            message={error || t("amoeba.sharedBoards.groupsFailed")}
          />
        )}
      </Form>
    </Modal>
  );
}
