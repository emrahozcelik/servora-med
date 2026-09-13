import {
  ApiError, boolean, items, JOB_CARD_STATUSES, json, nullableString, number, object, request,
  string, type JobCardStatus,
} from './api';
import {
  MEETING_OUTCOMES, UNSUCCESSFUL_VISIT_REASON_CODES,
  type MeetingOutcome, type UnsuccessfulVisitReasonCode,
} from '../jobs/jobs-api';

export const CUSTOMER_TYPES = ['clinic', 'hospital', 'dealer', 'company', 'other'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const CUSTOMER_STATUSES = ['prospect', 'active', 'inactive'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export type ContactStatusFilter = 'active' | 'inactive' | 'all';

export const customerTypeLabels: Record<CustomerType, string> = {
  clinic: 'Klinik', hospital: 'Hastane', dealer: 'Bayi', company: 'Firma', other: 'Diğer',
};
export const customerStatusLabels: Record<CustomerStatus, string> = {
  prospect: 'Aday', active: 'Aktif', inactive: 'Pasif',
};

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
  hasOperationHistory?: boolean;
};
export type CustomerSummary = Customer & {
  assignedStaffName: string | null;
  primaryContact: Pick<Contact, 'id' | 'name' | 'title'> | null;
};
export type CustomerDetail = CustomerSummary & {
  contacts: Contact[]; hasOperationHistory: boolean; openJobCount: number; completedJobCount: number;
};
export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };

export type JobHistoryItem = {
  id: string; title: string; type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';
  status: JobCardStatus; priority: string; scheduledAt: string | null; dueDate: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
  assignee: { id: string; name: string };
  customer: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  followUp: { sourceJobCardId: string } | null;
  childCount: number | null;
};

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
    ...(v.hasOperationHistory !== undefined ? { hasOperationHistory: boolean(v.hasOperationHistory, 'hasOperationHistory') } : {}),
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

function array(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}

function parseCustomerDetail(value: unknown): CustomerDetail {
  const v = object(value);
  return {
    ...parseCustomerSummary(v), contacts: array(v.contacts, 'contacts').map(parseContact),
    hasOperationHistory: boolean(v.hasOperationHistory, 'hasOperationHistory'),
    openJobCount: number(v.openJobCount, 'openJobCount'),
    completedJobCount: number(v.completedJobCount, 'completedJobCount'),
  };
}

function parseIdentity(value: unknown, field: string) {
  const v = object(value);
  return { id: string(v.id, `${field}.id`), name: string(v.name, `${field}.name`) };
}

export function parseJobHistoryItem(value: unknown): JobHistoryItem {
  const v = object(value);
  const followUp = v.followUp === null ? null : object(v.followUp);
  const childCount = v.childCount === null ? null : number(v.childCount, 'childCount');
  return {
    id: string(v.id, 'id'), title: string(v.title, 'title'),
    type: oneOf(v.type, 'type', ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING']),
    status: oneOf(v.status, 'status', JOB_CARD_STATUSES), priority: string(v.priority, 'priority'),
    scheduledAt: nullableString(v.scheduledAt, 'scheduledAt'), dueDate: nullableString(v.dueDate, 'dueDate'),
    createdAt: string(v.createdAt, 'createdAt'), updatedAt: string(v.updatedAt, 'updatedAt'),
    completedAt: nullableString(v.completedAt, 'completedAt'),
    assignee: parseIdentity(v.assignee, 'assignee'),
    customer: v.customer === null ? null : parseIdentity(v.customer, 'customer'),
    contact: v.contact === null ? null : parseIdentity(v.contact, 'contact'),
    followUp: followUp === null ? null : { sourceJobCardId: string(followUp.sourceJobCardId, 'followUp.sourceJobCardId') },
    childCount,
  };
}

export type CustomerOperationalSummary = {
  latestInteraction: {
    jobCardId: string; title: string; type: JobHistoryItem['type'];
    completedAt: string; assignee: { id: string; name: string };
  } | null;
  nextPlannedWork: {
    jobCardId: string; title: string; type: JobHistoryItem['type']; status: JobCardStatus;
    scheduledAt: string; assignee: { id: string; name: string };
  } | null;
  pendingReview: { waitingApprovalCount: number; revisionRequestedCount: number };
  latestMeetingOutcome: {
    jobCardId: string; meetingAt: string | null; outcome: MeetingOutcome;
    unsuccessfulReason: UnsuccessfulVisitReasonCode | null;
    meetingSummary: string | null; nextFollowUpAt: string | null;
  } | null;
  followUp: { jobCardId: string; kind: 'FOLLOW_UP_JOB' | 'SOURCE_JOB' } | null;
};

function parsePage<T>(value: unknown, parser: (entry: unknown) => T): Paginated<T> {
  const v = object(value);
  return { items: items(v).map(parser), total: number(v.total, 'total'),
    limit: number(v.limit, 'limit'), offset: number(v.offset, 'offset') };
}

function parseOperationalSummary(value: unknown): CustomerOperationalSummary {
  const v = object(value);
  const latest = v.latestInteraction === null ? null : object(v.latestInteraction);
  const next = v.nextPlannedWork === null ? null : object(v.nextPlannedWork);
  const pending = object(v.pendingReview);
  const meeting = v.latestMeetingOutcome === null ? null : object(v.latestMeetingOutcome);
  const followUp = v.followUp === null ? null : object(v.followUp);
  const unsuccessful = meeting === null
    ? null
    : meeting.unsuccessfulReason === null
      ? null
      : oneOf(meeting.unsuccessfulReason, 'latestMeetingOutcome.unsuccessfulReason', UNSUCCESSFUL_VISIT_REASON_CODES);
  return {
    latestInteraction: latest === null ? null : {
      jobCardId: string(latest.jobCardId, 'latestInteraction.jobCardId'),
      title: string(latest.title, 'latestInteraction.title'),
      type: oneOf(latest.type, 'latestInteraction.type', ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING']),
      completedAt: string(latest.completedAt, 'latestInteraction.completedAt'),
      assignee: parseIdentity(latest.assignee, 'latestInteraction.assignee'),
    },
    nextPlannedWork: next === null ? null : {
      jobCardId: string(next.jobCardId, 'nextPlannedWork.jobCardId'),
      title: string(next.title, 'nextPlannedWork.title'),
      type: oneOf(next.type, 'nextPlannedWork.type', ['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING']),
      status: oneOf(next.status, 'nextPlannedWork.status', JOB_CARD_STATUSES),
      scheduledAt: string(next.scheduledAt, 'nextPlannedWork.scheduledAt'),
      assignee: parseIdentity(next.assignee, 'nextPlannedWork.assignee'),
    },
    pendingReview: {
      waitingApprovalCount: number(pending.waitingApprovalCount, 'pendingReview.waitingApprovalCount'),
      revisionRequestedCount: number(pending.revisionRequestedCount, 'pendingReview.revisionRequestedCount'),
    },
    latestMeetingOutcome: meeting === null ? null : {
      jobCardId: string(meeting.jobCardId, 'latestMeetingOutcome.jobCardId'),
      meetingAt: nullableString(meeting.meetingAt, 'latestMeetingOutcome.meetingAt'),
      outcome: oneOf(meeting.outcome, 'latestMeetingOutcome.outcome', MEETING_OUTCOMES),
      unsuccessfulReason: unsuccessful,
      meetingSummary: nullableString(meeting.meetingSummary, 'latestMeetingOutcome.meetingSummary'),
      nextFollowUpAt: nullableString(meeting.nextFollowUpAt, 'latestMeetingOutcome.nextFollowUpAt'),
    },
    followUp: followUp === null ? null : {
      jobCardId: string(followUp.jobCardId, 'followUp.jobCardId'),
      kind: oneOf(followUp.kind, 'followUp.kind', ['FOLLOW_UP_JOB', 'SOURCE_JOB']),
    },
  };
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
export const getCustomerOperationalSummary = async (customerId: string) =>
  parseOperationalSummary(await request(`${customerPath(customerId)}/operational-summary`));
export const listCustomerJobs = async (customerId: string, filters: {
  status?: 'open' | 'completed' | 'all'; type?: JobHistoryItem['type']; limit?: number; offset?: number;
} = {}) => parsePage(
  await request(`${customerPath(customerId)}/jobs${query(filters)}`), parseJobHistoryItem,
);
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
export const deleteContact = async (customerId: string, contactId: string, expectedVersion: number) => {
  await request(contactPath(customerId, contactId), json('DELETE', { expectedVersion }));
};
export async function makePrimaryContact(customerId: string, contactId: string, expectedVersion: number) {
  const v = object(await request(`${contactPath(customerId, contactId)}/make-primary`,
    json('POST', { expectedVersion })));
  return { contact: parseContact(v.contact),
    previousPrimaryContactId: nullableString(v.previousPrimaryContactId, 'previousPrimaryContactId') };
}
