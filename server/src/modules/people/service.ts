import { AppError } from '../../errors/index.js';
import type { CredentialAdministrationPort } from '../auth/admin-ports.js';
import type { SafeUser } from '../auth/types.js';
import type { PeopleRepository, PeopleTransaction } from './repository.js';
import type {
  AppendAuditInput,
  CreateUserInput,
  ManagedUserRecord,
  SafeManagedUser,
  StaffProfileInput,
  StaffProfileRecord,
  StaffStatusFilter,
  UpdateStaffProfileInput,
} from './types.js';

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const userNotFound = () => new AppError('USER_NOT_FOUND', 404, 'Kullanıcı bulunamadı.');
const profileNotFound = () => new AppError('STAFF_PROFILE_NOT_FOUND', 404, 'Personel profili bulunamadı.');
const userVersionConflict = () => new AppError('USER_VERSION_CONFLICT', 409, 'Kullanıcı başka bir işlem tarafından güncellendi.');
const profileVersionConflict = () => new AppError('STAFF_PROFILE_VERSION_CONFLICT', 409, 'Personel profili başka bir işlem tarafından güncellendi.');

type CredentialPreparation = Pick<CredentialAdministrationPort, 'validatePassword' | 'hashPassword'>;

function safe(user: ManagedUserRecord): SafeManagedUser {
  const { passwordHash: _passwordHash, ...result } = user;
  return result;
}

function requireAdmin(actor: SafeUser) {
  if (actor.role !== 'ADMIN') throw forbidden();
}

function requireAdminOrManager(actor: SafeUser) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw forbidden();
}

function cleanRequired(value: string, field: string) {
  const cleaned = value.trim();
  if (!cleaned) throw new AppError('VALIDATION_ERROR', 400, `${field} alanı zorunludur.`);
  return cleaned;
}

function audit(
  actor: SafeUser,
  subjectType: 'USER' | 'STAFF_PROFILE',
  subjectId: string,
  eventType: AppendAuditInput['eventType'],
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown> | null,
): AppendAuditInput {
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.id,
    subjectType,
    subjectId,
    eventType,
    oldValue,
    newValue,
    metadata: {},
  };
}

export class PeopleService {
  constructor(
    private readonly repository: PeopleRepository,
    private readonly credentials: CredentialPreparation,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listUsers(actor: SafeUser) {
    requireAdmin(actor);
    return this.repository.listUsers(actor.organizationId);
  }

  async getUser(actor: SafeUser, userId: string) {
    requireAdmin(actor);
    return (await this.repository.getUser(actor.organizationId, userId)) ?? Promise.reject(userNotFound());
  }

  async createUser(actor: SafeUser, input: CreateUserInput) {
    requireAdmin(actor);
    if (input.role === 'STAFF' && !input.staffProfile) {
      throw new AppError('STAFF_PROFILE_REQUIRED', 400, 'Personel profili zorunludur.');
    }
    if (input.role !== 'STAFF' && input.staffProfile) {
      throw new AppError('STAFF_PROFILE_NOT_ALLOWED', 400, 'Bu rol için personel profili oluşturulamaz.');
    }
    this.credentials.validatePassword(input.temporaryPassword);
    const passwordHash = await this.credentials.hashPassword(input.temporaryPassword);
    const normalizedEmail = cleanRequired(input.email, 'email').toLowerCase();
    const name = cleanRequired(input.name, 'name');

    try {
      return await this.repository.execute(async (tx) => {
        if (await tx.findUserByEmail(normalizedEmail)) {
          throw new AppError('EMAIL_ALREADY_EXISTS', 409, 'Bu e-posta adresi zaten kullanılıyor.');
        }
        if (input.staffProfile?.managerUserId) {
          await this.requireEligibleManager(tx, actor.organizationId, input.staffProfile.managerUserId);
        }
        const created = await tx.createUser({
          organizationId: actor.organizationId, name, email: normalizedEmail, passwordHash,
          role: input.role, mustChangePassword: true,
        });
        if (input.role === 'STAFF') {
          await tx.createStaffProfile({ organizationId: actor.organizationId, userId: created.id,
            ...this.cleanProfile(input.staffProfile!) });
        }
        await tx.appendAudit(audit(actor, 'USER', created.id, 'USER_CREATED', null,
          { name: created.name, email: created.email, role: created.role, isActive: created.isActive }));
        return safe(created);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('EMAIL_ALREADY_EXISTS', 409, 'Bu e-posta adresi zaten kullanılıyor.');
      }
      throw error;
    }
  }

  async updateUser(actor: SafeUser, userId: string, input: { expectedVersion: number; name: string }) {
    requireAdmin(actor);
    return this.repository.execute(async (tx) => {
      const target = await this.requireUser(tx, actor, userId);
      const updated = await tx.updateUserName(target.id, input.expectedVersion, cleanRequired(input.name, 'name'));
      if (!updated) throw userVersionConflict();
      return safe(updated);
    });
  }

  async changeRole(actor: SafeUser, userId: string, input: { expectedVersion: number; role: 'ADMIN' | 'MANAGER' }) {
    requireAdmin(actor);
    if (actor.id === userId) throw new AppError('SELF_ROLE_CHANGE_FORBIDDEN', 409, 'Kendi rolünüzü değiştiremezsiniz.');
    return this.repository.execute(async (tx) => {
      const target = await this.requireUser(tx, actor, userId);
      if (target.version !== input.expectedVersion) throw userVersionConflict();
      if (target.role === 'STAFF') throw new AppError('STAFF_ROLE_CHANGE_NOT_SUPPORTED', 409, 'Personel rolü dönüşümü bu sürümde desteklenmiyor.');
      if (target.role === input.role) return safe(target);
      if (target.role === 'ADMIN' && target.isActive && await tx.countActiveAdmins(actor.organizationId) <= 1) {
        throw new AppError('LAST_ACTIVE_ADMIN_REQUIRED', 409, 'En az bir aktif sistem yöneticisi bulunmalıdır.');
      }
      if (target.role === 'MANAGER' && await tx.hasAssignedActiveStaff(target.id)) {
        throw new AppError('MANAGER_HAS_ASSIGNED_STAFF', 409, 'Yöneticiye bağlı aktif personel bulunuyor.');
      }
      const updated = await tx.changeRole(target.id, input.expectedVersion, input.role);
      if (!updated) throw userVersionConflict();
      await tx.appendAudit(audit(actor, 'USER', target.id, 'USER_ROLE_CHANGED', { role: target.role }, { role: updated.role }));
      return safe(updated);
    });
  }

  activate(actor: SafeUser, userId: string, expectedVersion: number) {
    requireAdmin(actor);
    return this.setActive(actor, userId, expectedVersion, true);
  }

  deactivate(actor: SafeUser, userId: string, expectedVersion: number) {
    requireAdmin(actor);
    if (actor.id === userId) throw new AppError('SELF_DEACTIVATION_FORBIDDEN', 409, 'Kendi hesabınızı pasifleştiremezsiniz.');
    return this.setActive(actor, userId, expectedVersion, false);
  }

  private async setActive(actor: SafeUser, userId: string, expectedVersion: number, active: boolean) {
    return this.repository.execute(async (tx) => {
      const target = await this.requireUser(tx, actor, userId);
      if (target.version !== expectedVersion) throw userVersionConflict();
      if (target.isActive === active) return safe(target);
      if (!active) {
        if (target.role === 'ADMIN' && await tx.countActiveAdmins(actor.organizationId) <= 1) {
          throw new AppError('LAST_ACTIVE_ADMIN_REQUIRED', 409, 'En az bir aktif sistem yöneticisi bulunmalıdır.');
        }
        if (target.role === 'STAFF' && await tx.hasActiveJobCards(target.id)) {
          throw new AppError('USER_HAS_ACTIVE_JOB_CARDS', 409, 'Personelin açık işleri bulunuyor.');
        }
        if (target.role === 'MANAGER' && await tx.hasAssignedActiveStaff(target.id)) {
          throw new AppError('MANAGER_HAS_ASSIGNED_STAFF', 409, 'Yöneticiye bağlı aktif personel bulunuyor.');
        }
      }
      const updated = await tx.setActive(target.id, expectedVersion, active);
      if (!updated) throw userVersionConflict();
      if (!active) await tx.revokeAllSessions(target.id, this.now());
      await tx.appendAudit(audit(actor, 'USER', target.id, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
        { isActive: target.isActive }, { isActive: updated.isActive }));
      return safe(updated);
    });
  }

  async resetPassword(actor: SafeUser, userId: string, input: { expectedVersion: number; temporaryPassword: string }) {
    requireAdmin(actor);
    this.credentials.validatePassword(input.temporaryPassword);
    return this.repository.execute(async (tx) => {
      const target = await this.requireUser(tx, actor, userId);
      if (target.version !== input.expectedVersion) throw userVersionConflict();
      const updated = await tx.resetTemporaryPassword(target.id, input.expectedVersion, input.temporaryPassword, this.now());
      if (!updated) throw userVersionConflict();
      await tx.appendAudit(audit(actor, 'USER', target.id, 'USER_PASSWORD_RESET', null,
        { mustChangePassword: true }));
      return safe(updated);
    });
  }

  async listStaff(actor: SafeUser, status: StaffStatusFilter) {
    requireAdminOrManager(actor);
    if (actor.role === 'MANAGER' && status !== 'active') throw forbidden();
    return this.repository.listStaff(actor.organizationId, status, this.now());
  }

  async getOwnStaffProfile(actor: SafeUser) {
    if (actor.role !== 'STAFF') throw forbidden();
    return (await this.repository.getStaffSummary(actor.organizationId, actor.id, this.now())) ?? Promise.reject(profileNotFound());
  }

  async getStaffProfile(actor: SafeUser, userId: string) {
    requireAdminOrManager(actor);
    return (await this.repository.getStaffSummary(actor.organizationId, userId, this.now())) ?? Promise.reject(profileNotFound());
  }

  async updateStaffProfile(actor: SafeUser, userId: string, input: UpdateStaffProfileInput) {
    requireAdminOrManager(actor);
    await this.repository.execute(async (tx) => {
      const targetUser = await this.requireUser(tx, actor, userId);
      if (targetUser.role !== 'STAFF') throw profileNotFound();
      const current = await tx.lockStaffProfile(actor.organizationId, userId);
      if (!current) throw profileNotFound();
      if (current.version !== input.expectedVersion) throw profileVersionConflict();
      const cleaned = this.cleanProfile(input);
      if (cleaned.managerUserId) await this.requireEligibleManager(tx, actor.organizationId, cleaned.managerUserId);
      const updated = await tx.updateStaffProfile({ organizationId: actor.organizationId, userId,
        expectedVersion: input.expectedVersion, ...cleaned });
      if (!updated) throw profileVersionConflict();
      const fieldsChanged = current.title !== updated.title || current.phone !== updated.phone || current.region !== updated.region;
      if (fieldsChanged) await tx.appendAudit(audit(actor, 'STAFF_PROFILE', current.id, 'STAFF_PROFILE_UPDATED',
        { title: current.title, phone: current.phone, region: current.region },
        { title: updated.title, phone: updated.phone, region: updated.region }));
      if (current.managerUserId !== updated.managerUserId) await tx.appendAudit(audit(actor, 'STAFF_PROFILE', current.id, 'STAFF_MANAGER_CHANGED',
        { managerUserId: current.managerUserId }, { managerUserId: updated.managerUserId }));
    });
    return (await this.repository.getStaffSummary(actor.organizationId, userId, this.now()))!;
  }

  private async requireUser(tx: PeopleTransaction, actor: SafeUser, userId: string) {
    return (await tx.lockUser(actor.organizationId, userId)) ?? Promise.reject(userNotFound());
  }

  private async requireEligibleManager(tx: PeopleTransaction, organizationId: string, managerUserId: string) {
    const manager = await tx.lockUser(organizationId, managerUserId);
    if (!manager || manager.role !== 'MANAGER' || !manager.isActive) {
      throw new AppError('MANAGER_NOT_ELIGIBLE', 400, 'Seçilen yönetici uygun değil.');
    }
  }

  private cleanProfile(input: StaffProfileInput) {
    const clean = (value: string | null) => value?.trim() || null;
    return { title: clean(input.title), phone: clean(input.phone), region: clean(input.region), managerUserId: input.managerUserId };
  }
}
