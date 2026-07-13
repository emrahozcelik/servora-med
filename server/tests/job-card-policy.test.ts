import { describe, expect, it } from 'vitest';

import {
  assertCanCreateForAssignee,
  assertCanEdit,
  assertCanTransition,
  assertDeliveryReadyForSubmission,
} from '../src/modules/job-cards/policy.js';
import type { DeliveryItem, JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const admin: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };
const job: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
  version: 2, title: 'Klinik teslimi', customerId: 'customer-1', assignedTo: 'staff-1',
};
const item: DeliveryItem = {
  productId: 'product-1', deliveryPurpose: 'SALE', deliveredAt: new Date(), quantity: 2,
};

describe('JobCard policy', () => {
  it('allows staff self-assignment and rejects assigning another user', () => {
    expect(() => assertCanCreateForAssignee(staff, { id: 'staff-1', organizationId: 'org-1', role: 'STAFF', isActive: true })).not.toThrow();
    expect(() => assertCanCreateForAssignee(staff, { id: 'staff-2', organizationId: 'org-1', role: 'STAFF', isActive: true }))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('rejects inactive, non-staff, and cross-organization assignees', () => {
    for (const assignee of [
      { id: 'staff-1', organizationId: 'org-2', role: 'STAFF' as const, isActive: true },
      { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const, isActive: false },
      { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' as const, isActive: true },
    ]) expect(() => assertCanCreateForAssignee(manager, assignee)).toThrow();
  });

  it('locks commercial edits during review and terminal states', () => {
    for (const status of ['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const) {
      expect(() => assertCanEdit(manager, { ...job, status })).toThrowError(expect.objectContaining({ code: 'JOB_NOT_EDITABLE' }));
    }
    expect(() => assertCanEdit(staff, job)).not.toThrow();
    expect(() => assertCanEdit({ ...staff, id: 'staff-2' }, job)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it.each([
    ['PLAN', 'NEW', staff], ['PLAN', 'NEW', manager], ['PLAN', 'NEW', admin],
    ['START', 'NEW', staff], ['START', 'PLANNED', staff],
    ['START', 'NEW', manager], ['START', 'PLANNED', admin],
    ['SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', staff],
    ['SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', manager],
    ['SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', admin],
    ['APPROVE', 'WAITING_APPROVAL', manager], ['APPROVE', 'WAITING_APPROVAL', admin],
    ['REQUEST_REVISION', 'WAITING_APPROVAL', manager, 'Düzeltin'],
    ['REQUEST_REVISION', 'WAITING_APPROVAL', admin, 'Düzeltin'],
    ['RESUME', 'REVISION_REQUESTED', staff],
    ['RESUME', 'REVISION_REQUESTED', manager], ['RESUME', 'REVISION_REQUESTED', admin],
    ['CANCEL', 'NEW', manager, 'İptal'], ['CANCEL', 'PLANNED', admin, 'İptal'],
    ['CANCEL', 'IN_PROGRESS', manager, 'İptal'],
    ['CANCEL', 'REVISION_REQUESTED', admin, 'İptal'],
  ] as const)('allows %s from %s for %s', (command, status, actor, reason) => {
    expect(() => assertCanTransition(actor, { ...job, status }, command, reason)).not.toThrow();
  });

  it.each([
    ['APPROVE', 'WAITING_APPROVAL'], ['REQUEST_REVISION', 'WAITING_APPROVAL'],
    ['CANCEL', 'IN_PROGRESS'],
  ] as const)('forbids Staff %s even on an assigned %s job', (command, status) => {
    expect(() => assertCanTransition(staff, { ...job, status }, command, 'Neden'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it.each([
    ['PLAN', 'PLANNED'], ['START', 'IN_PROGRESS'], ['SUBMIT_FOR_APPROVAL', 'NEW'],
    ['APPROVE', 'IN_PROGRESS'], ['REQUEST_REVISION', 'REVISION_REQUESTED'],
    ['RESUME', 'IN_PROGRESS'], ['CANCEL', 'WAITING_APPROVAL'],
  ] as const)('rejects %s from invalid source %s', (command, status) => {
    expect(() => assertCanTransition(manager, { ...job, status }, command, 'Neden'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)('denies every command from terminal state %s', (status) => {
    for (const command of [
      'PLAN', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION', 'RESUME', 'CANCEL',
    ] as const) {
      expect(() => assertCanTransition(admin, { ...job, status }, command, 'Neden'))
        .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    }
  });

  it('enforces same-organization and Staff own-assignment boundaries', () => {
    expect(() => assertCanTransition({ ...staff, id: 'staff-2' }, job, 'START'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanTransition({ ...manager, organizationId: 'org-2' }, job, 'START'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it.each([
    ['REQUEST_REVISION', 'WAITING_APPROVAL', 'REVISION_REASON_REQUIRED'],
    ['CANCEL', 'IN_PROGRESS', 'CANCEL_REASON_REQUIRED'],
  ] as const)('requires a non-empty reason for %s', (command, status, code) => {
    expect(() => assertCanTransition(manager, { ...job, status }, command, '  '))
      .toThrowError(expect.objectContaining({ code }));
  });

  it('requires customer, staff assignee, and valid delivery items before submission', () => {
    expect(() => assertDeliveryReadyForSubmission(job, [item])).not.toThrow();
    expect(() => assertDeliveryReadyForSubmission({ ...job, customerId: null }, [item])).toThrow();
    expect(() => assertDeliveryReadyForSubmission(job, [])).toThrow();
    for (const invalid of [
      { ...item, quantity: 0 }, { ...item, productId: '' },
      { ...item, deliveryPurpose: undefined }, { ...item, deliveredAt: undefined },
    ]) expect(() => assertDeliveryReadyForSubmission(job, [invalid as DeliveryItem])).toThrow();
  });
});
