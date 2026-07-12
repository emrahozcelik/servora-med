import {
  ApiError, boolean, json, nullableString, number, object, request, string,
  type UserRole,
} from './api';

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

export const listUsers = async () => array(await request('/api/users')).map(parseUser);
export const getUser = async (id: string) => parseUser(await request(`/api/users/${id}`));
export const createUser = async (input: CreateUserInput) => parseUser(await request('/api/users', json('POST', input)));
export const updateUser = async (id: string, input: { expectedVersion: number; name: string }) => parseUser(await request(`/api/users/${id}`, json('PATCH', input)));
export const changeUserRole = async (id: string, input: { expectedVersion: number; role: 'ADMIN' | 'MANAGER' }) => parseUser(await request(`/api/users/${id}/change-role`, json('POST', input)));
export const activateUser = async (id: string, expectedVersion: number) => parseUser(await request(`/api/users/${id}/activate`, json('POST', { expectedVersion })));
export const deactivateUser = async (id: string, expectedVersion: number) => parseUser(await request(`/api/users/${id}/deactivate`, json('POST', { expectedVersion })));
export const resetUserPassword = async (id: string, input: { expectedVersion: number; temporaryPassword: string }) => parseUser(await request(`/api/users/${id}/reset-password`, json('POST', input)));
export const listStaff = async (status: 'active' | 'inactive' | 'all' = 'active') => array(await request(`/api/staff?status=${status}`)).map(parseProfile);
export const getOwnStaffProfile = async () => parseProfile(await request('/api/staff/me'));
export const getStaffProfile = async (id: string) => parseProfile(await request(`/api/staff/${id}`));
export const updateStaffProfile = async (id: string, input: StaffProfileFields & { expectedVersion: number }) => parseProfile(await request(`/api/staff/${id}`, json('PATCH', input)));
