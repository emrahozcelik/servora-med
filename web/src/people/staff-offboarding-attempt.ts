import {
  STAFF_OFFBOARDING_REASON_CODES,
  type StaffOffboardingExecuteInput,
  type StaffOffboardingReasonCode,
} from '../services/people-api';

export const STAFF_OFFBOARDING_ATTEMPT_STORAGE_KEY = 'servora:r4b:staff-offboarding-attempt:v1';

export type StaffOffboardingAttempt = Readonly<{
  request: StaffOffboardingExecuteInput;
}>;

export type StaffOffboardingAttemptStatus = 'ACTIVE' | 'RETIRED';

type StoredStaffOffboardingAttempt = Readonly<{
  schemaVersion: 2;
  status: StaffOffboardingAttemptStatus;
  targetUserId: string;
  request: StaffOffboardingExecuteInput;
  createdAt: string;
}>;

export type StaffOffboardingAttemptRecovery =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'valid'; status: StaffOffboardingAttemptStatus; targetUserId: string;
    attempt: StaffOffboardingAttempt; createdAt: string }>;

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || required.some((key) => !(key in record))) return null;
  return record;
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseSimpleDecisions(value: unknown, idField: 'jobCardId' | 'calendarEventId') {
  if (!Array.isArray(value)) return null;
  const parsed: Array<{ jobCardId: string; replacementUserId: string } | { calendarEventId: string; replacementUserId: string }> = [];
  for (const raw of value) {
    const item = exactRecord(raw, [idField, 'replacementUserId']);
    const id = item ? nonEmptyString(item[idField]) : null;
    const replacementUserId = item ? nonEmptyString(item.replacementUserId) : null;
    if (!id || !replacementUserId) return null;
    parsed.push(idField === 'jobCardId' ? { jobCardId: id, replacementUserId } : { calendarEventId: id, replacementUserId });
  }
  const ids = parsed.map((item) => 'jobCardId' in item ? item.jobCardId : item.calendarEventId);
  return new Set(ids).size === ids.length ? parsed : null;
}

function parseCustomerDecisions(value: unknown): StaffOffboardingExecuteInput['customerDecisions'] | null {
  if (!Array.isArray(value)) return null;
  const parsed: StaffOffboardingExecuteInput['customerDecisions'] = [];
  for (const raw of value) {
    const item = exactRecord(raw, ['customerId', 'action'], ['replacementUserId']);
    const customerId = item ? nonEmptyString(item.customerId) : null;
    if (!item || !customerId) return null;
    if (item.action === 'UNASSIGN' && item.replacementUserId === undefined) parsed.push({ customerId, action: 'UNASSIGN' });
    else if (item.action === 'REASSIGN') {
      const replacementUserId = nonEmptyString(item.replacementUserId);
      if (!replacementUserId) return null;
      parsed.push({ customerId, action: 'REASSIGN', replacementUserId });
    } else return null;
  }
  return new Set(parsed.map((item) => item.customerId)).size === parsed.length ? parsed : null;
}

function parseReminderDecisions(value: unknown): StaffOffboardingExecuteInput['reminderDecisions'] | null {
  if (!Array.isArray(value)) return null;
  const parsed: StaffOffboardingExecuteInput['reminderDecisions'] = [];
  for (const raw of value) {
    const item = exactRecord(raw, ['reminderId', 'action'], ['replacementUserId']);
    const reminderId = item ? nonEmptyString(item.reminderId) : null;
    if (!item || !reminderId) return null;
    if (item.action === 'CANCEL' && item.replacementUserId === undefined) parsed.push({ reminderId, action: 'CANCEL' });
    else if (item.action === 'TRANSFER') {
      const replacementUserId = nonEmptyString(item.replacementUserId);
      if (!replacementUserId) return null;
      parsed.push({ reminderId, action: 'TRANSFER', replacementUserId });
    } else return null;
  }
  return new Set(parsed.map((item) => item.reminderId)).size === parsed.length ? parsed : null;
}

function parseRequest(value: unknown): StaffOffboardingExecuteInput | null {
  const raw = exactRecord(value, [
    'clientActionId', 'planHash', 'reasonCode', 'jobDecisions', 'customerDecisions',
    'calendarDecisions', 'followUpDecisions', 'reminderDecisions',
  ]);
  if (!raw) return null;
  const clientActionId = nonEmptyString(raw.clientActionId);
  const planHash = nonEmptyString(raw.planHash);
  const reasonCode = nonEmptyString(raw.reasonCode);
  const jobDecisions = parseSimpleDecisions(raw.jobDecisions, 'jobCardId');
  const calendarDecisions = parseSimpleDecisions(raw.calendarDecisions, 'calendarEventId');
  const followUpDecisions = parseSimpleDecisions(raw.followUpDecisions, 'jobCardId');
  const customerDecisions = parseCustomerDecisions(raw.customerDecisions);
  const reminderDecisions = parseReminderDecisions(raw.reminderDecisions);
  if (!clientActionId || clientActionId.length > 255 || !planHash || !/^[0-9a-f]{64}$/.test(planHash)
    || !reasonCode || !STAFF_OFFBOARDING_REASON_CODES.includes(reasonCode as StaffOffboardingReasonCode)
    || !jobDecisions || !calendarDecisions || !followUpDecisions || !customerDecisions || !reminderDecisions) return null;
  return {
    clientActionId, planHash, reasonCode: reasonCode as StaffOffboardingReasonCode,
    jobDecisions: jobDecisions.map((item) => ({ jobCardId: 'jobCardId' in item ? item.jobCardId : '', replacementUserId: item.replacementUserId })),
    customerDecisions,
    calendarDecisions: calendarDecisions.map((item) => ({ calendarEventId: 'calendarEventId' in item ? item.calendarEventId : '', replacementUserId: item.replacementUserId })),
    followUpDecisions: followUpDecisions.map((item) => ({ jobCardId: 'jobCardId' in item ? item.jobCardId : '', replacementUserId: item.replacementUserId })),
    reminderDecisions,
  };
}

export function readPersistedStaffOffboardingAttempt(): StaffOffboardingAttemptRecovery {
  if (typeof window === 'undefined') return { kind: 'none' };
  let serialized: string | null;
  try { serialized = window.sessionStorage.getItem(STAFF_OFFBOARDING_ATTEMPT_STORAGE_KEY); }
  catch { return { kind: 'invalid' }; }
  if (serialized === null) return { kind: 'none' };
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; }
  catch { return { kind: 'invalid' }; }
  const raw = exactRecord(value, ['schemaVersion', 'status', 'targetUserId', 'request', 'createdAt']);
  const status = raw?.status === 'ACTIVE' || raw?.status === 'RETIRED' ? raw.status : null;
  const targetUserId = raw ? nonEmptyString(raw.targetUserId) : null;
  const createdAt = raw ? nonEmptyString(raw.createdAt) : null;
  const request = raw ? parseRequest(raw.request) : null;
  if (!raw || raw.schemaVersion !== 2 || !status || !targetUserId || !createdAt
    || !Number.isFinite(Date.parse(createdAt)) || !request) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', status, targetUserId, attempt: { request }, createdAt };
}

function persistStaffOffboardingAttemptWithStatus(
  targetUserId: string,
  attempt: StaffOffboardingAttempt,
  status: StaffOffboardingAttemptStatus,
) {
  const stored: StoredStaffOffboardingAttempt = {
    schemaVersion: 2,
    status,
    targetUserId,
    request: attempt.request,
    createdAt: new Date().toISOString(),
  };
  window.sessionStorage.setItem(STAFF_OFFBOARDING_ATTEMPT_STORAGE_KEY, JSON.stringify(stored));
}

export function persistStaffOffboardingAttempt(targetUserId: string, attempt: StaffOffboardingAttempt) {
  persistStaffOffboardingAttemptWithStatus(targetUserId, attempt, 'ACTIVE');
}

export function retirePersistedStaffOffboardingAttempt(targetUserId: string, attempt: StaffOffboardingAttempt) {
  persistStaffOffboardingAttemptWithStatus(targetUserId, attempt, 'RETIRED');
}

export function clearPersistedStaffOffboardingAttempt() {
  window.sessionStorage.removeItem(STAFF_OFFBOARDING_ATTEMPT_STORAGE_KEY);
}
