import { describe, expect, it } from 'vitest';

import { CrmService } from '../src/modules/crm/service.js';
import type { Contact, Customer } from '../src/modules/crm/types.js';

const now = new Date('2026-07-12T10:00:00Z');
const manager = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const };
const staff = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

function customer(overrides: Partial<Customer> = {}): Customer {
  return { id: 'customer-1', organizationId: 'org-1', name: 'Demo Klinik',
    customerType: 'clinic', taxNumber: null, phone: null, email: null, city: null,
    district: null, address: null, assignedStaffUserId: null, status: 'prospect',
    version: 1, createdAt: now, updatedAt: now, ...overrides };
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return { id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1',
    name: 'Dr. Ayşe', title: 'Doktor', phone: null, email: null,
    isPrimary: false, isActive: true, version: 1, createdAt: now, updatedAt: now,
    ...overrides };
}

function fixture(options: {
  currentCustomer?: Customer | null;
  currentContact?: Contact;
  activeContacts?: Contact[];
  customerHasJobs?: boolean;
  customerHasAnyJobs?: boolean;
  contactHasJobs?: boolean;
  uniqueTaxFailure?: boolean;
  uniqueConstraint?: string;
  fkViolationOnDelete?: boolean;
} = {}) {
  const audits: unknown[] = [];
  const calls: string[] = [];
  let currentCustomer = options.currentCustomer === undefined ? customer() : options.currentCustomer;
  let currentContact = options.currentContact ?? contact();
  const tx = {
    lockUser: async (_org: string, id: string) => id === 'staff-1'
      ? { id, organizationId: 'org-1', role: 'STAFF', isActive: true } : null,
    lockCustomer: async (organizationId: string) => (
      currentCustomer?.organizationId === organizationId ? currentCustomer : null
    ),
    createCustomer: async (input: Record<string, unknown>) => {
      if (options.uniqueTaxFailure || options.uniqueConstraint) throw Object.assign(new Error('unique'), {
        code: '23505', constraint: options.uniqueConstraint ?? 'customers_organization_tax_number_unique',
      });
      currentCustomer = customer({ ...input, id: 'customer-created' } as Partial<Customer>);
      return currentCustomer;
    },
    updateCustomer: async (input: Record<string, unknown>) => customer({ ...currentCustomer!, ...input, version: currentCustomer!.version + 1 } as Partial<Customer>),
    setCustomerStatus: async (input: { status: Customer['status'] }) => customer({ ...currentCustomer!, status: input.status, version: currentCustomer!.version + 1 }),
    customerHasActiveJobs: async () => options.customerHasJobs ?? false,
    customerHasAnyJobs: async () => options.customerHasAnyJobs ?? false,
    deleteContactsForCustomer: async () => { calls.push('delete-contacts'); },
    deleteCustomer: async () => {
      calls.push('delete-customer');
      if (options.fkViolationOnDelete) {
        throw Object.assign(new Error('fk'), { code: '23503' });
      }
      currentCustomer = null;
      return true;
    },
    lockContact: async () => currentContact,
    lockActiveContacts: async () => options.activeContacts ?? [currentContact],
    lockContactsForPrimary: async () => options.activeContacts ?? [currentContact],
    createContact: async (input: Record<string, unknown>) => {
      currentContact = contact({ ...input, id: 'contact-created' } as Partial<Contact>);
      return currentContact;
    },
    updateContact: async (input: Record<string, unknown>) => contact({ ...currentContact, ...input, version: currentContact.version + 1 } as Partial<Contact>),
    setContactActive: async (input: { isActive: boolean }) => contact({ ...currentContact, isActive: input.isActive, isPrimary: false, version: currentContact.version + 1 }),
    clearPrimary: async (id: string) => { calls.push(`clear:${id}:3`); return contact({ id, isPrimary: false, version: 3 }); },
    setPrimary: async (id: string) => { calls.push(`primary:${id}:${currentContact.version + 1}`); return contact({ id, isPrimary: true, version: currentContact.version + 1 }); },
    contactHasActiveJobs: async () => options.contactHasJobs ?? false,
    appendAudit: async (input: unknown) => { audits.push(input); },
  };
  const repository = {
    execute: async <T>(work: (value: typeof tx) => Promise<T>) => work(tx),
    listCustomers: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    getCustomerDetail: async () => null,
    listContacts: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    getContact: async () => null,
  };
  return { service: new CrmService(repository as never), audits, calls };
}

describe('CRM service policy', () => {
  it('conceals a missing or cross-organization Customer on nested Contact lists', async () => {
    const { service } = fixture();
    await expect(service.listContacts(manager, 'missing-customer', {
      q: null, status: 'active', limit: 50, offset: 0,
    })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('allows Staff to create a prospect assigned to themselves while keeping other CRM mutations forbidden', async () => {
    const { service } = fixture();
    const createCustomerInput = {
      name: 'Klinik', customerType: 'clinic', status: 'prospect', taxNumber: null,
      phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null,
    } as const;
    const updateCustomerInput = { ...createCustomerInput, expectedVersion: 1 };
    const createContactInput = { name: 'Dr. Ayşe', title: null, phone: null, email: null };
    const updateContactInput = { ...createContactInput, expectedVersion: 1 };
    const mutations = [
      () => service.updateCustomer(staff, 'customer-1', updateCustomerInput),
      () => service.activateCustomer(staff, 'customer-1', 1),
      () => service.deactivateCustomer(staff, 'customer-1', 1),
      () => service.deleteCustomer(staff, 'customer-1', 1),
      () => service.createContact(staff, 'customer-1', createContactInput),
      () => service.updateContact(staff, 'customer-1', 'contact-1', updateContactInput),
      () => service.activateContact(staff, 'customer-1', 'contact-1', 1),
      () => service.deactivateContact(staff, 'customer-1', 'contact-1', 1),
      () => service.makePrimary(staff, 'customer-1', 'contact-1', 1),
    ];
    for (const mutate of mutations) {
      await expect(Promise.resolve().then(mutate)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    await expect(service.createCustomer(staff, {
      ...createCustomerInput, status: 'active', assignedStaffUserId: 'someone-else',
    })).resolves.toMatchObject({
      organizationId: 'org-1', assignedStaffUserId: 'staff-1', status: 'prospect',
    });
  });

  it('conceals a cross-organization Customer as not found', async () => {
    const { service } = fixture({ currentCustomer: customer({ organizationId: 'org-2' }) });
    await expect(service.updateCustomer(manager, 'customer-1', {
      expectedVersion: 1, name: 'Klinik', customerType: 'clinic', taxNumber: null,
      phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null,
    })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('requires prospect or active initial status and an eligible Staff assignee', async () => {
    const { service, audits } = fixture();
    await expect(service.createCustomer(manager, {
      name: 'Klinik', customerType: 'clinic', status: 'inactive', taxNumber: null,
      phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const created = await service.createCustomer(manager, {
      name: ' Klinik ', customerType: 'clinic', status: 'active', taxNumber: ' ab-12 ',
      phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: 'staff-1',
    });
    expect(created.assignedStaffUserId).toBe('staff-1');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toMatch(/AB12|phone|email|address/i);
  });

  it('enforces Customer status transitions, versions, and active JobCard guard', async () => {
    const guarded = fixture({ currentCustomer: customer({ status: 'active', version: 4 }), customerHasJobs: true });
    await expect(guarded.service.deactivateCustomer(manager, 'customer-1', 4))
      .rejects.toMatchObject({ code: 'CUSTOMER_HAS_ACTIVE_JOB_CARDS' });

    const stale = fixture({ currentCustomer: customer({ status: 'inactive', version: 4 }) });
    await expect(stale.service.activateCustomer(manager, 'customer-1', 3))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 4 } });

    const invalid = fixture({ currentCustomer: customer({ status: 'active', version: 4 }) });
    await expect(invalid.service.activateCustomer(manager, 'customer-1', 4))
      .rejects.toMatchObject({ code: 'INVALID_CUSTOMER_STATUS_TRANSITION' });
  });

  it('makes the first Contact primary and never makes a reactivated Contact primary', async () => {
    const first = fixture({ activeContacts: [] });
    const created = await first.service.createContact(manager, 'customer-1', {
      name: 'Dr. Ayşe', title: null, phone: null, email: null,
    });
    expect(created.isActive).toBe(true);
    expect(created.isPrimary).toBe(true);

    const inactive = fixture({ currentContact: contact({ isActive: false, isPrimary: false, version: 2 }) });
    const activated = await inactive.service.activateContact(manager, 'customer-1', 'contact-1', 2);
    expect(activated.isPrimary).toBe(false);
  });

  it('blocks Contact deactivation while active JobCards reference it', async () => {
    const { service } = fixture({ contactHasJobs: true });
    await expect(service.deactivateContact(manager, 'customer-1', 'contact-1', 1))
      .rejects.toMatchObject({ code: 'CONTACT_HAS_ACTIVE_JOB_CARDS' });
  });

  it('increments both primary rows and audits only old and new Contact IDs', async () => {
    const previous = contact({ id: 'contact-old', isPrimary: true, version: 2 });
    const target = contact({ id: 'contact-new', isPrimary: false, version: 5 });
    const { service, calls, audits } = fixture({ currentContact: target, activeContacts: [previous, target] });

    const result = await service.makePrimary(manager, 'customer-1', 'contact-new', 5);

    expect(calls).toEqual(['clear:contact-old:3', 'primary:contact-new:6']);
    expect(result.previousPrimaryContactId).toBe('contact-old');
    expect(result.contact.isPrimary).toBe(true);
    expect(result.contact.version).toBe(6);
    expect(audits[0]).toMatchObject({
      oldValue: { contactId: 'contact-old' }, newValue: { contactId: 'contact-new' }, metadata: {},
    });
  });

  it('rejects an inactive primary target with the canonical error', async () => {
    const inactive = contact({ id: 'contact-inactive', isActive: false, version: 4 });
    const { service } = fixture({ currentContact: inactive, activeContacts: [inactive] });
    await expect(service.makePrimary(manager, 'customer-1', inactive.id, 4))
      .rejects.toMatchObject({ code: 'CONTACT_PRIMARY_REQUIRES_ACTIVE' });
  });

  it('maps only the tax-number unique constraint to the stable conflict', async () => {
    const { service } = fixture({ uniqueTaxFailure: true });
    await expect(service.createCustomer(manager, {
      name: 'Klinik', customerType: 'clinic', status: 'prospect', taxNumber: '123',
      phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null,
    })).rejects.toMatchObject({ code: 'CUSTOMER_TAX_NUMBER_EXISTS' });

    const other = fixture({ uniqueConstraint: 'another_unique_constraint' });
    await expect(other.service.createCustomer(manager, {
      name: 'Klinik', customerType: 'clinic', status: 'prospect', taxNumber: '123',
      phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null,
    })).rejects.toMatchObject({ code: '23505', constraint: 'another_unique_constraint' });
  });

  it('deletes a Customer without operation history after removing Contacts and auditing', async () => {
    const { service, calls, audits } = fixture({ currentCustomer: customer({ status: 'active' }) });
    await expect(service.deleteCustomer(manager, 'customer-1', 1)).resolves.toBeUndefined();
    expect(calls).toEqual(['delete-contacts', 'delete-customer']);
    expect(audits).toEqual([{
      organizationId: 'org-1', actorUserId: 'manager-1', subjectType: 'CUSTOMER',
      subjectId: 'customer-1', eventType: 'CUSTOMER_DELETED',
      oldValue: { name: 'Demo Klinik', status: 'active', customerType: 'clinic' },
      newValue: null, metadata: {},
    }]);
  });

  it('blocks Customer delete when any JobCards reference the Customer', async () => {
    const { service, calls, audits } = fixture({ customerHasAnyJobs: true });
    await expect(service.deleteCustomer(manager, 'customer-1', 1)).rejects.toMatchObject({
      code: 'CUSTOMER_HAS_OPERATION_HISTORY', statusCode: 409,
      message: 'Bu müşteri geçmiş iş veya teslimat kayıtlarında kullanıldığı için silinemez.',
    });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('maps FK violations on Customer delete to the operation-history conflict', async () => {
    const { service } = fixture({ fkViolationOnDelete: true });
    await expect(service.deleteCustomer(manager, 'customer-1', 1)).rejects.toMatchObject({
      code: 'CUSTOMER_HAS_OPERATION_HISTORY', statusCode: 409,
    });
  });

  it('conceals a missing Customer on delete', async () => {
    const { service } = fixture({ currentCustomer: null });
    await expect(service.deleteCustomer(manager, 'missing', 1)).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND', statusCode: 404,
    });
  });
});

  it('rejects Customer delete when expectedVersion is stale', async () => {
    const { service } = fixture();
    await expect(service.deleteCustomer(manager, 'customer-1', 99)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT', statusCode: 409,
    });
  });
