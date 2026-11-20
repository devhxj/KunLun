/**
 * Admin modal: MCP source config + manual sync + user↔department bindings.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tree,
  Typography,
} from "antd";
import type { DataNode } from "antd/es/tree";
import { useTranslation } from "react-i18next";
import { request } from "../../api/request";
import { amoebaApi, type AmoebaSourceConfig } from "../../api/modules/amoeba";
import { apiErrorMessage } from "../../utils/apiError";
import { message } from "../../utils/antdMessage";

interface Props {
  open: boolean;
  onClose: () => void;
  onSynced: () => void;
}

interface UserOption {
  id: number;
  username: string;
  display_name: string | null;
}

interface BindingTreeNode {
  department_id: string;
  parent_id: string | null;
  name: string;
}

export default function AmoebaAdminModal({ open, onClose, onSynced }: Props) {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [source, setSource] = useState<AmoebaSourceConfig | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Bindings tab state
  const [users, setUsers] = useState<UserOption[]>([]);
  const [departments, setDepartments] = useState<BindingTreeNode[]>([]);
  const [bindingUser, setBindingUser] = useState<number | null>(null);
  const [bindingDepts, setBindingDepts] = useState<string[]>([]);
  const [bindingSaving, setBindingSaving] = useState(false);

  const loadSource = useCallback(async () => {
    try {
      const cfg = await amoebaApi.getSource();
      setSource(cfg);
      form.setFieldsValue({
        enabled: cfg.enabled,
        url: cfg.url,
        token: "",
        sync_days: cfg.sync_days,
        auto_sync: cfg.auto_sync,
        sync_schedule: cfg.sync_schedule,
      });
    } catch (exc) {
      message.error(apiErrorMessage(exc, t("common.loading"), t));
    }
  }, [form, t]);

  const loadBindings = useCallback(async () => {
    try {
      const [userRows, tree] = await Promise.all([
        request<UserOption[]>("/users"),
        amoebaApi.tree(),
      ]);
      setUsers(userRows.filter((u) => u.username !== "admin"));
      setDepartments(tree.departments);
    } catch (exc) {
      message.error(apiErrorMessage(exc, t("common.loading"), t));
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      void loadSource();
      void loadBindings();
    }
  }, [open, loadSource, loadBindings]);

  useEffect(() => {
    if (bindingUser === null) {
      setBindingDepts([]);
      return;
    }
    amoebaApi
      .getBindings(bindingUser)
      .then((data) => setBindingDepts(data.department_ids))
      .catch(() => setBindingDepts([]));
  }, [bindingUser]);

  const saveSource = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const cfg = await amoebaApi.saveSource({
        enabled: values.enabled,
        url: values.url ?? "",
        token: values.token || undefined,
        sync_days: values.sync_days,
        auto_sync: values.auto_sync,
        sync_schedule: values.sync_schedule,
      });
      setSource(cfg);
      message.success(t("common.saveSuccess"));
    } catch (exc) {
      message.error(apiErrorMessage(exc, t("common.saveFailed"), t));
    } finally {
      setSaving(false);
    }
  };

  const testSource = async () => {
    const values = await form.validateFields();
    setTesting(true);
    try {
      const result = await amoebaApi.testSource({
        url: values.url || null,
        token: values.token || null,
      });
      if (result.ok) {
        message.success(
          t("amoeba.admin.testOk", { count: result.tools?.length ?? 0 }),
        );
      } else {
        message.error(
          result.error ??
            t("amoeba.admin.testMissing", {
              tools: (result.missing ?? []).join(", "),
            }),
        );
      }
    } catch (exc) {
      message.error(apiErrorMessage(exc, t("amoeba.admin.testFailed"), t));
    } finally {
      setTesting(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const result = await amoebaApi.sync();
      message.success(
        t("amoeba.admin.syncOk", {
          units: result.units,
          rows: result.snapshot_rows + result.budget_rows,
          asof: result.asof,
        }),
      );
      onSynced();
    } catch (exc) {
      message.error(apiErrorMessage(exc, t("amoeba.admin.syncFailed"), t));
    } finally {
      setSyncing(false);
    }
  };

  const saveBindings = async () => {
    if (bindingUser === null) return;
    setBindingSaving(true);
    try {
      await amoebaApi.saveBindings(bindingUser, bindingDepts);
      message.success(t("common.saveSuccess"));
    } catch (exc) {
      message.error(apiErrorMessage(exc, t("common.saveFailed"), t));
    } finally {
      setBindingSaving(false);
    }
  };

  const treeData: DataNode[] = buildBindingTree(departments);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      destroyOnHidden
      title={t("amoeba.admin.title")}
    >
      <Typography.Title level={5}>{t("amoeba.admin.source")}</Typography.Title>
      {source && !source.configured && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("amoeba.admin.notConfigured")}
        />
      )}
      <Form form={form} layout="vertical">
        <Form.Item
          name="enabled"
          label={t("amoeba.admin.enabled")}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="url"
          label={t("amoeba.admin.url")}
          rules={[{ required: true, message: t("amoeba.admin.urlRequired") }]}
        >
          <Input placeholder="https://amoeba-source.example.com/mcp" />
        </Form.Item>
        <Form.Item
          name="token"
          label={t("amoeba.admin.token")}
          extra={source?.token_set ? t("amoeba.admin.tokenSet") : undefined}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="sync_days" label={t("amoeba.admin.syncDays")}>
          <InputNumber min={1} max={3650} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          name="auto_sync"
          label={t("amoeba.admin.autoSync")}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item name="sync_schedule" label={t("amoeba.admin.syncSchedule")}>
          <Input placeholder="0 3 * * *" />
        </Form.Item>
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            type="primary"
            loading={saving}
            onClick={() => void saveSource()}
          >
            {t("common.save")}
          </Button>
          <Button loading={testing} onClick={() => void testSource()}>
            {t("amoeba.admin.test")}
          </Button>
          <Button loading={syncing} onClick={() => void runSync()}>
            {t("amoeba.admin.syncNow")}
          </Button>
        </div>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t("amoeba.admin.bindings")}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {t("amoeba.admin.bindingsHint")}
      </Typography.Paragraph>
      <Select
        style={{ width: "100%", marginBottom: 12 }}
        showSearch
        optionFilterProp="label"
        placeholder={t("amoeba.admin.selectUser")}
        value={bindingUser}
        onChange={(v) => setBindingUser(v)}
        options={users.map((u) => ({
          value: u.id,
          label: u.display_name
            ? `${u.display_name} (${u.username})`
            : u.username,
        }))}
      />
      {treeData.length ? (
        <Tree
          checkable
          blockNode
          defaultExpandAll
          treeData={treeData}
          checkedKeys={bindingDepts}
          onCheck={(keys) =>
            setBindingDepts(
              Array.isArray(keys) ? keys.map(String) : bindingDepts,
            )
          }
        />
      ) : (
        <Typography.Text type="secondary">
          {t("amoeba.tree.empty")}
        </Typography.Text>
      )}
      <Button
        style={{ marginTop: 12 }}
        type="primary"
        disabled={bindingUser === null}
        loading={bindingSaving}
        onClick={() => void saveBindings()}
      >
        {t("common.save")}
      </Button>
    </Drawer>
  );
}

function buildBindingTree(departments: BindingTreeNode[]): DataNode[] {
  const byParent = new Map<string | null, BindingTreeNode[]>();
  for (const node of departments) {
    const list = byParent.get(node.parent_id) ?? [];
    list.push(node);
    byParent.set(node.parent_id, list);
  }
  const convert = (parent: string | null): DataNode[] =>
    (byParent.get(parent) ?? []).map((node) => ({
      key: node.department_id,
      title: node.name,
      children: convert(node.department_id),
    }));
  return convert(null);
}
