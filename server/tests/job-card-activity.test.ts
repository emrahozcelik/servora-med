import { describe, expect, it, vi } from 'vitest';

import { presentActivity } from '../src/modules/job-cards/activity-presenter.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import type { ActivityRecord } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import {
  JOB_CARD_ACTIVITY_EVENTS,
  type JobCard,
  type JobCardActivityEvent,
  type JobCardActor,
} from '../src/modules/job-cards/types.js';

const createdAt = new Date('2026-07-13T12:00:00.000Z');
const baseRecord = (eventType: JobCardActivityEvent, values: Partial<ActivityRecord> = {}): ActivityRecord => ({
  id: `activity-${eventType}`, jobCardId: 'job-1', actorId: 'staff-1', actorName: 'Ayşe Personel',
  eventType, oldValue: { secret: 'old-secret' }, newValue: { secret: 'new-secret' },
  metadata: { note: 'çok gizli not', secret: 'metadata-secret' }, clientActionId: 'action-secret',
  createdAt, ...values,
});

const lifecycleCases = [
  ['JOB_PLANNED', 'NEW', 'PLANNED'],
  ['JOB_STARTED', 'NEW', 'IN_PROGRESS'],
  ['JOB_STARTED', 'PLANNED', 'IN_PROGRESS'],
  ['JOB_SUBMITTED_FOR_APPROVAL', 'IN_PROGRESS', 'WAITING_APPROVAL'],
  ['JOB_APPROVED', 'WAITING_APPROVAL', 'COMPLETED'],
  ['JOB_REVISION_REQUESTED', 'WAITING_APPROVAL', 'REVISION_REQUESTED'],
  ['JOB_APPROVAL_WITHDRAWN', 'WAITING_APPROVAL', 'IN_PROGRESS'],
  ['JOB_RESUMED', 'REVISION_REQUESTED', 'IN_PROGRESS'],
  ['JOB_CANCELLED', 'NEW', 'CANCELLED'],
  ['JOB_CANCELLED', 'PLANNED', 'CANCELLED'],
  ['JOB_CANCELLED', 'IN_PROGRESS', 'CANCELLED'],
  ['JOB_CANCELLED', 'REVISION_REQUESTED', 'CANCELLED'],
  ['JOB_CANCELLED', 'WAITING_APPROVAL', 'CANCELLED'],
] as const;

describe('safe JobCard activity presenter', () => {
  it('keeps the canonical activity vocabulary at exactly 16 unique events', () => {
    expect(JOB_CARD_ACTIVITY_EVENTS).toHaveLength(16);
    expect(new Set(JOB_CARD_ACTIVITY_EVENTS).size).toBe(16);
    expect(new Set(JOB_CARD_ACTIVITY_EVENTS)).toEqual(new Set([
      'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_STARTED',
      'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
      'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED',
      'DELIVERY_ITEM_ADDED', 'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED',
      'NOTE_ADDED', 'MEETING_DETAILS_UPDATED',
      'JOB_APPROVAL_WITHDRAWN',
    ]));
  });

  it('presents JOB_CREATED with NONE details and only public DTO keys', () => {
    const result = presentActivity(baseRecord('JOB_CREATED'));
    expect(result).toEqual({
      id: 'activity-JOB_CREATED', jobCardId: 'job-1', eventType: 'JOB_CREATED',
      actor: { id: 'staff-1', name: 'Ayşe Personel' }, details: { kind: 'NONE' },
      createdAt: createdAt.toISOString(),
    });
    expect(JSON.stringify(result)).not.toMatch(/oldValue|newValue|metadata|clientActionId|gizli|secret/);
  });

  it.each(lifecycleCases)('presents %s as an allowlisted status transition', (eventType, fromStatus, toStatus) => {
    const result = presentActivity(baseRecord(eventType, {
      oldValue: { status: fromStatus, version: 1, note: 'never expose' },
      newValue: { status: toStatus, version: 2, cancelReason: 'never expose' },
    }));
    expect(result.details).toEqual({ kind: 'STATUS_TRANSITION', fromStatus, toStatus });
    expect(JSON.stringify(result)).not.toContain('never expose');
  });

  it.each([
    ['JOB_PLANNED', 'PLANNED', 'PLANNED'],
    ['JOB_STARTED', 'IN_PROGRESS', 'IN_PROGRESS'],
    ['JOB_SUBMITTED_FOR_APPROVAL', 'NEW', 'WAITING_APPROVAL'],
    ['JOB_APPROVED', 'IN_PROGRESS', 'COMPLETED'],
    ['JOB_REVISION_REQUESTED', 'IN_PROGRESS', 'REVISION_REQUESTED'],
    ['JOB_RESUMED', 'NEW', 'IN_PROGRESS'],
    ['JOB_APPROVAL_WITHDRAWN', 'IN_PROGRESS', 'WAITING_APPROVAL'],
  ] as const)('falls back to NONE for semantically incompatible %s transition %s→%s', (
    eventType, fromStatus, toStatus,
  ) => {
    expect(presentActivity(baseRecord(eventType, {
      oldValue: { status: fromStatus }, newValue: { status: toStatus },
    })).details).toEqual({ kind: 'NONE' });
  });

  it.each([
    ['JOB_ASSIGNED', { assignedTo: 'assignee-old', secret: 'old' }, { assignedTo: 'assignee-new', secret: 'new' }, ['assignee']],
    ['JOB_FIELDS_UPDATED', { title: 'Eski', customerId: 'customer-1', internal: 'old' },
      { title: 'Yeni', customerId: 'customer-2', internal: 'new' }, ['title', 'customer']],
  ] as const)('presents %s with only allowlisted changed field names', (eventType, oldValue, newValue, changedFields) => {
    const result = presentActivity(baseRecord(eventType, { oldValue, newValue }));
    expect(result.details).toEqual({ kind: 'FIELDS_UPDATED', changedFields: [...changedFields] });
    expect(JSON.stringify(result)).not.toMatch(/assignee-old|assignee-new|customer-1|customer-2|internal/);
  });

  it.each([
    ['DELIVERY_ITEM_ADDED', 'ADDED', null, { itemId: 'item-1', deliveryPurpose: 'SALE', quantity: 2, productId: 'private-product' }],
    ['DELIVERY_ITEM_UPDATED', 'UPDATED', null, { itemId: 'item-2', deliveryPurpose: 'SAMPLE', quantity: 3, deliveryNote: 'private-note' }],
    ['DELIVERY_ITEM_REMOVED', 'REMOVED', { itemId: 'item-3', productId: 'private-product', quantity: 4 }, null],
  ] as const)('presents %s with allowlisted delivery details', (eventType, operation, oldValue, newValue) => {
    const result = presentActivity(baseRecord(eventType, { oldValue, newValue }));
    expect(result.details).toEqual({
      kind: 'DELIVERY_ITEM', operation, itemId: `item-${operation === 'ADDED' ? 1 : operation === 'UPDATED' ? 2 : 3}`,
      purpose: operation === 'ADDED' ? 'SALE' : operation === 'UPDATED' ? 'SAMPLE' : null,
      quantity: operation === 'ADDED' ? 2 : operation === 'UPDATED' ? 3 : 4,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-product|private-note|productId|deliveryNote/);
  });

  it('presents NOTE_ADDED from noteId metadata without note text', () => {
    const result = presentActivity(baseRecord('NOTE_ADDED', {
      metadata: { noteId: 'note-1', note: 'Hasta hakkında özel not' },
    }));
    expect(result.details).toEqual({ kind: 'NOTE', noteId: 'note-1' });
    expect(JSON.stringify(result)).not.toMatch(/Hasta|özel not|metadata/);
  });

  it('presents meeting changes in canonical field order without persisted values', () => {
    const result = presentActivity(baseRecord('MEETING_DETAILS_UPDATED', {
      oldValue: { meetingSummary: 'Eski gizli özet', outcome: 'NO_DECISION' },
      newValue: { meetingSummary: 'Yeni gizli özet', outcome: 'POSITIVE' },
      metadata: {
        changedFields: ['nextFollowUpAt', 'meetingSummary', 'outcome'],
        meetingSummary: 'Metadata gizli özet',
      },
    }));

    expect(result.details).toEqual({
      kind: 'MEETING_DETAILS',
      changedFields: ['outcome', 'meetingSummary', 'nextFollowUpAt'],
    });
    expect(JSON.stringify(result)).not.toMatch(/Eski|Yeni|Metadata|NO_DECISION|POSITIVE/);
  });

  it.each([
    ['JOB_STARTED', { status: 'UNKNOWN' }, { status: 'IN_PROGRESS' }, null],
    ['JOB_ASSIGNED', { assignedTo: 4 }, { assignedTo: 'staff-2' }, null],
    ['JOB_FIELDS_UPDATED', { internal: 'old' }, { internal: 'new' }, null],
    ['DELIVERY_ITEM_ADDED', null, { itemId: '', deliveryPurpose: 'SALE', quantity: 2 }, null],
    ['DELIVERY_ITEM_ADDED', null, { itemId: 'item-1', quantity: 2 }, null],
    ['DELIVERY_ITEM_UPDATED', null, { itemId: 'item-1', deliveryPurpose: 'INVALID', quantity: 2 }, null],
    ['DELIVERY_ITEM_UPDATED', null, { itemId: 'item-1', deliveryPurpose: 'SALE', quantity: 0 }, null],
    ['DELIVERY_ITEM_REMOVED', { itemId: 'item-1', quantity: '2' }, null, null],
    ['NOTE_ADDED', null, null, { noteId: 42, note: 'private' }],
    ['NOTE_ADDED', null, null, { noteId: '   ', note: 'private' }],
  ] as const)('falls back to NONE for malformed %s persisted details', (eventType, oldValue, newValue, metadata) => {
    expect(presentActivity(baseRecord(eventType, { oldValue, newValue, metadata })).details)
      .toEqual({ kind: 'NONE' });
  });

  it('projects a nullable actor without leaking actor persistence fields', () => {
    expect(presentActivity(baseRecord('JOB_CREATED', { actorId: null, actorName: null })).actor).toBeNull();
  });
});

describe('paginated JobCard activity repository', () => {
  it('returns total and newest-first activity rows with actor names', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 7 }] };
      return { rows: [{
        id: 'activity-1', job_card_id: 'job-1', actor_id: 'staff-1', actor_name: 'Ayşe Personel',
        event_type: 'JOB_STARTED', old_value: { status: 'PLANNED' },
        new_value: { status: 'IN_PROGRESS' }, metadata: { private: true },
        client_action_id: 'private-action', created_at: createdAt,
      }] };
    } };

    const result = await new PostgresJobCardRepository(pool as never)
      .listActivity('org-1', 'job-1', { limit: 2, offset: 3 });

    expect(result).toMatchObject({ total: 7, limit: 2, offset: 3 });
    expect(result.items[0]).toMatchObject({ actorId: 'staff-1', actorName: 'Ayşe Personel' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain('organization_id=$1 AND job_card_id=$2');
    expect(calls[0]!.values).toEqual(['org-1', 'job-1']);
    expect(calls[1]!.sql).toContain('LEFT JOIN users u');
    expect(calls[1]!.sql).toContain('u.organization_id = a.organization_id AND u.id = a.actor_id');
    expect(calls[1]!.sql).toContain('ORDER BY a.created_at DESC, a.id DESC');
    expect(calls[1]!.sql).toContain('LIMIT $3 OFFSET $4');
    expect(calls[1]!.values).toEqual(['org-1', 'job-1', 2, 3]);
  });
});

describe('JobCard activity service scope', () => {
  const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
  const ownJob: JobCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 1,
    title: 'Teslim', description: null, customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
  };

  it('projects a canonical page after enforcing Staff visibility and organization scope', async () => {
    const findJobCardDetail = vi.fn().mockResolvedValue({
      ...ownJob, assignee: { id: 'staff-1', name: 'Staff One' },
      customer: { id: 'customer-1', name: 'Demo Klinik' }, contact: null,
      lifecycle: {
        createdAt: '2026-07-13T10:00:00.000Z',
        plannedAt: null, startedAt: null, submittedAt: null, submittedBy: null,
        submissionNote: null, approvedAt: null, approvedBy: null, approvalNote: null,
        revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
        cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
      },
    });
    const listActivity = vi.fn().mockResolvedValue({
      items: [baseRecord('JOB_CREATED')], total: 1, limit: 5, offset: 2,
    });
    const service = new JobCardService({ findJobCardDetail, listActivity } as never);

    const result = await service.listActivity(staff, 'job-1', { limit: 5, offset: 2 });

    expect(findJobCardDetail).toHaveBeenCalledWith('org-1', 'job-1');
    expect(listActivity).toHaveBeenCalledWith('org-1', 'job-1', { limit: 5, offset: 2 });
    expect(result).toEqual({
      items: [expect.objectContaining({ eventType: 'JOB_CREATED', details: { kind: 'NONE' } })],
      total: 1, limit: 5, offset: 2,
    });
    expect(JSON.stringify(result)).not.toMatch(/oldValue|newValue|metadata|clientActionId|secret|gizli/);
  });

  it('hides another Staff user assignment without querying activity', async () => {
    const findJobCardDetail = vi.fn().mockResolvedValue({
      ...ownJob, assignedTo: 'staff-2', assignee: { id: 'staff-2', name: 'Staff Two' },
      customer: { id: 'customer-1', name: 'Demo Klinik' }, contact: null,
    });
    const listActivity = vi.fn();
    const service = new JobCardService({ findJobCardDetail, listActivity } as never);

    await expect(service.listActivity(staff, 'job-1', { limit: 50, offset: 0 }))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    expect(listActivity).not.toHaveBeenCalled();
  });
});
