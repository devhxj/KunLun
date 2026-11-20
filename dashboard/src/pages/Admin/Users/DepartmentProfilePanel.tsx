import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
  Tabs,
} from "antd";
import { useTranslation } from "react-i18next";
import {
  departmentsApi,
  type Department,
  type DepartmentDetails,
  type DepartmentProfile,
  type DepartmentProfileInput,
} from "../../../api/modules/departments";
import { useServerTimezone } from "../../../hooks/useServerTimezone";
import { apiErrorMessage } from "../../../utils/apiError";
import { formatServerIsoDateTime } from "../../../utils/formatMessageTime";
import styles from "./index.module.less";

const groups = {
  organization: ["full_name", "enabled", "effective_date", "code_path"],
  station: [
    "province_company_code",
    "province_company_name",
    "city_company_code",
    "city_company_name",
    "area_code",
    "area_name",
    "site_code",
    "site_name",
    "hos_code",
    "erp_code",
    "site_type",
    "operating_status",
  ],
  operations: [
    "source_site_status",
    "virtual_site",
    "business_type_code",
    "management_type_code",
    "service_items",
  ],
  contact: [
    "administrative_region",
    "address",
    "contact_name",
    "contact_phone",
    "contact_email",
  ],
} satisfies Record<string, (keyof DepartmentDetails)[]>;

type ProfileField =
  | keyof DepartmentDetails
  | "name"
  | "parent"
  | "sort_order"
  | "name_path"
  | "updated_at";

interface Props {
  department: Department;
  ancestors: Department[];
  onSaved: () => void;
}

export default function DepartmentProfilePanel({
  department,
  ancestors,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const timeZone = useServerTimezone();
  const [form] = Form.useForm<DepartmentProfileInput>();
  const [profile, setProfile] = useState<DepartmentProfile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editorTab, setEditorTab] = useState("organization");
  const [saving, setSaving] = useState(false);
  const { department_id: id } = department;
  const parent = ancestors.at(-1)?.name;
  const namePath =
    [...ancestors.map((node) => node.name), department.name].join("/") + "/";

  useEffect(() => {
    let active = true;
    void departmentsApi.profile(id).then(
      (data) => {
        if (active) setProfile(data);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id, retry]);

  const label = (field: ProfileField) =>
    t(`adminUsers.departments.fields.${field}`);
  const enabledOptions = [
    { value: true, label: t("adminUsers.departments.enabled") },
    { value: false, label: t("adminUsers.departments.disabled") },
  ];
  const virtualOptions = [
    { value: true, label: t("adminUsers.departments.yes") },
    { value: false, label: t("adminUsers.departments.no") },
  ];

  function fieldValue(field: ProfileField) {
    switch (field) {
      case "name":
        return department.name;
      case "parent":
        return parent;
      case "name_path":
        return namePath;
      case "sort_order":
        return profile?.sort_order;
      case "updated_at":
        return profile?.updated_at
          ? formatServerIsoDateTime(profile.updated_at, timeZone)
          : null;
      case "full_name":
        return profile?.details.full_name || department.name;
      case "enabled":
        return profile?.details.enabled ?? true
          ? enabledOptions[0].label
          : enabledOptions[1].label;
      case "virtual_site":
        return profile?.details.virtual_site == null
          ? null
          : profile.details.virtual_site
          ? virtualOptions[0].label
          : virtualOptions[1].label;
      default:
        return profile?.details[field];
    }
  }

  function displayField(field: ProfileField) {
    const value = fieldValue(field);
    return (
      <div
        key={field}
        className={
          field === "code_path" ||
          field === "name_path" ||
          field === "address" ||
          field === "service_items"
            ? styles.departmentProfileWide
            : undefined
        }
      >
        <dt>{label(field)}</dt>
        <dd>{value || value === 0 ? value : "—"}</dd>
      </div>
    );
  }

  function editField(field: keyof DepartmentDetails) {
    let input = <Input maxLength={2000} />;
    if (field === "enabled") input = <Select options={enabledOptions} />;
    if (field === "virtual_site")
      input = <Select allowClear options={virtualOptions} />;
    if (field === "effective_date") input = <Input type="date" />;
    return (
      <Form.Item key={field} name={["details", field]} label={label(field)}>
        {input}
      </Form.Item>
    );
  }

  async function save(values: DepartmentProfileInput) {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await departmentsApi.saveProfile(id, {
        ...values,
        name: values.name.trim(),
        sort_order: values.sort_order ?? null,
        details: {
          ...values.details,
          effective_date: values.details.effective_date || null,
        },
      });
      setProfile(saved);
      setEditing(false);
      onSaved();
    } catch (error) {
      void message.error(apiErrorMessage(error, t("common.saveFailed"), t));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message={t("adminUsers.departments.profileLoadFailed")}
        action={
          <Button
            onClick={() => {
              setLoadError(false);
              setRetry((value) => value + 1);
            }}
          >
            {t("common.refresh")}
          </Button>
        }
      />
    );
  }
  if (!profile) return <Spin />;

  const sections: [keyof typeof groups, ProfileField[]][] = [
    [
      "organization",
      [
        "name",
        "full_name",
        "parent",
        "enabled",
        "sort_order",
        "effective_date",
        "code_path",
        "name_path",
      ],
    ],
    ["station", groups.station],
    ["operations", groups.operations],
    ["contact", [...groups.contact, "updated_at"]],
  ];

  return (
    <div className={styles.departmentProfile}>
      <Tabs
        className={styles.departmentProfileTabs}
        tabBarExtraContent={
          <Button
            onClick={() => {
              setEditorTab("organization");
              setEditing(true);
            }}
          >
            {t("adminUsers.departments.editProfile")}
          </Button>
        }
        items={sections.map(([section, fields]) => ({
          key: section,
          label: t(`adminUsers.departments.sections.${section}`),
          children: (
            <dl className={styles.departmentProfileGrid}>
              {fields.map(displayField)}
            </dl>
          ),
        }))}
      />
      <Modal
        open={editing}
        title={t("adminUsers.departments.editProfile")}
        width={760}
        centered
        classNames={{
          content: styles.departmentEditorContent,
          header: styles.departmentEditorHeader,
          body: styles.departmentEditorBody,
          footer: styles.departmentEditorFooter,
        }}
        onCancel={() => setEditing(false)}
        onOk={() => form.submit()}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        cancelButtonProps={{ disabled: saving }}
        confirmLoading={saving}
        closable={!saving}
        keyboard={!saving}
        maskClosable={false}
        destroyOnHidden
      >
        <Form<DepartmentProfileInput>
          form={form}
          className={styles.departmentEditorForm}
          layout="vertical"
          clearOnDestroy
          disabled={saving}
          initialValues={{ ...profile, name: department.name }}
          onFinish={(values) => void save(values)}
          onFinishFailed={() => setEditorTab("organization")}
        >
          <Tabs
            className={styles.departmentEditorTabs}
            activeKey={editorTab}
            onChange={setEditorTab}
            items={Object.entries(groups).map(([section, fields]) => ({
              key: section,
              label: t(`adminUsers.departments.sections.${section}`),
              forceRender: true,
              className: styles.departmentEditorPane,
              children: (
                <div className={styles.departmentProfileGrid}>
                  {section === "organization" && (
                    <>
                      <Form.Item
                        name="name"
                        label={label("name")}
                        rules={[{ required: true, whitespace: true }]}
                      >
                        <Input maxLength={64} />
                      </Form.Item>
                      <Form.Item name="sort_order" label={label("sort_order")}>
                        <InputNumber
                          min={0}
                          max={2147483647}
                          precision={0}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </>
                  )}
                  {fields.map(editField)}
                </div>
              ),
            }))}
          />
        </Form>
      </Modal>
    </div>
  );
}
