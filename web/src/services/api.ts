import {
  addDeliveryItem, approveJobCard, createJobCard, createProductDelivery, getJobCard,
  listDeliveryItems,
  patchDeliveryItem, patchJobCard, removeDeliveryItem, requestJobCardRevision,
  startJobCard, submitJobCardForApproval,
  type DeliveryItem, type DeliveryPurpose, type JobCard,
  type JobCardStatus,
} from '../jobs/jobs-api';

export {
  addDeliveryItem, approveJobCard, createJobCard, createProductDelivery, getJobCard, listDeliveryItems,
  patchDeliveryItem, patchJobCard, removeDeliveryItem, requestJobCardRevision,
  startJobCard, submitJobCardForApproval,
  JOB_CARD_STATUSES,
} from '../jobs/jobs-api';
export type { DeliveryItem, DeliveryPurpose, JobCard, JobCardStatus, ProductDeliveryCreateInput } from '../jobs/jobs-api';

export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF';
export type AuthenticatedCapabilities = {
  overviewDashboard: boolean;
  calendar: boolean;
  messaging: boolean;
};
export type AuthenticatedSupport = {
  displayLabel: string;
  email: string | null;
  helpUrl: string | null;
};
export type CurrentUser = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
  isActive: boolean;
  version: number;
  capabilities: AuthenticatedCapabilities;
  support: AuthenticatedSupport;
};
export type ReferenceCustomer = {
  id: string;
  name: string;
  customerType: string;
  status: string;
  assignedStaffUserId?: string | null;
};

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly retryable = false, public readonly details: Record<string, unknown> | null = null) {
    super(message); this.name = 'ApiError';
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz yanıt alındı.');
  return value as Record<string, unknown>;
}
export function string(value: unknown, field: string) {
  if (typeof value !== 'string' || !value) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}
export function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}
export function number(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}
export function boolean(value: unknown, field: string) {
  if (typeof value !== 'boolean') throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}
export function items(value: unknown) {
  const list = object(value).items;
  if (!Array.isArray(list)) throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz liste yanıtı alındı.');
  return list;
}

export async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'include' }); }
  catch { throw new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.', true); }
  if (!response.ok) {
    let error = 'İşlem tamamlanamadı. Lütfen tekrar deneyin.'; let code = 'REQUEST_FAILED';
    let details: Record<string, unknown> | null = null;
    try {
      const body = object(await response.json());
      if (typeof body.error === 'string') error = body.error;
      if (typeof body.code === 'string') code = body.code;
      if (body.details && typeof body.details === 'object' && !Array.isArray(body.details)) {
        details = body.details as Record<string, unknown>;
      }
    } catch { /* use safe fallback */ }
    throw new ApiError(response.status, code, error, response.status >= 500, details);
  }
  if (response.status === 204) return null;
  try { return await response.json() as unknown; }
  catch { throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz yanıt alındı.'); }
}
export const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function parseCurrentUser(value: unknown): CurrentUser {
  const user = object(value);
  const role = string(user.role, 'role');
  if (!['ADMIN', 'MANAGER', 'STAFF'].includes(role)) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Yanıtta role alanı geçersiz.');
  }
  const rawCapabilities = user.capabilities && typeof user.capabilities === 'object'
    ? object(user.capabilities)
    : {};
  const rawSupport = user.support && typeof user.support === 'object'
    ? object(user.support)
    : {};
  let helpUrl: string | null = null;
  if (typeof rawSupport.helpUrl === 'string') {
    try {
      const parsed = new URL(rawSupport.helpUrl);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
        helpUrl = parsed.toString();
      }
    } catch {
      // Unsafe or malformed optional support URLs fail closed.
    }
  }
  return {
    id: string(user.id, 'id'),
    organizationId: string(user.organizationId, 'organizationId'),
    name: string(user.name, 'name'),
    email: string(user.email, 'email'),
    role: role as UserRole,
    mustChangePassword: boolean(user.mustChangePassword, 'mustChangePassword'),
    isActive: typeof user.isActive === 'boolean' ? user.isActive : true,
    version: typeof user.version === 'number' ? number(user.version, 'version') : 1,
    capabilities: {
      overviewDashboard: rawCapabilities.overviewDashboard === true,
      calendar: rawCapabilities.calendar === true,
      messaging: rawCapabilities.messaging === true,
    },
    support: {
      displayLabel: typeof rawSupport.displayLabel === 'string' && rawSupport.displayLabel.trim()
        ? rawSupport.displayLabel
        : 'Sistem yöneticiniz',
      email: typeof rawSupport.email === 'string'
        && /^[A-Za-z0-9.!#$%&'*+/=_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(rawSupport.email)
        ? rawSupport.email
        : null,
      helpUrl,
    },
  };
}

export async function login(credentials: { email: string; password: string }) {
  const body = object(await request('/api/auth/login', json('POST', credentials)));
  return parseCurrentUser(body.user);
}
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try { return parseCurrentUser(object(await request('/api/auth/me')).user); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
export async function logout() { await request('/api/auth/logout', { method: 'POST' }); }
export async function changePassword(input: { currentPassword: string; newPassword: string }) { await request('/api/auth/change-password', json('POST', input)); }

export async function listReferenceCustomers() {
  return items(await request('/api/reference/customers')).map((entry) => {
    const v = object(entry);
    return {
      id: string(v.id, 'id'),
      name: string(v.name, 'name'),
      customerType: string(v.customerType, 'customerType'),
      status: string(v.status, 'status'),
      assignedStaffUserId: v.assignedStaffUserId === undefined
        ? null
        : nullableString(v.assignedStaffUserId, 'assignedStaffUserId'),
    };
  });
}
