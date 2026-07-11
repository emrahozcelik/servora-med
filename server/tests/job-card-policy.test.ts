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

  it('enforces named transition roles and source statuses', () => {
    expect(() => assertCanTransition(staff, job, 'SUBMIT_FOR_APPROVAL')).not.toThrow();
    expect(() => assertCanTransition(staff, { ...job, status: 'WAITING_APPROVAL' }, 'APPROVE'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanTransition(manager, { ...job, status: 'WAITING_APPROVAL' }, 'APPROVE')).not.toThrow();
    expect(() => assertCanTransition(manager, job, 'APPROVE'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  it('requires a non-empty revision reason', () => {
    expect(() => assertCanTransition(manager, { ...job, status: 'WAITING_APPROVAL' }, 'REQUEST_REVISION', '  '))
      .toThrowError(expect.objectContaining({ code: 'REVISION_REASON_REQUIRED' }));
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
