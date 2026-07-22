import { AppError } from '../../errors/index.js';
import type { CrmRepository, CrmTransaction } from './repository.js';
import type {
  AppendCrmAuditInput,
  Contact,
  ContactFilters,
  CrmActor,
  Customer,
  CustomerFilters,
  CustomerStatus,
  CustomerType,
} from './types.js';
import { normalizeTaxNumber } from './types.js';

export type CreateCustomerInput = {
  name: string; customerType: CustomerType; status?: CustomerStatus;
  taxNumber: string | null; phone: string | null; email: string | null;
  city: string | null; district: string | null; address: string | null;
  assignedStaffUserId: string | null;
};
export type UpdateCustomerInput = Omit<CreateCustomerInput, 'status'> & { expectedVersion: number };
export type CreateContactInput = {
  name: string; title: string | null; phone: string | null; email: string | null;
};
export type UpdateContactInput = CreateContactInput & { expectedVersion: number };
export type PrimaryContactResult = { contact: Contact; previousPrimaryContactId: string | null };

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const customerNotFound = () => new AppError('CUSTOMER_NOT_FOUND', 404, 'Müşteri bulunamadı.');
const contactNotFound = () => new AppError('CONTACT_NOT_FOUND', 404, 'İlgili kişi bulunamadı.');
const versionConflict = (currentVersion?: number) => new AppError(
  'VERSION_CONFLICT', 409, 'Kayıt başka bir kullanıcı tarafından güncellendi.',
  currentVersion === undefined ? null : { currentVersion },
);

function requireWriter(actor: CrmActor) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw forbidden();
}

function requireCustomerCreator(actor: CrmActor) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER' && actor.role !== 'STAFF') throw forbidden();
}

function required(value: string, label: string) {
  const cleaned = value.trim();
  if (!cleaned) throw new AppError('VALIDATION_ERROR', 400, `${label} alanı zorunludur.`);
  return cleaned;
}

function optional(value: string | null) {
  return value?.trim() || null;
}

function audit(
  actor: CrmActor,
  subjectType: AppendCrmAuditInput['subjectType'],
  subjectId: string,
  eventType: AppendCrmAuditInput['eventType'],
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown> | null,
  metadata: Record<string, unknown> = {},
): AppendCrmAuditInput {
  return { organizationId: actor.organizationId, actorUserId: actor.id, subjectType,
    subjectId, eventType, oldValue, newValue, metadata };
}

function isTaxConflict(error: unknown) {
  const value = error as { code?: string; constraint?: string };
  return value.code === '23505' && value.constraint === 'customers_organization_tax_number_unique';
}

export class CrmService {
  constructor(private readonly repository: CrmRepository) {}

  listCustomers(actor: CrmActor, filters: CustomerFilters) {
    return this.repository.listCustomers(actor.organizationId, filters);
  }

  async getCustomer(actor: CrmActor, customerId: string) {
    return (await this.repository.getCustomerDetail(actor, customerId)) ?? Promise.reject(customerNotFound());
  }

  async createCustomer(actor: CrmActor, input: CreateCustomerInput) {
    requireCustomerCreator(actor);
    const staffCreated = actor.role === 'STAFF';
    const status = staffCreated ? 'prospect' : input.status ?? 'prospect';
    if (status !== 'prospect' && status !== 'active') {
      throw new AppError('VALIDATION_ERROR', 400, 'Başlangıç müşteri durumu prospect veya active olmalıdır.');
    }
    try {
      return await this.repository.execute(async (tx) => {
        const assignedStaffUserId = staffCreated ? actor.id : input.assignedStaffUserId;
        if (assignedStaffUserId) await this.requireEligibleStaff(tx, actor, assignedStaffUserId);
        const created = await tx.createCustomer({
          organizationId: actor.organizationId, name: required(input.name, 'name'),
          customerType: input.customerType, taxNumber: normalizeTaxNumber(input.taxNumber),
          phone: optional(input.phone), email: optional(input.email)?.toLowerCase() ?? null,
          city: optional(input.city), district: optional(input.district), address: optional(input.address),
          assignedStaffUserId, status,
        });
        await tx.appendAudit(audit(actor, 'CUSTOMER', created.id, 'CUSTOMER_CREATED', null,
          { customerType: created.customerType, status: created.status,
            assignedStaffUserId: created.assignedStaffUserId }));
        return created;
      });
    } catch (error) {
      if (isTaxConflict(error)) {
        throw new AppError('CUSTOMER_TAX_NUMBER_EXISTS', 409, 'Bu vergi numarası başka bir müşteride kullanılıyor.');
      }
      throw error;
    }
  }

  async updateCustomer(actor: CrmActor, customerId: string, input: UpdateCustomerInput) {
    requireWriter(actor);
    try {
      return await this.repository.execute(async (tx) => {
        if (input.assignedStaffUserId) await this.requireEligibleStaff(tx, actor, input.assignedStaffUserId);
        const current = await this.requireCustomer(tx, actor, customerId);
        if (current.version !== input.expectedVersion) throw versionConflict(current.version);
        const updated = await tx.updateCustomer({
          organizationId: actor.organizationId, customerId, expectedVersion: input.expectedVersion,
          name: required(input.name, 'name'), customerType: input.customerType,
          taxNumber: normalizeTaxNumber(input.taxNumber), phone: optional(input.phone),
          email: optional(input.email)?.toLowerCase() ?? null, city: optional(input.city),
          district: optional(input.district), address: optional(input.address),
          assignedStaffUserId: input.assignedStaffUserId,
        });
        if (!updated) throw versionConflict();
        const changedFields = (['name', 'customerType', 'taxNumber', 'phone', 'email', 'city',
          'district', 'address'] as const).filter((field) => current[field] !== updated[field]);
        if (changedFields.length) await tx.appendAudit(audit(actor, 'CUSTOMER', current.id,
          'CUSTOMER_FIELDS_UPDATED', null, null, { changedFields }));
        if (current.assignedStaffUserId !== updated.assignedStaffUserId) {
          await tx.appendAudit(audit(actor, 'CUSTOMER', current.id, 'CUSTOMER_ASSIGNEE_CHANGED',
            { assignedStaffUserId: current.assignedStaffUserId },
            { assignedStaffUserId: updated.assignedStaffUserId }));
        }
        return updated;
      });
    } catch (error) {
      if (isTaxConflict(error)) throw new AppError('CUSTOMER_TAX_NUMBER_EXISTS', 409, 'Bu vergi numarası başka bir müşteride kullanılıyor.');
      throw error;
    }
  }

  activateCustomer(actor: CrmActor, customerId: string, expectedVersion: number) {
    requireWriter(actor);
    return this.changeCustomerStatus(actor, customerId, expectedVersion, 'active');
  }

  deactivateCustomer(actor: CrmActor, customerId: string, expectedVersion: number) {
    requireWriter(actor);
    return this.changeCustomerStatus(actor, customerId, expectedVersion, 'inactive');
  }

  async deleteCustomer(actor: CrmActor, customerId: string, expectedVersion: number) {
    requireWriter(actor);
    try {
      await this.repository.execute(async (tx) => {
        const current = await this.requireCustomer(tx, actor, customerId);
        if (current.version !== expectedVersion) throw versionConflict(current.version);
        if (await tx.customerHasAnyJobs(actor.organizationId, customerId)) {
          throw new AppError(
            'CUSTOMER_HAS_OPERATION_HISTORY',
            409,
            'Bu müşteri geçmiş iş veya teslimat kayıtlarında kullanıldığı için silinemez.',
          );
        }
        await tx.deleteContactsForCustomer(actor.organizationId, customerId);
        const deleted = await tx.deleteCustomer(actor.organizationId, customerId);
        if (!deleted) throw customerNotFound();
        await tx.appendAudit(audit(
          actor,
          'CUSTOMER',
          customerId,
          'CUSTOMER_DELETED',
          { name: current.name, status: current.status, customerType: current.customerType },
          null,
        ));
      });
    } catch (error) {
      const value = error as { code?: string };
      if (value.code === '23503') {
        throw new AppError(
          'CUSTOMER_HAS_OPERATION_HISTORY',
          409,
          'Bu müşteri geçmiş iş veya teslimat kayıtlarında kullanıldığı için silinemez.',
        );
      }
      throw error;
    }
  }

  private async changeCustomerStatus(actor: CrmActor, customerId: string, expectedVersion: number, next: 'active' | 'inactive') {
    return this.repository.execute(async (tx) => {
      const current = await this.requireCustomer(tx, actor, customerId);
      if (current.version !== expectedVersion) throw versionConflict(current.version);
      const valid = next === 'active' ? current.status === 'inactive' : current.status === 'active' || current.status === 'prospect';
      if (!valid) throw new AppError('INVALID_CUSTOMER_STATUS_TRANSITION', 409, 'Müşteri durumu bu işlem için uygun değil.');
      if (next === 'inactive' && await tx.customerHasActiveJobs(actor.organizationId, customerId)) {
        throw new AppError('CUSTOMER_HAS_ACTIVE_JOB_CARDS', 409, 'Müşterinin açık işleri bulunuyor.');
      }
      const updated = await tx.setCustomerStatus({ organizationId: actor.organizationId,
        customerId, expectedVersion, status: next });
      if (!updated) throw versionConflict();
      await tx.appendAudit(audit(actor, 'CUSTOMER', customerId,
        next === 'active' ? 'CUSTOMER_ACTIVATED' : 'CUSTOMER_DEACTIVATED',
        { status: current.status }, { status: updated.status }));
      return updated;
    });
  }

  async listContacts(actor: CrmActor, customerId: string, filters: ContactFilters) {
    if (!await this.repository.getCustomerDetail(actor, customerId)) throw customerNotFound();
    return this.repository.listContacts(actor.organizationId, customerId, filters);
  }

  async getContact(actor: CrmActor, customerId: string, contactId: string) {
    return (await this.repository.getContact(actor.organizationId, customerId, contactId)) ?? Promise.reject(contactNotFound());
  }

  async createContact(actor: CrmActor, customerId: string, input: CreateContactInput) {
    requireWriter(actor);
    return this.repository.execute(async (tx) => {
      const parent = await this.requireCustomer(tx, actor, customerId);
      if (parent.status === 'inactive') throw new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşteriye ilgili kişi eklenemez.');
      const active = await tx.lockActiveContacts(actor.organizationId, customerId);
      const created = await tx.createContact({ organizationId: actor.organizationId, customerId,
        name: required(input.name, 'name'), title: optional(input.title), phone: optional(input.phone),
        email: optional(input.email)?.toLowerCase() ?? null, isActive: true, isPrimary: active.length === 0 });
      await tx.appendAudit(audit(actor, 'CONTACT', created.id, 'CONTACT_CREATED', null,
        { customerId, isPrimary: created.isPrimary, isActive: created.isActive }));
      return created;
    });
  }

  async updateContact(actor: CrmActor, customerId: string, contactId: string, input: UpdateContactInput) {
    requireWriter(actor);
    return this.repository.execute(async (tx) => {
      await this.requireCustomer(tx, actor, customerId);
      const current = await this.requireContact(tx, actor, customerId, contactId);
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const updated = await tx.updateContact({ organizationId: actor.organizationId, customerId,
        contactId, expectedVersion: input.expectedVersion, name: required(input.name, 'name'),
        title: optional(input.title), phone: optional(input.phone),
        email: optional(input.email)?.toLowerCase() ?? null });
      if (!updated) throw versionConflict();
      const changedFields = (['name', 'title', 'phone', 'email'] as const)
        .filter((field) => current[field] !== updated[field]);
      if (changedFields.length) await tx.appendAudit(audit(actor, 'CONTACT', contactId,
        'CONTACT_FIELDS_UPDATED', null, null, { changedFields }));
      return updated;
    });
  }

  activateContact(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number) {
    requireWriter(actor);
    return this.changeContactActive(actor, customerId, contactId, expectedVersion, true);
  }

  deactivateContact(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number) {
    requireWriter(actor);
    return this.changeContactActive(actor, customerId, contactId, expectedVersion, false);
  }

  private async changeContactActive(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number, active: boolean) {
    return this.repository.execute(async (tx) => {
      const parent = await this.requireCustomer(tx, actor, customerId);
      if (active && parent.status === 'inactive') throw new AppError('CUSTOMER_INACTIVE', 409, 'Pasif müşterinin ilgili kişisi aktifleştirilemez.');
      const current = await this.requireContact(tx, actor, customerId, contactId);
      if (current.version !== expectedVersion) throw versionConflict(current.version);
      if (current.isActive === active) throw new AppError('INVALID_CONTACT_STATUS_TRANSITION', 409, 'İlgili kişi durumu bu işlem için uygun değil.');
      if (!active && await tx.contactHasActiveJobs(actor.organizationId, contactId)) {
        throw new AppError('CONTACT_HAS_ACTIVE_JOB_CARDS', 409, 'İlgili kişinin açık işleri bulunuyor.');
      }
      const updated = await tx.setContactActive({ organizationId: actor.organizationId,
        customerId, contactId, expectedVersion, isActive: active });
      if (!updated) throw versionConflict();
      await tx.appendAudit(audit(actor, 'CONTACT', contactId,
        active ? 'CONTACT_ACTIVATED' : 'CONTACT_DEACTIVATED',
        { isActive: current.isActive }, { isActive: updated.isActive }));
      return updated;
    });
  }

  async makePrimary(actor: CrmActor, customerId: string, contactId: string, expectedVersion: number): Promise<PrimaryContactResult> {
    requireWriter(actor);
    return this.repository.execute(async (tx) => {
      await this.requireCustomer(tx, actor, customerId);
      const contacts = await tx.lockContactsForPrimary(actor.organizationId, customerId, contactId);
      const target = contacts.find((item) => item.id === contactId);
      if (!target) throw contactNotFound();
      if (!target.isActive) {
        throw new AppError('CONTACT_PRIMARY_REQUIRES_ACTIVE', 409, 'Yalnız aktif ilgili kişi birincil yapılabilir.');
      }
      if (target.version !== expectedVersion) throw versionConflict(target.version);
      if (target.isPrimary) throw new AppError('CONTACT_ALREADY_PRIMARY', 409, 'İlgili kişi zaten birincil.');
      const previous = contacts.find((item) => item.isPrimary && item.isActive) ?? null;
      if (previous) await tx.clearPrimary(previous.id);
      const updated = await tx.setPrimary(target.id, expectedVersion);
      if (!updated) throw versionConflict();
      await tx.appendAudit(audit(actor, 'CONTACT', updated.id, 'CONTACT_MADE_PRIMARY',
        { contactId: previous?.id ?? null }, { contactId: updated.id }));
      return { contact: updated, previousPrimaryContactId: previous?.id ?? null };
    });
  }

  private async requireEligibleStaff(tx: CrmTransaction, actor: CrmActor, userId: string) {
    const user = await tx.lockUser(actor.organizationId, userId);
    if (!user || user.role !== 'STAFF' || !user.isActive) {
      throw new AppError('CUSTOMER_ASSIGNEE_NOT_ELIGIBLE', 409, 'Sorumlu personel aktif bir personel olmalıdır.');
    }
    return user;
  }

  private async requireCustomer(tx: CrmTransaction, actor: CrmActor, customerId: string) {
    return (await tx.lockCustomer(actor.organizationId, customerId)) ?? Promise.reject(customerNotFound());
  }

  private async requireContact(tx: CrmTransaction, actor: CrmActor, customerId: string, contactId: string) {
    return (await tx.lockContact(actor.organizationId, customerId, contactId)) ?? Promise.reject(contactNotFound());
  }
}
