import {
  ApiError, boolean, json, nullableString, number, object, request, string,
  type UserRole,
} from './api';
import { request as apiRequest } from './api';
import { parseJobHistoryItem, type JobHistoryItem, type Paginated } from './crm-api';

export type ManagedUser = {
  id: string; organizationId: string; name: string; email: string; role: UserRole;
  mustChangePassword: boolean; isActive: boolean; version: number;
  lastLoginAt: string | null; createdAt: string; updatedAt: string;
};
export type StaffCounters = { open: number; waitingApproval: number; revisionRequested: number; completedThisMonth: number; overdue: number };
export type StaffProfile = {
  id: string; user: ManagedUser; title: string | null; phone: string | null; region: string | null;
  managerUserId: string | null; managerName: string | null; version: number; counters: StaffCounters;
};
export type StaffProfileFields = { title: string | null; phone: string | null; region: string | null; managerUserId: string | null };
export type CreateUserInput = { name: string; email: string; role: UserRole; temporaryPassword: string; staffProfile?: StaffProfileFields };
export const STAFF_OFFBOARDING_REASON_CODES = [
  'ACCESS_ENDED', 'ROLE_CHANGED', 'ACCOUNT_CORRECTION', 'OTHER_ADMINISTRATIVE',
] as const;
export type StaffOffboardingReasonCode = (typeof STAFF_OFFBOARDING_REASON_CODES)[number];
export type StaffOffboardingPlan = {
  target: { id: string; organizationId: string; role: 'STAFF'; isActive: true; version: number };
  jobs: Array<{ id: string; status: string; version: number; assignedTo: string }>;
  customers: Array<{ id: string; assignedStaffUserId: string; version: number }>;
  calendar: Array<{ id: string; assignedUserId: string; status: 'ACTIVE'; version: number; startsAt: string; endsAt: string }>;
  followUps: Array<{ jobCardId: string; proposedAssignee: string; proposedAt: string; version: number }>;
  reminders: Array<{ id: string; recipientUserId: string; state: 'PENDING' | 'CLAIMED'; remindAt: string; nextAttemptAt: string }>;
  jobConversations: Array<{ jobCardId: string; conversationId: string }>;
  sessions: { activeCount: number };
  planHash: string;
};
export type StaffOffboardingExecuteInput = {
  clientActionId: string;
  planHash: string;
  reasonCode: StaffOffboardingReasonCode;
  jobDecisions: Array<{ jobCardId: string; replacementUserId: string }>;
  calendarDecisions: Array<{ calendarEventId: string; replacementUserId: string }>;
  followUpDecisions: Array<{ jobCardId: string; replacementUserId: string }>;
  customerDecisions: Array<{ customerId: string; action: 'REASSIGN' | 'UNASSIGN'; replacementUserId?: string }>;
  reminderDecisions: Array<{ reminderId: string; action: 'TRANSFER' | 'CANCEL'; replacementUserId?: string }>;
};
export type StaffOffboardingResponse = {
  status: 'OFFBOARDED';
  targetUserId: string;
  planHash: string;
  summary: {
    jobCardsTransferred: number;
    customersReassigned: number;
    customersUnassigned: number;
    calendarAssignmentsTransferred: number;
    followUpAssignmentsTransferred: number;
    remindersHandled: number;
  };
};
export type { JobHistoryItem } from './crm-api';

function parseUser(value: unknown): ManagedUser {
  const v = object(value);
  return { id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'), name: string(v.name, 'name'),
    email: string(v.email, 'email'), role: string(v.role, 'role') as UserRole,
    mustChangePassword: boolean(v.mustChangePassword, 'mustChangePassword'), isActive: boolean(v.isActive, 'isActive'),
    version: number(v.version, 'version'), lastLoginAt: nullableString(v.lastLoginAt, 'lastLoginAt'),
    createdAt: string(v.createdAt, 'createdAt'), updatedAt: string(v.updatedAt, 'updatedAt') };
}
function parseProfile(value: unknown): StaffProfile {
  const v = object(value); const counters = object(v.counters);
  return { id: string(v.id, 'id'), user: parseUser(v.user), title: nullableString(v.title, 'title'),
    phone: nullableString(v.phone, 'phone'), region: nullableString(v.region, 'region'),
    managerUserId: nullableString(v.managerUserId, 'managerUserId'), managerName: nullableString(v.managerName, 'managerName'),
    version: number(v.version, 'version'), counters: { open: number(counters.open, 'open'), waitingApproval: number(counters.waitingApproval, 'waitingApproval'),
      revisionRequested: number(counters.revisionRequested, 'revisionRequested'), completedThisMonth: number(counters.completedThisMonth, 'completedThisMonth'), overdue: number(counters.overdue, 'overdue') } };
}
function array(value: unknown) {
  if (!Array.isArray(value)) throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz liste yanıtı alındı.');
  return value;
}

function exactObject(value: unknown, fields: readonly string[], label: string) {
  const parsed = object(value);
  if (Object.keys(parsed).some((key) => !fields.includes(key)) || fields.some((key) => !(key in parsed))) {
    throw new ApiError(0, 'INVALID_RESPONSE', `Sunucudan geçersiz ${label} yanıtı alındı.`);
  }
  return parsed;
}

function positiveInteger(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return parsed;
}

function isoDate(value: unknown, field: string) {
  const parsed = string(value, field);
  if (!Number.isFinite(Date.parse(parsed))) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return parsed;
}

function hash(value: unknown, field: string) {
  const parsed = string(value, field);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return parsed;
}

function parseOffboardingPlan(value: unknown, expectedTargetUserId: string): StaffOffboardingPlan {
  const raw = exactObject(value, [
    'target', 'jobs', 'customers', 'calendar', 'followUps', 'reminders',
    'jobConversations', 'sessions', 'planHash',
  ], 'Staff offboarding planı');
  const target = exactObject(raw.target, ['id', 'organizationId', 'role', 'isActive', 'version'], 'Staff offboarding hedefi');
  const targetId = string(target.id, 'target.id');
  if (targetId !== expectedTargetUserId || target.role !== 'STAFF' || target.isActive !== true) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz Staff offboarding hedefi alındı.');
  }
  const parseList = <T>(input: unknown, parse: (entry: unknown) => T) => array(input).map(parse);
  const jobs = parseList(raw.jobs, (entry) => {
    const item = exactObject(entry, ['id', 'status', 'version', 'assignedTo'], 'JobCard sorumluluğu');
    return { id: string(item.id, 'jobs.id'), status: string(item.status, 'jobs.status'),
      version: positiveInteger(item.version, 'jobs.version'), assignedTo: string(item.assignedTo, 'jobs.assignedTo') };
  });
  const customers = parseList(raw.customers, (entry) => {
    const item = exactObject(entry, ['id', 'assignedStaffUserId', 'version'], 'müşteri sorumluluğu');
    return { id: string(item.id, 'customers.id'), assignedStaffUserId: string(item.assignedStaffUserId, 'customers.assignedStaffUserId'),
      version: positiveInteger(item.version, 'customers.version') };
  });
  const calendar = parseList(raw.calendar, (entry) => {
    const item = exactObject(entry, ['id', 'assignedUserId', 'status', 'version', 'startsAt', 'endsAt'], 'takvim sorumluluğu');
    if (item.status !== 'ACTIVE') throw new ApiError(0, 'INVALID_RESPONSE', 'Yanıtta calendar.status alanı geçersiz.');
    return { id: string(item.id, 'calendar.id'), assignedUserId: string(item.assignedUserId, 'calendar.assignedUserId'),
      status: 'ACTIVE' as const, version: positiveInteger(item.version, 'calendar.version'), startsAt: isoDate(item.startsAt, 'calendar.startsAt'),
      endsAt: isoDate(item.endsAt, 'calendar.endsAt') };
  });
  const followUps = parseList(raw.followUps, (entry) => {
    const item = exactObject(entry, ['jobCardId', 'proposedAssignee', 'proposedAt', 'version'], 'takip sorumluluğu');
    return { jobCardId: string(item.jobCardId, 'followUps.jobCardId'), proposedAssignee: string(item.proposedAssignee, 'followUps.proposedAssignee'),
      proposedAt: isoDate(item.proposedAt, 'followUps.proposedAt'), version: positiveInteger(item.version, 'followUps.version') };
  });
  const reminders = parseList(raw.reminders, (entry) => {
    const item = exactObject(entry, ['id', 'recipientUserId', 'state', 'remindAt', 'nextAttemptAt'], 'hatırlatıcı sorumluluğu');
    if (item.state !== 'PENDING' && item.state !== 'CLAIMED') throw new ApiError(0, 'INVALID_RESPONSE', 'Yanıtta reminders.state alanı geçersiz.');
    return { id: string(item.id, 'reminders.id'), recipientUserId: string(item.recipientUserId, 'reminders.recipientUserId'),
      state: item.state as 'PENDING' | 'CLAIMED', remindAt: isoDate(item.remindAt, 'reminders.remindAt'), nextAttemptAt: isoDate(item.nextAttemptAt, 'reminders.nextAttemptAt') };
  });
  const jobConversations = parseList(raw.jobConversations, (entry) => {
    const item = exactObject(entry, ['jobCardId', 'conversationId'], 'iş konuşması sorumluluğu');
    return { jobCardId: string(item.jobCardId, 'jobConversations.jobCardId'), conversationId: string(item.conversationId, 'jobConversations.conversationId') };
  });
  const sessions = exactObject(raw.sessions, ['activeCount'], 'aktif oturum özeti');
  return { target: { id: targetId, organizationId: string(target.organizationId, 'target.organizationId'), role: 'STAFF', isActive: true,
    version: positiveInteger(target.version, 'target.version') }, jobs, customers, calendar, followUps, reminders, jobConversations,
    sessions: { activeCount: nonNegativeInteger(sessions.activeCount, 'sessions.activeCount') }, planHash: hash(raw.planHash, 'planHash') };
}

function parseOffboardingResponse(value: unknown, expectedTargetUserId: string, expectedPlanHash: string): StaffOffboardingResponse {
  const raw = exactObject(value, ['status', 'targetUserId', 'planHash', 'summary'], 'Staff offboarding sonucu');
  const summary = exactObject(raw.summary, [
    'jobCardsTransferred', 'customersReassigned', 'customersUnassigned',
    'calendarAssignmentsTransferred', 'followUpAssignmentsTransferred', 'remindersHandled',
  ], 'Staff offboarding özeti');
  if (raw.status !== 'OFFBOARDED' || raw.targetUserId !== expectedTargetUserId || raw.planHash !== expectedPlanHash) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Staff offboarding sonucu beklenen işlemle eşleşmiyor.');
  }
  return { status: 'OFFBOARDED', targetUserId: expectedTargetUserId, planHash: expectedPlanHash, summary: {
    jobCardsTransferred: nonNegativeInteger(summary.jobCardsTransferred, 'summary.jobCardsTransferred'),
    customersReassigned: nonNegativeInteger(summary.customersReassigned, 'summary.customersReassigned'),
    customersUnassigned: nonNegativeInteger(summary.customersUnassigned, 'summary.customersUnassigned'),
    calendarAssignmentsTransferred: nonNegativeInteger(summary.calendarAssignmentsTransferred, 'summary.calendarAssignmentsTransferred'),
    followUpAssignmentsTransferred: nonNegativeInteger(summary.followUpAssignmentsTransferred, 'summary.followUpAssignmentsTransferred'),
    remindersHandled: nonNegativeInteger(summary.remindersHandled, 'summary.remindersHandled'),
  } };
}

export const listUsers = async () => array(await request('/api/users')).map(parseUser);
export const getUser = async (id: string) => parseUser(await request(`/api/users/${id}`));
export const createUser = async (input: CreateUserInput) => parseUser(await request('/api/users', json('POST', input)));
export const updateUser = async (id: string, input: { expectedVersion: number; name: string }) => parseUser(await request(`/api/users/${id}`, json('PATCH', input)));
export const changeUserRole = async (id: string, input: { expectedVersion: number; role: 'ADMIN' | 'MANAGER' }) => parseUser(await request(`/api/users/${id}/change-role`, json('POST', input)));
export const activateUser = async (id: string, expectedVersion: number) => parseUser(await request(`/api/users/${id}/activate`, json('POST', { expectedVersion })));
export const deactivateUser = async (id: string, expectedVersion: number) => parseUser(await request(`/api/users/${id}/deactivate`, json('POST', { expectedVersion })));
export const resetUserPassword = async (id: string, input: { expectedVersion: number; temporaryPassword: string }) => parseUser(await request(`/api/users/${id}/reset-password`, json('POST', input)));
export const previewStaffOffboarding = async (id: string) => parseOffboardingPlan(
  await request(`/api/users/${encodeURIComponent(id)}/offboarding/preview`, json('POST', {})), id,
);
export const executeStaffOffboarding = async (id: string, input: StaffOffboardingExecuteInput) => parseOffboardingResponse(
  await request(`/api/users/${encodeURIComponent(id)}/offboarding/execute`, json('POST', input)), id, input.planHash,
);
export const listStaff = async (status: 'active' | 'inactive' | 'all' = 'active') => array(await request(`/api/staff?status=${status}`)).map(parseProfile);
export const getOwnStaffProfile = async () => parseProfile(await request('/api/staff/me'));
export const getStaffProfile = async (id: string) => parseProfile(await request(`/api/staff/${id}`));
export const updateStaffProfile = async (id: string, input: StaffProfileFields & { expectedVersion: number }) => parseProfile(await request(`/api/staff/${id}`, json('PATCH', input)));

function historyQuery(filters: { status?: 'open' | 'completed' | 'all'; type?: JobHistoryItem['type']; limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function parseHistoryPage(value: unknown): Paginated<JobHistoryItem> {
  const raw = object(value);
  if (!Array.isArray(raw.items)) throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz iş geçmişi listesi alındı.');
  return {
    items: raw.items.map(parseJobHistoryItem),
    total: number(raw.total, 'total'), limit: number(raw.limit, 'limit'), offset: number(raw.offset, 'offset'),
  };
}

export const listOwnStaffJobs = async (filters: { status?: 'open' | 'completed' | 'all'; type?: JobHistoryItem['type']; limit?: number; offset?: number } = {}) =>
  parseHistoryPage(await apiRequest(`/api/staff/me/jobs${historyQuery(filters)}`));
export const listStaffJobs = async (id: string, filters: { status?: 'open' | 'completed' | 'all'; type?: JobHistoryItem['type']; limit?: number; offset?: number } = {}) =>
  parseHistoryPage(await apiRequest(`/api/staff/${encodeURIComponent(id)}/jobs${historyQuery(filters)}`));
