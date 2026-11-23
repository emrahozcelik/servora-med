import { describe, expect, it } from 'vitest';

import {
  LIVE_PAIR_SOURCE_STATUSES,
  PAIR_OPERATION_KEYS,
  expectedSaleVersionRequired,
  isLivePairSource,
  isPairOwnedTogether,
  isSalePairCommand,
  noCoordinatedPair,
  redirectsSaleCommand,
  salePairAssigneeConflict,
  salePairRedirect,
  salePairStateConflict,
} from '../src/modules/job-cards/sale-pair-policy.js';
import { getAllowedLifecycleCommands } from '../src/modules/job-cards/policy.js';
import {
  JOB_CARD_STATUSES,
  type JobCard,
  type JobCardActor,
  type LifecycleCommand,
} from '../src/modules/job-cards/types.js';

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };

const visit = {
  id: 'visit-1', organizationId: 'org-1', type: 'SALES_MEETING' as const,
  status: 'IN_PROGRESS' as const, version: 3, title: 'Klinik ziyareti',
  customerId: 'customer-1', assignedTo: 'staff-1',
};
const sale = {
  id: 'sale-1', organizationId: 'org-1', type: 'SALE' as const,
  status: 'ACCEPTED' as const, version: 1, title: 'Ürün anlaşması',
  customerId: 'customer-1', assignedTo: 'staff-1',
};

describe('SALE-002 §4.2 pair policy', () => {
  it('knows exactly the five pair-capable commands', () => {
    const commands: LifecycleCommand[] = [
      'ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT', 'RELEASE_ASSIGNMENT', 'START',
      'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL',
      'RESUME', 'CANCEL',
    ];
    expect(commands.filter(isSalePairCommand)).toEqual([
      'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'RESUME',
    ]);
  });

  it('treats only IN_PROGRESS / WAITING_APPROVAL / REVISION_REQUESTED as a live source', () => {
    expect(LIVE_PAIR_SOURCE_STATUSES).toEqual([
      'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
    ]);
    for (const status of JOB_CARD_STATUSES) {
      expect(isLivePairSource(status)).toBe(LIVE_PAIR_SOURCE_STATUSES.includes(status));
    }
    // A terminal source releases the sale to its independent lifecycle.
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      expect(isLivePairSource(status)).toBe(false);
    }
  });

  it('applies the redirect table exactly, in both directions', () => {
    expect(redirectsSaleCommand('SUBMIT_FOR_APPROVAL', 'IN_PROGRESS')).toBe(true);
    expect(redirectsSaleCommand('SUBMIT_FOR_APPROVAL', 'REVISION_REQUESTED')).toBe(true);
    expect(redirectsSaleCommand('SUBMIT_FOR_APPROVAL', 'WAITING_APPROVAL')).toBe(false);
    expect(redirectsSaleCommand('APPROVE', 'WAITING_APPROVAL')).toBe(true);
    expect(redirectsSaleCommand('APPROVE', 'IN_PROGRESS')).toBe(false);
    expect(redirectsSaleCommand('REQUEST_REVISION', 'WAITING_APPROVAL')).toBe(true);
    expect(redirectsSaleCommand('REQUEST_REVISION', 'REVISION_REQUESTED')).toBe(false);
    expect(redirectsSaleCommand('WITHDRAW_FROM_APPROVAL', 'WAITING_APPROVAL')).toBe(true);
    expect(redirectsSaleCommand('WITHDRAW_FROM_APPROVAL', 'IN_PROGRESS')).toBe(false);
    expect(redirectsSaleCommand('RESUME', 'REVISION_REQUESTED')).toBe(true);
    expect(redirectsSaleCommand('RESUME', 'WAITING_APPROVAL')).toBe(false);
    // No terminal source status ever redirects.
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      for (const command of Object.keys(PAIR_OPERATION_KEYS) as Array<keyof typeof PAIR_OPERATION_KEYS>) {
        expect(redirectsSaleCommand(command, status)).toBe(false);
      }
    }
  });

  it('requires one owner per live pair', () => {
    expect(isPairOwnedTogether(visit, sale)).toBe(true);
    expect(isPairOwnedTogether(visit, { ...sale, assignedTo: 'staff-2' })).toBe(false);
  });

  it('emits the coded redirect with the exact next action', () => {
    const error = salePairRedirect({
      command: 'SUBMIT_FOR_APPROVAL', visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'ACCEPTED',
    });
    expect(error).toMatchObject({
      code: 'SALE_SUBMIT_VIA_VISIT_REQUIRED',
      statusCode: 409,
      details: {
        visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'ACCEPTED',
        allowedSaleCommand: 'SUBMIT_FOR_APPROVAL',
      },
    });
    expect(salePairRedirect({
      command: 'APPROVE', visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
    })).toMatchObject({ code: 'SALE_APPROVE_VIA_VISIT_REQUIRED' });
    expect(salePairRedirect({
      command: 'REQUEST_REVISION', visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
    })).toMatchObject({ code: 'SALE_REVISION_VIA_VISIT_REQUIRED' });
    expect(salePairRedirect({
      command: 'WITHDRAW_FROM_APPROVAL', visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
    })).toMatchObject({ code: 'SALE_WITHDRAW_VIA_VISIT_REQUIRED' });
    expect(salePairRedirect({
      command: 'RESUME', visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'REVISION_REQUESTED',
    })).toMatchObject({ code: 'SALE_RESUME_VIA_VISIT_REQUIRED' });
  });

  it('names the single-card prerequisite of a blocked visit submission (§4.3 step 3)', () => {
    expect(salePairStateConflict({
      visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'NEW',
      allowedSaleCommand: 'ACCEPT_ASSIGNMENT',
    })).toMatchObject({
      code: 'SALE_PAIR_STATE_CONFLICT',
      statusCode: 409,
      details: { allowedSaleCommand: 'ACCEPT_ASSIGNMENT', saleStatus: 'NEW' },
    });
    expect(salePairStateConflict({
      visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'REVISION_REQUESTED',
      allowedSaleCommand: 'RESUME',
    })).toMatchObject({
      code: 'SALE_PAIR_STATE_CONFLICT',
      details: { allowedSaleCommand: 'RESUME', saleStatus: 'REVISION_REQUESTED' },
    });
  });

  it('separates the ownership conflict, the missing pair and the missing version', () => {
    expect(salePairAssigneeConflict({
      visitAssignee: 'staff-1', requestedAssignee: 'staff-2',
    })).toMatchObject({
      code: 'SALE_PAIR_ASSIGNEE_CONFLICT',
      statusCode: 409,
      details: { visitAssignee: 'staff-1', requestedAssignee: 'staff-2' },
    });
    expect(noCoordinatedPair()).toMatchObject({
      code: 'SALE_PAIR_STATE_CONFLICT',
      statusCode: 409,
      details: { reason: 'NO_COORDINATED_PAIR' },
    });
    expect(expectedSaleVersionRequired()).toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: { fieldErrors: { expectedSaleVersion: expect.any(String) } },
    });
  });

  it('keeps every pair operation key inside the 100-character limit', () => {
    const visitId = '7f9a1a1e-6ba7-4b4d-9c1f-2b0f2c5f8a11';
    const saleId = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
    for (const key of Object.values(PAIR_OPERATION_KEYS)) {
      const anchor = `${key}:${visitId}`;
      expect(anchor.length).toBeLessThanOrEqual(100);
      expect(`${anchor}:participant`.length).toBeLessThanOrEqual(100);
    }
    expect(Object.values(PAIR_OPERATION_KEYS)).toEqual([
      'JOB_SUBMIT_FOR_APPROVAL_PAIR', 'JOB_APPROVE_PAIR', 'JOB_REQUEST_REVISION_PAIR',
      'JOB_WITHDRAW_FROM_APPROVAL_PAIR', 'JOB_RESUME_PAIR',
    ]);
    expect(saleId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('SALE-002 R9 / accepted Q1: a SALE may submit from ACCEPTED', () => {
  const saleJob = {
    ...sale, status: 'ACCEPTED' as const,
  } as unknown as JobCard;

  it('offers SUBMIT_FOR_APPROVAL from ACCEPTED for the assigned staff member only', () => {
    expect(getAllowedLifecycleCommands(staff, saleJob)).toEqual([
      'START', 'SUBMIT_FOR_APPROVAL', 'CANCEL',
    ]);
    // Management does not submit on the staff member's behalf.
    expect(getAllowedLifecycleCommands(manager, saleJob)).toEqual(['CANCEL']);
    // Another staff member cannot reach the card at all.
    expect(getAllowedLifecycleCommands({ ...staff, id: 'staff-2' }, saleJob)).toEqual([]);
  });

  it('leaves every other type exactly as before', () => {
    for (const type of ['SALES_MEETING', 'PRODUCT_DELIVERY', 'GENERAL_TASK'] as const) {
      const other = { ...saleJob, type } as unknown as JobCard;
      expect(getAllowedLifecycleCommands(staff, other)).toEqual(['START', 'CANCEL']);
    }
    // WEEKLY_REPORT keeps its own staff-cancel filter untouched.
    expect(getAllowedLifecycleCommands(
      staff, { ...saleJob, type: 'WEEKLY_REPORT' } as unknown as JobCard,
    )).toEqual(['START']);
  });

  it('keeps IN_PROGRESS reachable for a sale that does start', () => {
    const started = { ...saleJob, status: 'IN_PROGRESS' as const } as unknown as JobCard;
    expect(getAllowedLifecycleCommands(staff, started)).toEqual(['SUBMIT_FOR_APPROVAL', 'CANCEL']);
  });

  it('keeps the visit path unchanged', () => {
    const acceptedVisit = { ...visit, status: 'ACCEPTED' as const } as unknown as JobCard;
    expect(getAllowedLifecycleCommands(staff, acceptedVisit)).toEqual(['START', 'CANCEL']);
  });
});
