import { describe, expect, it } from 'vitest';

import {
  assertAllowedJobAction,
  assertCreateAssignmentRequest,
  assertCanCreateForAssignee,
  assertCanEdit,
  assertCanTransition,
  assertDeliveryReadyForSubmission,
  assertSalesMeetingJob,
  getAllowedJobActions,
  getAllowedLifecycleCommands,
} from '../src/modules/job-cards/policy.js';
import {
  JOB_CARD_STATUSES,
  JOB_WORKFLOW_ACTIONS,
  type DeliveryItem,
  type JobCard,
  type JobCardActor,
} from '../src/modules/job-cards/types.js';

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
  it('rejects a Staff assignment request for another identifier before assignee lookup', () => {
    expect(() => assertCreateAssignmentRequest(staff, 'staff-1')).not.toThrow();
    expect(() => assertCreateAssignmentRequest(staff, 'staff-2'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
    expect(() => assertCreateAssignmentRequest(manager, 'staff-2')).not.toThrow();
    expect(() => assertCreateAssignmentRequest(admin, 'staff-2')).not.toThrow();
  });

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

  it('accepts only Sales Meeting parents for structured meeting details', () => {
    expect(() => assertSalesMeetingJob({ ...job, type: 'SALES_MEETING' })).not.toThrow();
    for (const type of ['PRODUCT_DELIVERY', 'GENERAL_TASK'] as const) {
      expect(() => assertSalesMeetingJob({ ...job, type }))
        .toThrowError(expect.objectContaining({ code: 'INVALID_JOB_TYPE', statusCode: 409 }));
    }
  });

  it('returns actor-scoped lifecycle commands without narrowing management intervention', () => {
    const waiting = { ...job, status: 'WAITING_APPROVAL' as const };
    expect(getAllowedLifecycleCommands(staff, waiting)).toEqual([
      'WITHDRAW_FROM_APPROVAL', 'CANCEL',
    ]);
    expect(getAllowedLifecycleCommands(manager, waiting)).toEqual([
      'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
    ]);
    expect(getAllowedLifecycleCommands(admin, waiting)).toEqual([
      'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
    ]);
    expect(getAllowedLifecycleCommands({ ...staff, id: 'staff-2' }, waiting)).toEqual([]);
    expect(getAllowedLifecycleCommands(admin, { ...job, status: 'COMPLETED' })).toEqual([]);
  });

  it('returns actor-scoped acceptance commands without management accept or NEW start', () => {
    const assignedNew = { ...job, status: 'NEW' as const };
    const accepted = { ...job, status: 'ACCEPTED' as const };
    expect(getAllowedLifecycleCommands(staff, assignedNew)).toContain('ACCEPT_ASSIGNMENT');
    expect(getAllowedLifecycleCommands(manager, assignedNew)).not.toContain('ACCEPT_ASSIGNMENT');
    expect(getAllowedLifecycleCommands(admin, assignedNew)).not.toContain('ACCEPT_ASSIGNMENT');
    expect(getAllowedLifecycleCommands(staff, accepted)).toContain('START');
    expect(getAllowedLifecycleCommands(staff, assignedNew)).not.toContain('START');
    expect(getAllowedLifecycleCommands({ ...staff, id: 'staff-2' }, assignedNew)).toEqual([]);
    expect(getAllowedLifecycleCommands(staff, assignedNew)).toEqual(['ACCEPT_ASSIGNMENT', 'CANCEL']);
    expect(getAllowedLifecycleCommands(manager, assignedNew)).toEqual(['CANCEL']);
    expect(getAllowedLifecycleCommands(staff, accepted)).toEqual(['START', 'CANCEL']);
  });

  it('returns neutral actions without treating waiting edits as direct mutation', () => {
    const meeting = { ...job, type: 'SALES_MEETING' as const };
    expect(getAllowedJobActions(staff, { ...meeting, status: 'IN_PROGRESS' })).toEqual([
      'EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT',
      'VIEW_NOTES', 'ADD_NOTE',
    ]);
    expect(getAllowedJobActions(manager, { ...meeting, status: 'WAITING_APPROVAL' })).toEqual([
      'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'VIEW_NOTES',
    ]);
    expect(getAllowedJobActions(staff, { ...meeting, status: 'NEW' })).toEqual([
      'EDIT_JOB_FIELDS',
    ]);
    expect(getAllowedJobActions(staff, { ...meeting, status: 'CANCELLED' })).toEqual([
      'VIEW_MEETING_RESULT', 'VIEW_NOTES',
    ]);
  });

  it('keeps action projection and write/read guards in parity', () => {
    const meeting = { ...job, type: 'SALES_MEETING' as const };
    for (const status of JOB_CARD_STATUSES) {
      const candidate = { ...meeting, status };
      for (const action of JOB_WORKFLOW_ACTIONS.filter((value) =>
        value !== 'WITHDRAW_AND_EDIT_JOB_FIELDS')) {
        const allowed = getAllowedJobActions(staff, candidate).includes(action);
        if (allowed) expect(() => assertAllowedJobAction(staff, candidate, action)).not.toThrow();
        else expect(() => assertAllowedJobAction(staff, candidate, action))
          .toThrowError(expect.objectContaining({ code: 'JOB_NOT_EDITABLE' }));
      }
    }
  });

  it.each([
    ['ACCEPT_ASSIGNMENT', 'NEW', staff],
    ['START', 'ACCEPTED', staff],
    ['START', 'ACCEPTED', manager], ['START', 'ACCEPTED', admin],
    ['SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', staff],
    ['SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', manager],
    ['SUBMIT_FOR_APPROVAL', 'IN_PROGRESS', admin],
    ['APPROVE', 'WAITING_APPROVAL', manager], ['APPROVE', 'WAITING_APPROVAL', admin],
    ['REQUEST_REVISION', 'WAITING_APPROVAL', manager, 'Düzeltin'],
    ['REQUEST_REVISION', 'WAITING_APPROVAL', admin, 'Düzeltin'],
    ['WITHDRAW_FROM_APPROVAL', 'WAITING_APPROVAL', staff],
    ['WITHDRAW_FROM_APPROVAL', 'WAITING_APPROVAL', manager],
    ['WITHDRAW_FROM_APPROVAL', 'WAITING_APPROVAL', admin],
    ['RESUME', 'REVISION_REQUESTED', staff],
    ['RESUME', 'REVISION_REQUESTED', manager], ['RESUME', 'REVISION_REQUESTED', admin],
    ['CANCEL', 'NEW', staff, 'İptal'], ['CANCEL', 'ACCEPTED', staff, 'İptal'],
    ['CANCEL', 'IN_PROGRESS', staff, 'İptal'],
    ['CANCEL', 'REVISION_REQUESTED', staff, 'İptal'],
    ['CANCEL', 'NEW', manager, 'İptal'], ['CANCEL', 'ACCEPTED', admin, 'İptal'],
    ['CANCEL', 'IN_PROGRESS', manager, 'İptal'], ['CANCEL', 'REVISION_REQUESTED', admin, 'İptal'],
    ['CANCEL', 'WAITING_APPROVAL', staff, 'İptal'],
    ['CANCEL', 'WAITING_APPROVAL', manager, 'İptal'],
    ['CANCEL', 'WAITING_APPROVAL', admin, 'İptal'],
  ] as const)('allows %s from %s for %s', (command, status, actor, reason) => {
    expect(() => assertCanTransition(actor, { ...job, status }, command, reason)).not.toThrow();
  });

  it.each([
    ['APPROVE', 'WAITING_APPROVAL'], ['REQUEST_REVISION', 'WAITING_APPROVAL'],
  ] as const)('forbids Staff %s even on an assigned %s job', (command, status) => {
    expect(() => assertCanTransition(staff, { ...job, status }, command, 'Neden'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it.each([manager, admin] as const)('forbids management acceptance by %s with FORBIDDEN', (actor) => {
    expect(() => assertCanTransition(actor, { ...job, status: 'NEW' }, 'ACCEPT_ASSIGNMENT'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
  });

  it.each([
    ['ACCEPT_ASSIGNMENT', 'ACCEPTED'], ['START', 'NEW'], ['START', 'IN_PROGRESS'],
    ['SUBMIT_FOR_APPROVAL', 'NEW'],
    ['APPROVE', 'IN_PROGRESS'], ['REQUEST_REVISION', 'REVISION_REQUESTED'],
    ['WITHDRAW_FROM_APPROVAL', 'IN_PROGRESS'], ['RESUME', 'IN_PROGRESS'],
  ] as const)('rejects %s from invalid source %s', (command, status) => {
    const actor = command === 'ACCEPT_ASSIGNMENT' || command === 'WITHDRAW_FROM_APPROVAL'
      ? staff
      : manager;
    expect(() => assertCanTransition(actor, { ...job, status }, command, 'Neden'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)('denies every command from terminal state %s', (status) => {
    for (const command of [
      'ACCEPT_ASSIGNMENT', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION',
      'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL',
    ] as const) {
      expect(() => assertCanTransition(admin, { ...job, status }, command, 'Neden'))
        .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    }
  });

  it('enforces same-organization and Staff own-assignment boundaries', () => {
    expect(() => assertCanTransition({ ...staff, id: 'staff-2' }, { ...job, status: 'ACCEPTED' }, 'START'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanTransition({ ...manager, organizationId: 'org-2' }, { ...job, status: 'ACCEPTED' }, 'START'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('allows assigned Staff and management to withdraw approval', () => {
    const waiting = { ...job, status: 'WAITING_APPROVAL' as const };
    for (const actor of [staff, manager, admin]) {
      expect(() => assertCanTransition(actor, waiting, 'WITHDRAW_FROM_APPROVAL')).not.toThrow();
    }
    expect(() => assertCanTransition({ ...staff, id: 'staff-2' }, waiting, 'WITHDRAW_FROM_APPROVAL'))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
  });

  it('allows only assigned Staff to cancel throughout the active lifecycle', () => {
    for (const status of ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
      expect(() => assertCanTransition(staff, { ...job, status }, 'CANCEL', 'Müşteri iptal etti'))
        .not.toThrow();
      expect(() => assertCanTransition({ ...staff, id: 'staff-2' }, { ...job, status }, 'CANCEL', 'Neden'))
        .toThrowError(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
    }
  });

  it.each([
    ['REQUEST_REVISION', 'WAITING_APPROVAL', 'REVISION_REASON_REQUIRED'],
    ['CANCEL', 'IN_PROGRESS', 'CANCEL_REASON_REQUIRED'],
    ['CANCEL', 'WAITING_APPROVAL', 'CANCEL_REASON_REQUIRED'],
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
