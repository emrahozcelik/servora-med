import type { UserRole } from '../auth/types.js';
import type { JobCardStatus } from '../job-cards/types.js';

export const CUSTOMER_TYPES = ['clinic', 'hospital', 'dealer', 'company', 'other'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CUSTOMER_STATUSES = ['prospect', 'active', 'inactive'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export type ContactStatusFilter = 'active' | 'inactive' | 'all';

export type CrmActor = { id: string; organizationId: string; role: UserRole };

export type Customer = {
  id: string;
  organizationId: string;
  name: string;
  customerType: CustomerType;
  taxNumber: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  assignedStaffUserId: string | null;
  status: CustomerStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type Contact = {
  id: string;
  organizationId: string;
  customerId: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomerSummary = Customer & {
  assignedStaffName: string | null;
  primaryContact: Pick<Contact, 'id' | 'name' | 'title'> | null;
};

export type CustomerJobSummary = {
  id: string;
  title: string;
  status: JobCardStatus;
  assignedTo: string;
  dueDate: string | null;
  createdAt: Date;
  updatedAt: Date;
  managerApprovedAt: Date | null;
};

export type CustomerDetail = CustomerSummary & {
  contacts: Contact[];
  openJobs: CustomerJobSummary[];
  completedJobs: CustomerJobSummary[];
};

export type CustomerRow = {
  id: string; organization_id: string; name: string; customer_type: CustomerType;
  tax_number: string | null; phone: string | null; email: string | null;
  city: string | null; district: string | null; address: string | null;
  assigned_staff_user_id: string | null; status: CustomerStatus; version: number;
  created_at: Date; updated_at: Date; assigned_staff_name?: string | null;
  primary_contact_id?: string | null; primary_contact_name?: string | null;
  primary_contact_title?: string | null;
};

export type ContactRow = {
  id: string; organization_id: string; customer_id: string; name: string;
  title: string | null; phone: string | null; email: string | null;
  is_primary: boolean; is_active: boolean; version: number;
  created_at: Date; updated_at: Date;
};

export type JobSummaryRow = {
  id: string; title: string; status: JobCardStatus; assigned_to: string;
  due_date: string | null; created_at: Date; updated_at: Date;
  manager_approved_at: Date | null;
};

export function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    customerType: row.customer_type, taxNumber: row.tax_number, phone: row.phone,
    email: row.email, city: row.city, district: row.district, address: row.address,
    assignedStaffUserId: row.assigned_staff_user_id, status: row.status,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function mapCustomerSummary(row: CustomerRow): CustomerSummary {
  return {
    ...mapCustomer(row),
    assignedStaffName: row.assigned_staff_name ?? null,
    primaryContact: row.primary_contact_id && row.primary_contact_name
      ? { id: row.primary_contact_id, name: row.primary_contact_name, title: row.primary_contact_title ?? null }
      : null,
  };
}

export function mapContact(row: ContactRow): Contact {
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id,
    name: row.name, title: row.title, phone: row.phone, email: row.email,
    isPrimary: row.is_primary, isActive: row.is_active, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function mapJobSummary(row: JobSummaryRow): CustomerJobSummary {
  return {
    id: row.id, title: row.title, status: row.status, assignedTo: row.assigned_to,
    dueDate: row.due_date, createdAt: row.created_at, updatedAt: row.updated_at,
    managerApprovedAt: row.manager_approved_at,
  };
}

export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };

export type CustomerFilters = {
  q: string | null;
  status: CustomerStatus | null;
  customerType: CustomerType | null;
  assignedStaffUserId: string | null;
  city: string | null;
  unassigned: boolean;
  limit: number;
  offset: number;
};

export type ContactFilters = {
  q: string | null;
  status: ContactStatusFilter;
  limit: number;
  offset: number;
};

export type CreateCustomerRecord = Omit<Customer, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type UpdateCustomerRecord = Omit<CreateCustomerRecord, 'status'> & {
  customerId: string;
  expectedVersion: number;
};
export type SetCustomerStatusRecord = {
  organizationId: string;
  customerId: string;
  expectedVersion: number;
  status: CustomerStatus;
};

export type CreateContactRecord = Omit<Contact, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type UpdateContactRecord = Pick<Contact, 'organizationId' | 'customerId' | 'name' | 'title' | 'phone' | 'email'> & {
  contactId: string;
  expectedVersion: number;
};
export type SetContactActiveRecord = {
  organizationId: string;
  customerId: string;
  contactId: string;
  expectedVersion: number;
  isActive: boolean;
};

export type CrmUserRecord = {
  id: string;
  organizationId: string;
  role: UserRole;
  isActive: boolean;
};

export const CRM_AUDIT_EVENTS = [
  'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED', 'CUSTOMER_ASSIGNEE_CHANGED',
  'CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED',
  'CONTACT_FIELDS_UPDATED', 'CONTACT_MADE_PRIMARY', 'CONTACT_ACTIVATED',
  'CONTACT_DEACTIVATED',
] as const;
export type CrmAuditEvent = (typeof CRM_AUDIT_EVENTS)[number];

export type AppendCrmAuditInput = {
  organizationId: string;
  actorUserId: string;
  subjectType: 'CUSTOMER' | 'CONTACT';
  subjectId: string;
  eventType: CrmAuditEvent;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export function normalizeTaxNumber(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().replace(/[\s.\-/]+/g, '').toUpperCase();
  return normalized || null;
}
