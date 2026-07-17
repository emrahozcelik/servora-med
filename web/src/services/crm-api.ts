import {
  ApiError, boolean, items, JOB_CARD_STATUSES, json, nullableString, number, object, request,
  string, type JobCardStatus,
} from './api';

export const CUSTOMER_TYPES = ['clinic', 'hospital', 'dealer', 'company', 'other'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const CUSTOMER_STATUSES = ['prospect', 'active', 'inactive'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export type ContactStatusFilter = 'active' | 'inactive' | 'all';

export type Customer = {
  id: string; organizationId: string; name: string; customerType: CustomerType;
  taxNumber: string | null; phone: string | null; email: string | null;
  city: string | null; district: string | null; address: string | null;
  assignedStaffUserId: string | null; status: CustomerStatus; version: number;
};
export type Contact = {
  id: string; organizationId: string; customerId: string; name: string;
  title: string | null; phone: string | null; email: string | null;
  isPrimary: boolean; isActive: boolean; version: number;
};
export type CustomerSummary = Customer & {
  assignedStaffName: string | null;
  primaryContact: Pick<Contact, 'id' | 'name' | 'title'> | null;
};
export type CustomerJobSummary = {
  id: string; title: string; status: JobCardStatus; assignedTo: string;
  dueDate: string | null; createdAt: string; updatedAt: string;
  managerApprovedAt: string | null;
};
export type CustomerDetail = CustomerSummary & {
  contacts: Contact[]; openJobs: CustomerJobSummary[]; completedJobs: CustomerJobSummary[];
};
export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };

export type CustomerFilters = Partial<{
  q: string; status: CustomerStatus; customerType: CustomerType;
  assignedStaffUserId: string; city: string; unassigned: boolean; limit: number; offset: number;
}>;
export type ContactFilters = Partial<{
  q: string; status: ContactStatusFilter; limit: number; offset: number;
}>;
export type CustomerFields = {
  name: string; customerType: CustomerType; taxNumber: string | null; phone: string | null;
  email: string | null; city: string | null; district: string | null; address: string | null;
  assignedStaffUserId: string | null;
};
export type CreateCustomerInput = CustomerFields & { status?: CustomerStatus };
export type UpdateCustomerInput = CustomerFields & { expectedVersion: number };
export type ContactFields = { name: string; title: string | null; phone: string | null; email: string | null };
export type UpdateContactInput = ContactFields & { expectedVersion: number };

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const parsed = string(value, field);
  if (!allowed.includes(parsed as T)) {
    throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  }
  return parsed as T;
}

function parseCustomer(value: unknown): Customer {
  const v = object(value);
  return {
    id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    name: string(v.name, 'name'), customerType: oneOf(v.customerType, 'customerType', CUSTOMER_TYPES),
    taxNumber: nullableString(v.taxNumber, 'taxNumber'), phone: nullableString(v.phone, 'phone'),
    email: nullableString(v.email, 'email'), city: nullableString(v.city, 'city'),
    district: nullableString(v.district, 'district'), address: nullableString(v.address, 'address'),
    assignedStaffUserId: nullableString(v.assignedStaffUserId, 'assignedStaffUserId'),
    status: oneOf(v.status, 'status', CUSTOMER_STATUSES), version: number(v.version, 'version'),
  };
}

function parseContact(value: unknown): Contact {
  const v = object(value);
  return {
    id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    customerId: string(v.customerId, 'customerId'), name: string(v.name, 'name'),
    title: nullableString(v.title, 'title'), phone: nullableString(v.phone, 'phone'),
    email: nullableString(v.email, 'email'), isPrimary: boolean(v.isPrimary, 'isPrimary'),
    isActive: boolean(v.isActive, 'isActive'), version: number(v.version, 'version'),
  };
}

function parseCustomerSummary(value: unknown): CustomerSummary {
  const v = object(value);
  const primary = v.primaryContact === null ? null : object(v.primaryContact);
  return {
    ...parseCustomer(v), assignedStaffName: nullableString(v.assignedStaffName, 'assignedStaffName'),
    primaryContact: primary === null ? null : {
      id: string(primary.id, 'primaryContact.id'), name: string(primary.name, 'primaryContact.name'),
      title: nullableString(primary.title, 'primaryContact.title'),
    },
  };
}

function parseJobSummary(value: unknown): CustomerJobSummary {
  const v = object(value);
  return {
    id: string(v.id, 'id'), title: string(v.title, 'title'),
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), assignedTo: string(v.assignedTo, 'assignedTo'),
    dueDate: nullableString(v.dueDate, 'dueDate'), createdAt: string(v.createdAt, 'createdAt'),
    updatedAt: string(v.updatedAt, 'updatedAt'),
    managerApprovedAt: nullableString(v.managerApprovedAt, 'managerApprovedAt'),
  };
}

function array(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}

function parseCustomerDetail(value: unknown): CustomerDetail {
  const v = object(value);
  return {
    ...parseCustomerSummary(v), contacts: array(v.contacts, 'contacts').map(parseContact),
    openJobs: array(v.openJobs, 'openJobs').map(parseJobSummary),
    completedJobs: array(v.completedJobs, 'completedJobs').map(parseJobSummary),
  };
}

function parsePage<T>(value: unknown, parser: (entry: unknown) => T): Paginated<T> {
  const v = object(value);
  return { items: items(v).map(parser), total: number(v.total, 'total'),
    limit: number(v.limit, 'limit'), offset: number(v.offset, 'offset') };
}

function query(filters: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

const segment = (value: string) => encodeURIComponent(value);
const customerPath = (customerId: string) => `/api/customers/${segment(customerId)}`;
const contactPath = (customerId: string, contactId?: string) =>
  `${customerPath(customerId)}/contacts${contactId === undefined ? '' : `/${segment(contactId)}`}`;

export const listCustomers = async (filters: CustomerFilters = {}) => parsePage(
  await request(`/api/customers${query(filters)}`), parseCustomerSummary,
);
export const getCustomer = async (id: string) => parseCustomerDetail(await request(customerPath(id)));
export const createCustomer = async (input: CreateCustomerInput) =>
  parseCustomer(await request('/api/customers', json('POST', input)));
export const updateCustomer = async (id: string, input: UpdateCustomerInput) =>
  parseCustomer(await request(customerPath(id), json('PATCH', input)));
export const activateCustomer = async (id: string, expectedVersion: number) =>
  parseCustomer(await request(`${customerPath(id)}/activate`, json('POST', { expectedVersion })));
export const deactivateCustomer = async (id: string, expectedVersion: number) =>
  parseCustomer(await request(`${customerPath(id)}/deactivate`, json('POST', { expectedVersion })));
export const deleteCustomer = async (id: string, expectedVersion: number) => {
  await request(customerPath(id), json('DELETE', { expectedVersion }));
};

export const listContacts = async (customerId: string, filters: ContactFilters = {}) => parsePage(
  await request(`${contactPath(customerId)}${query(filters)}`), parseContact,
);
export const getContact = async (customerId: string, contactId: string) =>
  parseContact(await request(contactPath(customerId, contactId)));
export const createContact = async (customerId: string, input: ContactFields) =>
  parseContact(await request(contactPath(customerId), json('POST', input)));
export const updateContact = async (customerId: string, contactId: string, input: UpdateContactInput) =>
  parseContact(await request(contactPath(customerId, contactId), json('PATCH', input)));
export const activateContact = async (customerId: string, contactId: string, expectedVersion: number) =>
  parseContact(await request(`${contactPath(customerId, contactId)}/activate`, json('POST', { expectedVersion })));
export const deactivateContact = async (customerId: string, contactId: string, expectedVersion: number) =>
  parseContact(await request(`${contactPath(customerId, contactId)}/deactivate`, json('POST', { expectedVersion })));
export async function makePrimaryContact(customerId: string, contactId: string, expectedVersion: number) {
  const v = object(await request(`${contactPath(customerId, contactId)}/make-primary`,
    json('POST', { expectedVersion })));
  return { contact: parseContact(v.contact),
    previousPrimaryContactId: nullableString(v.previousPrimaryContactId, 'previousPrimaryContactId') };
}
