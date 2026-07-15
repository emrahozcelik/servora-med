import { describe, expect, it } from 'vitest';

import { PeopleService } from '../src/modules/people/service.js';
import type { PeopleRepository, PeopleTransaction } from '../src/modules/people/repository.js';
import type {
  AppendAuditInput,
  ManagedUserRecord,
  StaffProfileRecord,
  StaffProfileDetails,
  StaffProfileSummary,
} from '../src/modules/people/types.js';

const now = new Date('2026-07-12T08:00:00.000Z');
const user = (overrides: Partial<ManagedUserRecord> = {}): ManagedUserRecord => ({
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'staff@example.com',
  passwordHash: 'hash', role: 'STAFF', mustChangePassword: true, isActive: true,
  version: 1, lastLoginAt: null, createdAt: now, updatedAt: now, ...overrides,
});
const profile = (overrides: Partial<StaffProfileRecord> = {}): StaffProfileRecord => ({
  id: 'profile-1', organizationId: 'org-1', userId: 'staff-1', title: null,
  phone: null, region: null, managerUserId: null, version: 1,
  createdAt: now, updatedAt: now, ...overrides,
});
const summary = (record = user(), staff = profile()): StaffProfileSummary => {
  const { passwordHash: _passwordHash, ...safe } = record;
  return { id: staff.id, user: safe, title: staff.title, phone: staff.phone, region: staff.region,
    managerUserId: staff.managerUserId, managerName: null, version: staff.version,
    counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } };
};

const details = (record = user(), staff = profile()): StaffProfileDetails => {
  const { counters: _counters, ...result } = summary(record, staff);
  return result;
};

class MemoryPeopleRepository implements PeopleRepository {
  users = [
    user({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN', mustChangePassword: false }),
    user({ id: 'manager-1', name: 'Manager', email: 'manager@example.com', role: 'MANAGER', mustChangePassword: false }),
    user(),
  ];
  profiles = [profile()];
  audits: AppendAuditInput[] = [];
  activeJobCards = false;
  assignedStaff = false;
  activeAdminCount = 1;
  revoked: string[] = [];
  customerAssignments = [{ customerId: 'customer-active', staffUserId: 'staff-1' }, { customerId: 'customer-inactive', staffUserId: 'staff-1' }];
  cleanupCalls: string[] = [];
  failAudit = false;

  async execute<T>(work: (tx: PeopleTransaction) => Promise<T>) {
    const usersBefore = structuredClone(this.users); const profilesBefore = structuredClone(this.profiles);
    const assignmentsBefore = structuredClone(this.customerAssignments);
    const auditCount = this.audits.length; const revokedCount = this.revoked.length;
    const tx = this.transaction();
    try { return await work(tx); } catch (error) {
      this.users = usersBefore; this.profiles = profilesBefore;
      this.customerAssignments = assignmentsBefore;
      this.audits.splice(auditCount); this.revoked.splice(revokedCount); throw error;
    }
  }
  async listUsers(org: string) { return this.users.filter((item) => item.organizationId === org).map(({ passwordHash: _, ...safe }) => safe); }
  async getUser(org: string, id: string) { const found = this.users.find((item) => item.organizationId === org && item.id === id); if (!found) return null; const { passwordHash: _, ...safe } = found; return safe; }
  async getStaffProfile(org: string, id: string) {
    const foundUser = this.users.find((item) => item.organizationId === org && item.id === id);
    const foundProfile = this.profiles.find((item) => item.organizationId === org && item.userId === id);
    return foundUser && foundProfile ? details(foundUser, foundProfile) : null;
  }
  async listStaffProfiles(org: string, status: 'active' | 'inactive' | 'all') {
    return this.profiles.flatMap((item) => {
      const found = this.users.find((entry) => entry.id === item.userId && entry.organizationId === org);
      return found && (status === 'all' || found.isActive === (status === 'active')) ? [details(found, item)] : [];
    });
  }

  private transaction(): PeopleTransaction {
    return {
      lockUser: async (org, id) => this.users.find((item) => item.organizationId === org && item.id === id) ?? null,
      findUserByEmail: async (email) => this.users.find((item) => item.email === email) ?? null,
      lockStaffProfile: async (org, id) => this.profiles.find((item) => item.organizationId === org && item.userId === id) ?? null,
      createUser: async (input) => { const created = user({ ...input, id: `user-${this.users.length + 1}`, version: 1 }); this.users.push(created); return created; },
      createStaffProfile: async (input) => { const created = profile({ ...input, id: `profile-${this.profiles.length + 1}` }); this.profiles.push(created); return created; },
      updateUserName: async (id, version, name) => this.updateUser(id, version, { name }),
      changeRole: async (id, version, role) => this.updateUser(id, version, { role }),
      setActive: async (id, version, isActive) => this.updateUser(id, version, { isActive }),
      updateStaffProfile: async (input) => {
        const index = this.profiles.findIndex((item) => item.organizationId === input.organizationId && item.userId === input.userId && item.version === input.expectedVersion);
        if (index < 0) return null;
        const updated = { ...this.profiles[index]!, ...input, version: input.expectedVersion + 1, updatedAt: now };
        this.profiles[index] = updated; return updated;
      },
      countActiveAdmins: async () => this.activeAdminCount,
      hasActiveJobCards: async () => this.activeJobCards,
      hasAssignedActiveStaff: async () => this.assignedStaff,
      resetTemporaryPassword: async (id, version) => this.updateUser(id, version, { mustChangePassword: true }),
      revokeAllSessions: async (id) => { this.revoked.push(id); },
      clearCustomerAssignments: async (input) => {
        this.cleanupCalls.push(input.staffUserId);
        this.customerAssignments = this.customerAssignments.filter((item) => item.staffUserId !== input.staffUserId);
        return [{ customerId: 'customer-active', nextVersion: 2 }, { customerId: 'customer-inactive', nextVersion: 2 }];
      },
      appendAudit: async (input) => { if (this.failAudit) throw new Error('audit failed'); this.audits.push(input); },
    };
  }

  private updateUser(id: string, version: number, fields: Partial<ManagedUserRecord>) {
    const index = this.users.findIndex((item) => item.id === id && item.version === version);
    if (index < 0) return null;
    this.users[index] = { ...this.users[index]!, ...fields, version: version + 1, updatedAt: now };
    return this.users[index]!;
  }
}

const admin = { id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' as const, mustChangePassword: false };
const manager = { ...admin, id: 'manager-1', role: 'MANAGER' as const };
const staff = { ...admin, id: 'staff-1', role: 'STAFF' as const };
const credentials = { validatePassword: () => undefined, hashPassword: async () => 'temporary-hash' };
const staffSummaries = {
  getOne: async ({ staffUserId }: { staffUserId: string }) => ({
    staffUserId,
    range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
    counters: { openJobCards: 0, waitingApproval: 0, revisionRequested: 0, overdueJobCards: 0, completedInPeriod: 0 },
  }),
  getMany: async ({ staffUserIds }: { staffUserIds: readonly string[] }) => new Map(staffUserIds.map((staffUserId) => [staffUserId, {
    staffUserId,
    range: { from: '2026-07-01', to: '2026-07-31', timezone: 'Europe/Istanbul' },
    counters: { openJobCards: 0, waitingApproval: 0, revisionRequested: 0, overdueJobCards: 0, completedInPeriod: 0 },
  }])),
};
const service = (repository = new MemoryPeopleRepository()) => ({
  repository,
  service: new PeopleService(repository, credentials, staffSummaries, () => now),
});

describe('PeopleService policy', () => {
  it('allows only Admin to list and create users', async () => {
    const { service: people } = service();
    await expect(people.listUsers(manager)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(people.createUser(staff, { name: 'Yeni', email: 'new@example.com', role: 'MANAGER', temporaryPassword: 'temporary-password' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a Staff profile and forbids one for other roles', async () => {
    const { service: people } = service();
    await expect(people.createUser(admin, { name: 'Yeni', email: 'new@example.com', role: 'STAFF', temporaryPassword: 'temporary-password' }))
      .rejects.toMatchObject({ code: 'STAFF_PROFILE_REQUIRED' });
    await expect(people.createUser(admin, { name: 'Yeni', email: 'new@example.com', role: 'MANAGER', temporaryPassword: 'temporary-password',
      staffProfile: { title: null, phone: null, region: null, managerUserId: null } }))
      .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_ALLOWED' });
  });

  it('creates Staff and profile atomically with one safe audit event', async () => {
    const { repository, service: people } = service();
    const created = await people.createUser(admin, { name: ' Yeni Personel ', email: 'NEW@EXAMPLE.COM', role: 'STAFF', temporaryPassword: 'temporary-password',
      staffProfile: { title: 'Uzman', phone: null, region: 'Marmara', managerUserId: 'manager-1' } });
    expect(created).toMatchObject({ name: 'Yeni Personel', email: 'new@example.com', role: 'STAFF', version: 1 });
    expect(repository.profiles).toHaveLength(2);
    expect(repository.audits).toEqual([expect.objectContaining({ eventType: 'USER_CREATED', actorUserId: 'admin-1' })]);
    expect(JSON.stringify(repository.audits)).not.toContain('temporary-password');
  });

  it('rejects duplicate email and ineligible Manager assignment', async () => {
    const { repository, service: people } = service();
    await expect(people.createUser(admin, { name: 'Tekrar', email: 'STAFF@example.com', role: 'STAFF', temporaryPassword: 'temporary-password',
      staffProfile: { title: null, phone: null, region: null, managerUserId: null } }))
      .rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
    repository.users.find((item) => item.id === 'manager-1')!.isActive = false;
    await expect(people.createUser(admin, { name: 'Yeni', email: 'new@example.com', role: 'STAFF', temporaryPassword: 'temporary-password',
      staffProfile: { title: null, phone: null, region: null, managerUserId: 'manager-1' } }))
      .rejects.toMatchObject({ code: 'MANAGER_NOT_ELIGIBLE' });
  });

  it('allows only Admin and Manager role changes and protects self and last Admin', async () => {
    const { repository, service: people } = service();
    await expect(people.changeRole(admin, 'staff-1', { expectedVersion: 1, role: 'MANAGER' }))
      .rejects.toMatchObject({ code: 'STAFF_ROLE_CHANGE_NOT_SUPPORTED' });
    await expect(people.changeRole(admin, 'admin-1', { expectedVersion: 1, role: 'MANAGER' }))
      .rejects.toMatchObject({ code: 'SELF_ROLE_CHANGE_FORBIDDEN' });
    repository.users.push(user({ id: 'admin-2', email: 'admin2@example.com', role: 'ADMIN' }));
    repository.activeAdminCount = 2;
    await expect(people.changeRole(admin, 'admin-2', { expectedVersion: 1, role: 'MANAGER' })).resolves.toMatchObject({ role: 'MANAGER', version: 2 });
  });

  it('blocks unsafe deactivation and revokes sessions for an eligible user', async () => {
    const { repository, service: people } = service();
    repository.activeJobCards = true;
    await expect(people.deactivate(admin, 'staff-1', 1)).rejects.toMatchObject({ code: 'USER_HAS_ACTIVE_JOB_CARDS' });
    repository.activeJobCards = false;
    await expect(people.deactivate(admin, 'staff-1', 1)).resolves.toMatchObject({ isActive: false, version: 2 });
    expect(repository.revoked).toEqual(['staff-1']);
    expect(repository.cleanupCalls).toEqual(['staff-1']);
    expect(repository.customerAssignments).toEqual([]);
    expect(repository.audits.at(-1)).toMatchObject({ eventType: 'USER_DEACTIVATED' });
  });

  it('rolls back Staff state, sessions, and Customer cleanup when audit fails', async () => {
    const { repository, service: people } = service(); repository.failAudit = true;
    await expect(people.deactivate(admin, 'staff-1', 1)).rejects.toThrow('audit failed');
    expect(repository.users.find((item) => item.id === 'staff-1')).toMatchObject({ isActive: true, version: 1 });
    expect(repository.revoked).toEqual([]);
    expect(repository.customerAssignments).toHaveLength(2);
  });

  it('blocks a Manager with assigned active Staff from role change or deactivation', async () => {
    const { repository, service: people } = service(); repository.assignedStaff = true;
    await expect(people.changeRole(admin, 'manager-1', { expectedVersion: 1, role: 'ADMIN' }))
      .rejects.toMatchObject({ code: 'MANAGER_HAS_ASSIGNED_STAFF' });
    await expect(people.deactivate(admin, 'manager-1', 1))
      .rejects.toMatchObject({ code: 'MANAGER_HAS_ASSIGNED_STAFF' });
  });

  it('returns version conflicts without audit side effects', async () => {
    const { repository, service: people } = service();
    await expect(people.updateUser(admin, 'manager-1', { expectedVersion: 99, name: 'Stale' }))
      .rejects.toMatchObject({ code: 'USER_VERSION_CONFLICT' });
    expect(repository.audits).toHaveLength(0);
  });

  it('limits Staff to own profile and Manager to active profile lists', async () => {
    const { service: people } = service();
    await expect(people.getOwnStaffProfile(staff)).resolves.toMatchObject({ user: { id: 'staff-1' } });
    await expect(people.getStaffProfile(staff, 'staff-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(people.listStaff(manager, 'inactive')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(people.listStaff(manager, 'active')).resolves.toHaveLength(1);
  });

  it('writes distinct profile and Manager audit events in one update', async () => {
    const { repository, service: people } = service();
    repository.users.push(user({ id: 'manager-2', email: 'manager2@example.com', role: 'MANAGER' }));
    await people.updateStaffProfile(manager, 'staff-1', { expectedVersion: 1, title: 'Kıdemli Uzman', phone: null, region: null, managerUserId: 'manager-2' });
    expect(repository.audits.map((item) => item.eventType)).toEqual(['STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED']);
  });
});
