import { describe, expect, it } from 'vitest';

import { CrmService } from '../src/modules/crm/service.js';
import { normalizeTurkishPhone } from '../src/modules/crm/types.js';
import type { Customer } from '../src/modules/crm/types.js';

const now = new Date('2026-09-28T10:00:00Z');
const manager = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const };
const staff = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const };

const CANONICAL_MOBILE = '+905321234567';
const CANONICAL_LANDLINE = '+903121234567';

function customer(overrides: Partial<Customer> = {}): Customer {
  return { id: 'customer-1', organizationId: 'org-1', name: 'Demo Klinik',
    customerType: 'clinic', taxNumber: null, phone: null, email: null, city: null,
    district: null, address: null, assignedStaffUserId: null, status: 'prospect',
    version: 1, createdAt: now, updatedAt: now, ...overrides };
}

const baseInput = {
  name: 'Klinik', customerType: 'clinic' as const, status: 'prospect' as const,
  taxNumber: null, phone: null as string | null, email: null, city: null,
  district: null, address: null, assignedStaffUserId: null,
};

function fixture(current: Customer | null = customer()) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const tx = {
    lockUser: async (organizationId: string, id: string) => (
      id === 'staff-1' && organizationId === 'org-1'
        ? { id, organizationId: 'org-1', role: 'STAFF', isActive: true } : null
    ),
    lockCustomer: async (organizationId: string) => (
      current?.organizationId === organizationId ? current : null
    ),
    createCustomer: async (input: Record<string, unknown>) => {
      created.push(input);
      return customer({ ...input, id: 'customer-created' } as Partial<Customer>);
    },
    updateCustomer: async (input: Record<string, unknown>) => {
      updated.push(input);
      return customer({ ...current!, ...input, version: current!.version + 1 } as Partial<Customer>);
    },
    appendAudit: async () => {},
  };
  const repository = {
    execute: async <T>(work: (value: typeof tx) => Promise<T>) => work(tx),
    listCustomers: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    getCustomerDetail: async () => null,
  };
  return { service: new CrmService(repository as never), created, updated };
}

describe('normalizeTurkishPhone', () => {
  it('resolves every accepted Turkish shape to one canonical +90 value', () => {
    const accepted = [
      '05321234567', '(0532) 123 45 67', '0532 123 45 67', '+905321234567',
      '905321234567', '90 532 123 45 67', '5321234567', '  0532 123 45 67  ',
      '+90 (532) 123-45-67', '0532.123.45.67',
    ];
    for (const input of accepted) expect(normalizeTurkishPhone(input), input).toBe(CANONICAL_MOBILE);
  });

  it('accepts landline area codes such as 0312 instead of locking onto mobile 05xx', () => {
    expect(normalizeTurkishPhone('03121234567')).toBe(CANONICAL_LANDLINE);
    expect(normalizeTurkishPhone('(0312) 123 45 67')).toBe(CANONICAL_LANDLINE);
    expect(normalizeTurkishPhone('+903121234567')).toBe(CANONICAL_LANDLINE);
    expect(normalizeTurkishPhone('3121234567')).toBe(CANONICAL_LANDLINE);
  });

  it('rejects empty, short, long, non-numeric and foreign values without guessing', () => {
    const rejected = [
      '', '   ', '0', '0532', '0532123456', '053212345678', '532123456', '53212345678',
      'abcdef', '0532 123 45 67 x', '---', '+', '(0532) 123 45', '0532-123-45-6',
      '+1 202 555 0147', '+49 151 12345678', '+9005321234567',
    ];
    for (const input of rejected) expect(normalizeTurkishPhone(input), input).toBeNull();
    expect(normalizeTurkishPhone(null)).toBeNull();
    expect(normalizeTurkishPhone(undefined)).toBeNull();
  });

  it('round-trips without losing digits, duplicating the trunk zero or doubling +90', () => {
    const shapes = ['05321234567', '(0532) 123 45 67', '0532 123 45 67', '+905321234567',
      '905321234567', '5321234567'];
    expect(new Set(shapes.map((shape) => normalizeTurkishPhone(shape))).size).toBe(1);
    const national = CANONICAL_MOBILE.slice(3);
    expect(normalizeTurkishPhone(CANONICAL_MOBILE)).toBe(CANONICAL_MOBILE);
    expect(normalizeTurkishPhone(`+90${national}`)).toBe(CANONICAL_MOBILE);
    expect(normalizeTurkishPhone(`0${national}`)).toBe(CANONICAL_MOBILE);
    expect(normalizeTurkishPhone(`+90+90${national}`)).toBeNull();
    expect(normalizeTurkishPhone(`00${national}`)).toBeNull();
  });
});

describe('customer create contract requires a normalized Turkish phone', () => {
  it('rejects a missing or malformed phone with fieldErrors before any write', async () => {
    const rejected = [null, '', '   ', '0532', '0532123456', '053212345678', 'abc',
      '+1 202 555 0147', '---'];
    for (const phone of rejected) {
      const { service, created } = fixture();
      await expect(service.createCustomer(manager, { ...baseInput, phone })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Geçerli bir telefon numarası girin.',
        details: { fieldErrors: { phone: 'Geçerli bir telefon numarası girin.' } },
      });
      expect(created, String(phone)).toHaveLength(0);
    }
  });

  it('stores the canonical +90 form for every accepted shape', async () => {
    const cases: [string, string][] = [
      ['05321234567', CANONICAL_MOBILE],
      ['(0532) 123 45 67', CANONICAL_MOBILE],
      ['+905321234567', CANONICAL_MOBILE],
      ['5321234567', CANONICAL_MOBILE],
      ['03121234567', CANONICAL_LANDLINE],
      ['(0312) 123 45 67', CANONICAL_LANDLINE],
    ];
    for (const [phone, expected] of cases) {
      const { service, created } = fixture();
      await service.createCustomer(manager, { ...baseInput, phone });
      expect(created[0]!.phone, phone).toBe(expected);
    }
  });

  it('applies the same requirement to a Staff-created prospect', async () => {
    const denied = fixture();
    await expect(denied.service.createCustomer(staff, { ...baseInput, phone: null }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(denied.created).toHaveLength(0);

    const allowed = fixture();
    await allowed.service.createCustomer(staff, { ...baseInput, phone: '05321234567' });
    expect(allowed.created[0]).toMatchObject({
      phone: CANONICAL_MOBILE, status: 'prospect', assignedStaffUserId: 'staff-1',
    });
  });
});

describe('customer edit contract stays permissive', () => {
  it('keeps a phone-less historical customer phone-less through an unrelated edit', async () => {
    const { service, updated } = fixture(customer({ phone: null, version: 3 }));
    await service.updateCustomer(manager, 'customer-1',
      { ...baseInput, phone: null, expectedVersion: 3 });
    expect(updated[0]).toMatchObject({ phone: null });
  });

  it('normalizes a supplied phone but preserves unresolvable historical text verbatim', async () => {
    const normalized = fixture(customer({ phone: '555', version: 2 }));
    await normalized.service.updateCustomer(manager, 'customer-1',
      { ...baseInput, phone: '0532 123 45 67', expectedVersion: 2 });
    expect(normalized.updated[0]).toMatchObject({ phone: CANONICAL_MOBILE });

    const legacy = fixture(customer({ phone: '555', version: 2 }));
    await legacy.service.updateCustomer(manager, 'customer-1',
      { ...baseInput, phone: '555', expectedVersion: 2 });
    expect(legacy.updated[0]).toMatchObject({ phone: '555' });
  });
});
