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
