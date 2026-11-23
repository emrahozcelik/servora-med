import { describe, expect, it } from 'vitest';

import { assertSaleSourceEligible } from '../src/modules/job-cards/sale-policy.js';
import { mapSaleIntegrityError } from '../src/modules/job-cards/sale-service.js';
import type { SaleSource } from '../src/modules/job-cards/sale-repository.js';

const source: SaleSource = {
  id: 'visit-1',
  organizationId: 'org-1',
  type: 'SALES_MEETING',
  status: 'IN_PROGRESS',
  version: 1,
  title: 'Clinic visit',
  customerId: 'customer-1',
  contactId: null,
  assignedTo: 'staff-1',
  engagementKind: 'CUSTOMER_VISIT',
  dataClass: 'BUSINESS',
  metContactId: null,
};

describe('Sale source eligibility (SALE-002 R3)', () => {
  it.each(['IN_PROGRESS', 'COMPLETED'] as const)('accepts a %s visit source', (status) => {
    expect(() => assertSaleSourceEligible({ ...source, status })).not.toThrow();
  });

  it.each(['NEW', 'ACCEPTED', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'CANCELLED', 'INVALIDATED'] as const)(
    'rejects a %s visit source',
    (status) => {
      expect(() => assertSaleSourceEligible({ ...source, status }))
        .toThrowError(expect.objectContaining({
          code: 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE', statusCode: 409,
        }));
    },
  );

  it('keeps type, data class, customer, engagement and DEMO guards', () => {
    for (const value of [
      { ...source, type: 'GENERAL_TASK' as const },
      { ...source, dataClass: 'DEMO' as const },
      { ...source, customerId: null },
      { ...source, engagementKind: null },
      { ...source, engagementKind: 'TRAINING' as const },
    ]) {
      expect(() => assertSaleSourceEligible(value as SaleSource))
        .toThrowError(expect.objectContaining({ code: 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE' }));
    }
  });
});

describe('Sale integrity error mapping (SALE-002 R8)', () => {
  it('maps each named unique index to its domain conflict', () => {
    expect(() => mapSaleIntegrityError({
      code: '23505', constraint: 'job_cards_one_active_sale_per_visit_idx',
    })).toThrowError(expect.objectContaining({
      code: 'SALE_FROM_VISIT_ACTIVE_EXISTS', statusCode: 409,
    }));
    expect(() => mapSaleIntegrityError({
      code: '23505', constraint: 'job_cards_one_delivery_per_sale_idx',
    })).toThrowError(expect.objectContaining({
      code: 'SALE_DELIVERY_ALREADY_EXISTS', statusCode: 409,
    }));
  });

  it('rethrows unrelated database failures unchanged', () => {
    const foreignKey = { code: '23503', constraint: 'job_cards_delivery_source_sale_fk' };
    try {
      mapSaleIntegrityError(foreignKey);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBe(foreignKey);
    }
  });
});
