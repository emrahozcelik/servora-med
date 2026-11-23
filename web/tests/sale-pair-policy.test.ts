import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/services/api';
import type { JobCardStatus, LifecycleCommand } from '../src/jobs/jobs-api';
import { requirementLabels } from '../src/jobs/job-workflow-presentation';
import {
  approvalCompletesSale,
  coordinatedSaleVersion,
  isActiveSaleStatus,
  lifecycleMovesSale,
  pairConflictGuidance,
  pairManagedSaleCommand,
  pairRedirectGuidance,
  pairSuccessSuffix,
  salePairRedirectFrom,
  salePairStateConflictFrom,
  visitSubmitPairBlockers,
  type PairSaleFacts,
  type VisitPairSale,
} from '../src/jobs/sale-pair';

const sale: PairSaleFacts = {
  id: 'sale-1', title: 'Kasım anlaşması', status: 'ACCEPTED', version: 7,
  assignedTo: 'staff-1', readiness: null,
};

const visitSale: VisitPairSale = {
  ...sale,
  status: 'WAITING_APPROVAL',
  items: [{
    id: 'line-1', productId: 'product-1', name: 'Dental implant seti', sku: null,
    brand: null, model: null, unit: null, quantity: '3',
  }],
};

function versionFor(
  command: LifecycleCommand,
  visitStatus: JobCardStatus,
  overrides: Partial<PairSaleFacts> = {},
  visitAssignedTo = 'staff-1',
): number | null {
  return coordinatedSaleVersion({
    command,
    visitStatus,
    visitAssignedTo,
    sale: { ...sale, ...overrides },
  });
}

function conflict(code: string, details: Record<string, unknown>, status = 409) {
  return new ApiError(status, code, 'mesaj', false, details);
}

describe('SALE-002 pair coordination (§4.2/§4.5)', () => {
  it('requires expectedSaleVersion only in the coordinating visit status of each command', () => {
    expect(versionFor('SUBMIT_FOR_APPROVAL', 'IN_PROGRESS')).toBe(7);
    expect(versionFor('APPROVE', 'WAITING_APPROVAL')).toBe(7);
    expect(versionFor('REQUEST_REVISION', 'WAITING_APPROVAL')).toBe(7);
    expect(versionFor('WITHDRAW_FROM_APPROVAL', 'WAITING_APPROVAL')).toBe(7);
    expect(versionFor('RESUME', 'REVISION_REQUESTED')).toBe(7);
  });

  it('omits the field outside the coordinating status and for non-pair commands', () => {
    expect(versionFor('SUBMIT_FOR_APPROVAL', 'WAITING_APPROVAL')).toBeNull();
    expect(versionFor('APPROVE', 'IN_PROGRESS')).toBeNull();
    expect(versionFor('RESUME', 'WAITING_APPROVAL')).toBeNull();
    expect(versionFor('CANCEL', 'IN_PROGRESS')).toBeNull();
    expect(versionFor('START', 'IN_PROGRESS')).toBeNull();
    expect(versionFor('ACCEPT_ASSIGNMENT', 'IN_PROGRESS')).toBeNull();
  });

  it('never coordinates a decoupled pair or a sale that left the active set', () => {
    expect(versionFor('SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', { assignedTo: 'other-staff' })).toBeNull();
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      expect(versionFor('SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', { status })).toBeNull();
    }
    expect(coordinatedSaleVersion({
      command: 'SUBMIT_FOR_APPROVAL', visitStatus: 'IN_PROGRESS', visitAssignedTo: 'staff-1', sale: null,
    })).toBeNull();
  });

  it('keeps the active sale set explicit', () => {
    for (const status of ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
      expect(isActiveSaleStatus(status)).toBe(true);
    }
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      expect(isActiveSaleStatus(status)).toBe(false);
    }
  });
});

describe('SALE-002 redirect and conflict payloads (§4.2/§4.5)', () => {
  it('parses every redirect code with its pair payload', () => {
    const redirect = salePairRedirectFrom(conflict('SALE_APPROVE_VIA_VISIT_REQUIRED', {
      visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
      allowedSaleCommand: 'APPROVE',
    }));
    expect(redirect).toEqual({
      code: 'SALE_APPROVE_VIA_VISIT_REQUIRED',
      visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
      allowedSaleCommand: 'APPROVE',
    });
  });

  it('ignores other codes, other statuses and malformed fields', () => {
    expect(salePairRedirectFrom(conflict('SALE_SUBMIT_VIA_VISIT_REQUIRED', {}, 400))).toBeNull();
    expect(salePairRedirectFrom(conflict('VERSION_CONFLICT', {}))).toBeNull();
    expect(salePairRedirectFrom(new Error('boom'))).toBeNull();
    expect(salePairRedirectFrom(conflict('SALE_SUBMIT_VIA_VISIT_REQUIRED', {
      visitId: 42, allowedSaleCommand: 'NOT_A_COMMAND', saleStatus: 'BOGUS',
    }))).toEqual({
      code: 'SALE_SUBMIT_VIA_VISIT_REQUIRED',
      visitId: null, saleId: null, saleStatus: null, allowedSaleCommand: null,
    });
  });

  it('parses a pair state conflict with its named next step', () => {
    expect(salePairStateConflictFrom(conflict('SALE_PAIR_STATE_CONFLICT', {
      reason: 'NO_COORDINATED_PAIR',
    }))).toEqual({
      allowedSaleCommand: null, reason: 'NO_COORDINATED_PAIR', visitId: null, saleId: null,
    });
    expect(salePairStateConflictFrom(conflict('SALE_PAIR_STATE_CONFLICT', {
      allowedSaleCommand: 'ACCEPT_ASSIGNMENT', saleId: 'sale-1',
    }))).toEqual({
      allowedSaleCommand: 'ACCEPT_ASSIGNMENT', reason: null, visitId: null, saleId: 'sale-1',
    });
    expect(salePairStateConflictFrom(conflict('SALE_NOT_READY', {}))).toBeNull();
  });
});

describe('SALE-002 pair guidance copy', () => {
  it('points a redirected sale command at the visit card', () => {
    const guidance = pairRedirectGuidance({
      code: 'SALE_APPROVE_VIA_VISIT_REQUIRED',
      visitId: 'visit-1', saleId: 'sale-1', saleStatus: 'WAITING_APPROVAL',
      allowedSaleCommand: 'APPROVE',
    }, null);
    expect(guidance.message).toContain('bağlı ziyaret kaydıyla birlikte verilir');
    expect(guidance.message).toContain('ziyaret kartından yürütün');
    expect(guidance.targetId).toBe('visit-1');
    expect(guidance.targetLabel).toBe('Ziyaret kartını aç');
  });

  it('falls back to the readable source visit when the payload omits the id', () => {
    const guidance = pairRedirectGuidance({
      code: 'SALE_SUBMIT_VIA_VISIT_REQUIRED',
      visitId: null, saleId: null, saleStatus: null, allowedSaleCommand: null,
    }, 'visit-9');
    expect(guidance.targetId).toBe('visit-9');
  });

  it('names the sale-side next step for a pair state conflict', () => {
    const guidance = pairConflictGuidance({
      allowedSaleCommand: 'ACCEPT_ASSIGNMENT', reason: null, visitId: null, saleId: 'sale-1',
    }, null);
    expect(guidance.message).toContain('“Satış kaydını kabul et”');
    expect(guidance.targetId).toBe('sale-1');
    expect(guidance.targetLabel).toBe('Satış kaydını aç');
  });

  it('treats a vanished pair as a conflict without a link', () => {
    const guidance = pairConflictGuidance({
      allowedSaleCommand: null, reason: 'NO_COORDINATED_PAIR', visitId: null, saleId: null,
    }, 'sale-1');
    expect(guidance.message).toContain('artık geçerli değil');
    expect(guidance.targetId).toBeNull();
  });

  it('never links a conflict raised on the sale card back to the same card', () => {
    const guidance = pairConflictGuidance({
      allowedSaleCommand: 'RESUME', reason: null, visitId: null, saleId: 'sale-1',
    }, null, 'sale-1');
    expect(guidance.message).toContain('“Satış kaydında düzeltmeye başla”');
    expect(guidance.targetId).toBeNull();
    expect(guidance.targetLabel).toBeNull();
  });

  it('suffixes a success message only when the sale actually moved', () => {
    expect(pairSuccessSuffix('SUBMIT_FOR_APPROVAL', null)).toBe('');
    expect(pairSuccessSuffix('SUBMIT_FOR_APPROVAL', 'sale-1'))
      .toBe(' Bağlı satış kaydı da onaya gönderildi.');
    expect(pairSuccessSuffix('APPROVE', 'sale-1')).toBe(' Bağlı satış kaydı da tamamlandı.');
    expect(pairSuccessSuffix('REQUEST_REVISION', 'sale-1'))
      .toBe(' Bağlı satış kaydı da düzeltme için geri gönderildi.');
    expect(pairSuccessSuffix('WITHDRAW_FROM_APPROVAL', 'sale-1'))
      .toBe(' Bağlı satış kaydı da yeniden düzenlemeye açıldı.');
    expect(pairSuccessSuffix('RESUME', 'sale-1'))
      .toBe(' Bağlı satış kaydı da yeniden düzenlemeye açıldı.');
    expect(pairSuccessSuffix('CANCEL', 'sale-1')).toBe('');
  });
});

describe('SALE-002 visit submit blockers (§4.3/§4.8)', () => {
  it('lists the sale readiness failures with their Turkish labels', () => {
    const blockers = visitSubmitPairBlockers({
      ...visitSale,
      status: 'ACCEPTED',
      readiness: {
        evaluatedAt: '2026-11-23T09:00:00.000Z', ready: false,
        items: [
          { code: 'SALE_ITEM_PRESENT', state: 'missing' },
          { code: 'CUSTOMER_ELIGIBLE', state: 'met' },
        ],
      },
    }, requirementLabels);
    expect(blockers).toEqual([{
      kind: 'NOT_READY',
      unmet: [{ code: 'SALE_ITEM_PRESENT', state: 'missing', label: 'En az bir satış ürünü' }],
    }]);
  });

  it('names the exact state step for a sale awaiting acceptance or resume', () => {
    expect(visitSubmitPairBlockers({ ...visitSale, status: 'NEW' }, requirementLabels))
      .toEqual([{ kind: 'ACCEPT_REQUIRED' }]);
    expect(visitSubmitPairBlockers({ ...visitSale, status: 'REVISION_REQUESTED' }, requirementLabels))
      .toEqual([{ kind: 'RESUME_REQUIRED' }]);
  });

  it('reports every blocker together instead of hiding one behind the other', () => {
    const blockers = visitSubmitPairBlockers({
      ...visitSale,
      status: 'NEW',
      readiness: {
        evaluatedAt: '2026-11-23T09:00:00.000Z', ready: false,
        items: [{ code: 'SALE_TIME_VALID', state: 'invalid' }],
      },
    }, requirementLabels);
    expect(blockers.map((blocker) => blocker.kind)).toEqual(['NOT_READY', 'ACCEPT_REQUIRED']);
  });
});

describe('SALE-002 pair lifecycle predicates (§4.3/§8.1)', () => {
  it('completes the sale only while it waits for approval', () => {
    expect(approvalCompletesSale({ ...visitSale, status: 'WAITING_APPROVAL' })).toBe(true);
    expect(approvalCompletesSale({ ...visitSale, status: 'IN_PROGRESS' })).toBe(false);
    expect(approvalCompletesSale({ ...visitSale, status: 'ACCEPTED' })).toBe(false);
    expect(approvalCompletesSale(null)).toBe(false);
  });

  it('moves only the sale that is in the matching state', () => {
    expect(lifecycleMovesSale({ ...visitSale, status: 'WAITING_APPROVAL' }, 'REQUEST_REVISION')).toBe(true);
    expect(lifecycleMovesSale({ ...visitSale, status: 'WAITING_APPROVAL' }, 'WITHDRAW_FROM_APPROVAL')).toBe(true);
    expect(lifecycleMovesSale({ ...visitSale, status: 'IN_PROGRESS' }, 'REQUEST_REVISION')).toBe(false);
    expect(lifecycleMovesSale({ ...visitSale, status: 'REVISION_REQUESTED' }, 'RESUME')).toBe(true);
    expect(lifecycleMovesSale({ ...visitSale, status: 'WAITING_APPROVAL' }, 'RESUME')).toBe(false);
    expect(lifecycleMovesSale(null, 'REQUEST_REVISION')).toBe(false);
  });

  it('marks a command pair-managed only when the server withholds it', () => {
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'ACCEPTED', allowedCommands: ['START', 'CANCEL'], sourceVisitAccess: 'FULL',
    })).toBe('SUBMIT_FOR_APPROVAL');
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'ACCEPTED',
      allowedCommands: ['START', 'SUBMIT_FOR_APPROVAL', 'CANCEL'], sourceVisitAccess: 'FULL',
    })).toBeNull();
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'WAITING_APPROVAL', allowedCommands: ['CANCEL'], sourceVisitAccess: 'FULL',
    })).toBe('APPROVE');
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'REVISION_REQUESTED', allowedCommands: ['CANCEL'], sourceVisitAccess: 'FULL',
    })).toBe('RESUME');
    // A standalone sale, a terminal source and a decoupled pair keep their own commands.
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'ACCEPTED', allowedCommands: ['START'], sourceVisitAccess: 'NONE',
    })).toBeNull();
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'ACCEPTED', allowedCommands: ['START'], sourceVisitAccess: 'RESTRICTED',
    })).toBeNull();
    // Acceptance is never pair-managed (only the assigned staff may accept).
    expect(pairManagedSaleCommand({
      type: 'SALE', status: 'NEW', allowedCommands: ['CANCEL'], sourceVisitAccess: 'FULL',
    })).toBeNull();
    expect(pairManagedSaleCommand({
      type: 'SALES_MEETING', status: 'ACCEPTED', allowedCommands: [], sourceVisitAccess: 'FULL',
    })).toBeNull();
  });
});
