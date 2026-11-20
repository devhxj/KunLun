import { request } from "../request";

export interface Department {
  department_id: string;
  parent_id: string | null;
  name: string;
}

export interface DepartmentDetails {
  full_name?: string | null;
  enabled?: boolean;
  effective_date?: string | null;
  code_path?: string | null;
  province_company_code?: string | null;
  province_company_name?: string | null;
  city_company_code?: string | null;
  city_company_name?: string | null;
  area_code?: string | null;
  area_name?: string | null;
  site_code?: string | null;
  site_name?: string | null;
  hos_code?: string | null;
  erp_code?: string | null;
  site_type?: string | null;
  operating_status?: string | null;
  source_site_status?: string | null;
  virtual_site?: boolean | null;
  business_type_code?: string | null;
  management_type_code?: string | null;
  service_items?: string | null;
  administrative_region?: string | null;
  address?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
}

export interface DepartmentProfileInput {
  name: string;
  sort_order: number | null;
  details: DepartmentDetails;
}

export interface DepartmentProfile extends Department, DepartmentProfileInput {
  updated_at: string | null;
}

const path = "/departments";

export const departmentsApi = {
  list: () => request<Department[]>(path),
  create: (name: string, parentId: string | null) =>
    request<Department>(path, {
      method: "POST",
      body: JSON.stringify({ name, parent_id: parentId }),
    }),
  rename: (id: string, name: string) =>
    request<Department>(`${path}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  remove: (id: string) =>
    request<void>(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  profile: (id: string) =>
    request<DepartmentProfile>(`${path}/${encodeURIComponent(id)}/profile`),
  saveProfile: (id: string, values: DepartmentProfileInput) =>
    request<DepartmentProfile>(`${path}/${encodeURIComponent(id)}/profile`, {
      method: "PUT",
      body: JSON.stringify(values),
    }),
};
