import type { UserRole } from '../auth/types.js';

export type StaffStatusFilter = 'active' | 'inactive' | 'all';

export type StaffCounters = {
  open: number;
  waitingApproval: number;
  revisionRequested: number;
  completedThisMonth: number;
  overdue: number;
};

export type AuditEventType =
  | 'USER_CREATED'
  | 'USER_ROLE_CHANGED'
  | 'USER_ACTIVATED'
  | 'USER_DEACTIVATED'
  | 'USER_PASSWORD_RESET'
  | 'STAFF_PROFILE_UPDATED'
  | 'STAFF_MANAGER_CHANGED';

export type AuditSubjectType = 'USER' | 'STAFF_PROFILE';

export type ManagedUserRecord = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword: boolean;
  isActive: boolean;
  version: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SafeManagedUser = Omit<ManagedUserRecord, 'passwordHash'>;

export type StaffProfileRecord = {
  id: string;
  organizationId: string;
  userId: string;
  title: string | null;
  phone: string | null;
  region: string | null;
  managerUserId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StaffProfileSummary = {
  id: string;
  user: SafeManagedUser;
  title: string | null;
  phone: string | null;
  region: string | null;
  managerUserId: string | null;
  managerName: string | null;
  version: number;
  counters: StaffCounters;
};

export type CreateUserRecord = {
  organizationId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword: boolean;
};

export type CreateStaffProfileRecord = {
  organizationId: string;
  userId: string;
  title: string | null;
  phone: string | null;
  region: string | null;
  managerUserId: string | null;
};

export type UpdateStaffProfileRecord = CreateStaffProfileRecord & {
  expectedVersion: number;
};

export type AppendAuditInput = {
  organizationId: string;
  actorUserId: string;
  subjectType: AuditSubjectType;
  subjectId: string;
  eventType: AuditEventType;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};
