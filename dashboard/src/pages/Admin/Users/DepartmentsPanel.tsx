import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tree,
  type TreeDataNode,
} from "antd";
import { Building2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  departmentsApi,
  type Department,
} from "../../../api/modules/departments";
import { apiErrorMessage } from "../../../utils/apiError";
import { TabPanelHeader } from "../../Settings/AdvancedSettings/TabPanelHeader";
import DepartmentProfilePanel from "./DepartmentProfilePanel";
import styles from "./index.module.less";

type Edit = { mode: "create" | "rename"; target: Department | null };

function buildTree(departments: Department[]): TreeDataNode[] {
  const roots: TreeDataNode[] = [];
  const nodes = new Map(
    departments.map(({ department_id, name }) => [
      department_id,
      { key: department_id, title: name, children: [] as TreeDataNode[] },
    ]),
  );
  for (const { department_id, parent_id } of departments) {
    const node = nodes.get(department_id)!;
    if (parent_id === null) roots.push(node);
    else nodes.get(parent_id)?.children.push(node);
  }
  return roots;
}

export default function DepartmentsPanel() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<React.Key[] | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void departmentsApi
      .list()
      .then((rows) => {
        if (!cancelled) setDepartments(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const tree = useMemo(() => buildTree(departments), [departments]);
  const rootKeys = tree.map((node) => node.key);
  const selected = departments.find((row) => row.department_id === selectedId);
  const hasChildren = departments.some((row) => row.parent_id === selectedId);
  const ancestors: Department[] = [];
  for (let parentId = selected?.parent_id; parentId; ) {
    const parent = departments.find((row) => row.department_id === parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parent_id;
  }

  function openEditor(mode: Edit["mode"], target: Department | null) {
    setName(mode === "rename" ? target?.name ?? "" : "");
    setEdit({ mode, target });
  }

  async function save() {
    const cleanName = name.trim();
    if (!edit || !cleanName || busy) return;
    setBusy(true);
    try {
      if (edit.mode === "rename" && edit.target) {
        const row = await departmentsApi.rename(
          edit.target.department_id,
          cleanName,
        );
        setDepartments((current) =>
          current.map((item) =>
            item.department_id === row.department_id ? row : item,
          ),
        );
      } else {
        const parentId = edit.target?.department_id ?? null;
        const row = await departmentsApi.create(cleanName, parentId);
        setDepartments((current) => [...current, row]);
        setSelectedId(row.department_id);
        if (parentId) {
          setExpanded((keys) => [
            ...new Set([...(keys ?? rootKeys), parentId]),
          ]);
        }
      }
      setEdit(null);
    } catch (error) {
      void message.error(apiErrorMessage(error, t("common.saveFailed"), t));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Department) {
    setBusy(true);
    try {
      await departmentsApi.remove(row.department_id);
      setDepartments((current) =>
        current.filter((item) => item.department_id !== row.department_id),
      );
      setSelectedId(row.parent_id);
    } catch (error) {
      void message.error(apiErrorMessage(error, t("common.deleteFailed"), t));
    } finally {
      setBusy(false);
    }
  }

  const editorTitle =
    edit?.mode === "rename"
      ? t("adminUsers.departments.rename")
      : edit?.target
      ? t("adminUsers.departments.addChild")
      : t("adminUsers.departments.addRoot");

  return (
    <div className={styles.departmentsPanel}>
      <TabPanelHeader
        icon={<Building2 size={22} />}
        title={t("adminUsers.tabDepartments")}
        actions={
          <Space wrap>
            <Button
              disabled={busy || loading}
              onClick={() => setReload((value) => value + 1)}
            >
              {t("common.refresh")}
            </Button>
            <Button
              type="primary"
              icon={<Plus size={16} />}
              disabled={busy || loading || loadError}
              onClick={() => openEditor("create", null)}
            >
              {t("adminUsers.departments.addRoot")}
            </Button>
          </Space>
        }
      />
      {loadError ? (
        <Alert
          type="error"
          showIcon
          message={t("adminUsers.departments.loadFailed")}
        />
      ) : (
        <Spin spinning={loading} wrapperClassName={styles.departmentBody}>
          <div className={styles.departmentLayout}>
            <div className={styles.departmentTreeColumn}>
              {selected && !loading && (
                <div className={styles.departmentActions}>
                  <strong>{selected.name}</strong>
                  <Space wrap>
                    <Button
                      disabled={busy}
                      onClick={() => openEditor("create", selected)}
                    >
                      {t("adminUsers.departments.addChild")}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => openEditor("rename", selected)}
                    >
                      {t("common.rename")}
                    </Button>
                    {!hasChildren && (
                      <Popconfirm
                        title={t("adminUsers.departments.confirmDelete", {
                          name: selected.name,
                        })}
                        onConfirm={() => remove(selected)}
                        okText={t("common.delete")}
                        cancelText={t("common.cancel")}
                        okButtonProps={{ danger: true }}
                      >
                        <Button danger disabled={busy}>
                          {t("common.delete")}
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                </div>
              )}
              <div className={styles.departmentTree}>
                {tree.length ? (
                  <Tree
                    aria-label={t("adminUsers.tabDepartments")}
                    treeData={tree}
                    showLine
                    blockNode
                    expandedKeys={expanded ?? rootKeys}
                    selectedKeys={selected ? [selected.department_id] : []}
                    onExpand={setExpanded}
                    onSelect={(keys) =>
                      setSelectedId(keys.length ? String(keys[0]) : null)
                    }
                  />
                ) : !loading ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t("adminUsers.departments.empty")}
                  />
                ) : null}
              </div>
            </div>
            {selected && (
              <DepartmentProfilePanel
                key={selected.department_id}
                department={selected}
                ancestors={ancestors}
                onSaved={() => setReload((value) => value + 1)}
              />
            )}
          </div>
        </Spin>
      )}
      <Modal
        open={edit !== null}
        title={editorTitle}
        onCancel={() => setEdit(null)}
        onOk={() => void save()}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        okButtonProps={{ disabled: !name.trim() }}
        cancelButtonProps={{ disabled: busy }}
        confirmLoading={busy}
        closable={!busy}
        keyboard={!busy}
        maskClosable={!busy}
        destroyOnHidden
      >
        <Form layout="vertical" onFinish={() => void save()}>
          <Form.Item
            label={t("adminUsers.departments.name")}
            htmlFor="department-name"
          >
            <Input
              id="department-name"
              autoFocus
              maxLength={64}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
