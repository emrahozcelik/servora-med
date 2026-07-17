import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const baseRow = {
  id: 'job-1', organization_id: 'org-1', type: 'GENERAL_TASK', status: 'NEW', version: 1,
  title: 'Doktoru ara', description: null, customer_id: 'customer-1', contact_id: null,
  assigned_to: 'staff-1', created_by: 'manager-1', priority: 'normal', due_date: null,
  assignee_id: 'staff-1', assignee_name: 'Emrah Demir',
  customer_id_join: 'customer-1', customer_name: 'Demo Dental Klinik',
  contact_id_join: null, contact_name: null,
};

const lifecycleRow = {
  created_at: new Date('2026-07-17T08:00:00.000Z'),
  scheduled_at: new Date('2026-07-17T08:30:00.000Z'),
  accepted_at: new Date('2026-07-17T08:30:00.000Z'),
  accepter_id: 'staff-1', accepter_name: 'Emrah Demir',
  started_at: new Date('2026-07-17T09:00:00.000Z'),
  staff_completed_at: new Date('2026-07-17T10:00:00.000Z'),
  staff_completion_note: 'Kontrole hazır',
  submitter_id: 'staff-1', submitter_name: 'Emrah Demir',
  manager_approved_at: null, manager_approval_note: null,
  approver_id: null, approver_name: null,
  revision_requested_at: new Date('2026-07-17T10:30:00.000Z'),
  revision_reason: 'İkinci miktarı düzeltin',
  revision_actor_id: 'manager-1', revision_actor_name: 'Murat Yönetici',
  cancelled_at: null, cancel_reason: null,
  cancellation_actor_id: null, cancellation_actor_name: null,
  cancelled_from_status: null,
};

const expectedLifecycle = {
  createdAt: '2026-07-17T08:00:00.000Z',
  acceptedAt: '2026-07-17T08:30:00.000Z',
  acceptedBy: { id: 'staff-1', name: 'Emrah Demir' },
  startedAt: '2026-07-17T09:00:00.000Z',
  submittedAt: '2026-07-17T10:00:00.000Z',
  submittedBy: { id: 'staff-1', name: 'Emrah Demir' },
  submissionNote: 'Kontrole hazır',
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: '2026-07-17T10:30:00.000Z',
  revisionRequestedBy: { id: 'manager-1', name: 'Murat Yönetici' },
  revisionReason: 'İkinci miktarı düzeltin',
  cancelledAt: null, cancelledBy: null, cancelReason: null,
  cancelledFromStatus: null,
};

function repositoryDouble(row: Record<string, unknown> = { ...baseRow, ...lifecycleRow }) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    return { rows: values[0] === 'org-1' && values[1] === 'job-1' ? [row] : [] };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client };
  return { repository: new PostgresJobCardRepository(pool as never), calls };
}

describe('Postgres JobCard detail projection', () => {
  it('maps assignee, Customer/Contact, and full lifecycle facts in one organization-scoped query', async () => {
    const { repository, calls } = repositoryDouble();

    const result = await repository.findJobCardDetail('org-1', 'job-1');
    expect(result).toEqual({
      id: 'job-1', organizationId: 'org-1', type: 'GENERAL_TASK', status: 'NEW', version: 1,
      title: 'Doktoru ara', description: null, customerId: 'customer-1', contactId: null,
      assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
      scheduledAt: '2026-07-17T08:30:00.000Z',
      assignee: { id: 'staff-1', name: 'Emrah Demir' },
      customer: { id: 'customer-1', name: 'Demo Dental Klinik' },
      contact: null,
      lifecycle: expectedLifecycle,
    });
    const projection = calls.at(-1)!;
    expect(projection.values).toEqual(['org-1', 'job-1']);
    expect(projection.text).toContain('JOIN users assignee');
    expect(projection.text).toContain('LEFT JOIN customers customer');
    expect(projection.text).toContain('LEFT JOIN contacts contact');
    expect(projection.text).toContain('LEFT JOIN users accepter');
    expect(projection.text).toContain('LEFT JOIN users submitter');
    expect(projection.text).toContain('LEFT JOIN users approver');
    expect(projection.text).toContain('LEFT JOIN users revision_actor');
    expect(projection.text).toContain('LEFT JOIN users cancellation_actor');
    expect(projection.text).toContain('j.scheduled_at');
    expect(projection.text).toContain('j.accepted_at');
    expect(projection.text).toContain("event_type = 'JOB_CANCELLED'");
    expect(projection.text).toContain('a.organization_id = j.organization_id');
    expect(projection.text).toContain('WHERE j.organization_id = $1 AND j.id = $2');
    expect(projection.text).toMatch(/accepter\.organization_id = j\.organization_id/);
    expect(projection.text).toMatch(/submitter\.organization_id = j\.organization_id/);
    expect(projection.text).toMatch(/approver\.organization_id = j\.organization_id/);
    expect(projection.text).toMatch(/revision_actor\.organization_id = j\.organization_id/);
    expect(projection.text).toMatch(/cancellation_actor\.organization_id = j\.organization_id/);
  });

  it('maps a valid WAITING_APPROVAL cancellation source and drops malformed sources without leaking raw JSON', async () => {
    const cancelledBase = {
      ...baseRow,
      ...lifecycleRow,
      status: 'CANCELLED',
      cancelled_at: new Date('2026-07-17T11:00:00.000Z'),
      cancel_reason: 'Yeni randevu',
      cancellation_actor_id: 'manager-1',
      cancellation_actor_name: 'Murat Yönetici',
    };

    const valid = repositoryDouble({
      ...cancelledBase,
      cancelled_from_status: 'WAITING_APPROVAL',
    });
    await expect(valid.repository.findJobCardDetail('org-1', 'job-1')).resolves.toMatchObject({
      lifecycle: {
        cancelledAt: '2026-07-17T11:00:00.000Z',
        cancelledBy: { id: 'manager-1', name: 'Murat Yönetici' },
        cancelReason: 'Yeni randevu',
        cancelledFromStatus: 'WAITING_APPROVAL',
      },
    });

    const malformedRaw = '{"status":"IN_PROGRESS"}';
    const malformed = repositoryDouble({
      ...cancelledBase,
      cancelled_from_status: malformedRaw,
    });
    const malformedResult = await malformed.repository.findJobCardDetail('org-1', 'job-1');
    expect(malformedResult?.lifecycle.cancelledFromStatus).toBeNull();
    expect(JSON.stringify(malformedResult)).not.toContain(malformedRaw);
    expect(JSON.stringify(malformedResult)).not.toContain('"status":"IN_PROGRESS"');

    const terminal = repositoryDouble({
      ...cancelledBase,
      cancelled_from_status: 'COMPLETED',
    });
    await expect(terminal.repository.findJobCardDetail('org-1', 'job-1')).resolves.toMatchObject({
      lifecycle: { cancelledFromStatus: null },
    });
  });

  it('returns null for a cross-organization public or transaction detail read', async () => {
    const { repository } = repositoryDouble();

    await expect(repository.findJobCardDetail('org-2', 'job-1')).resolves.toBeNull();
    await expect(repository.executeTransaction((transaction) =>
      transaction.getJobDetail('org-2', 'job-1'))).resolves.toBeNull();
  });

  it('omits incomplete actor identities while keeping timestamps and reasons', async () => {
    const { repository } = repositoryDouble({
      ...baseRow,
      ...lifecycleRow,
      submitter_id: 'staff-1',
      submitter_name: null,
      revision_actor_id: null,
      revision_actor_name: 'Murat Yönetici',
    });

    await expect(repository.findJobCardDetail('org-1', 'job-1')).resolves.toMatchObject({
      lifecycle: {
        submittedAt: '2026-07-17T10:00:00.000Z',
        submittedBy: null,
        submissionNote: 'Kontrole hazır',
        revisionRequestedAt: '2026-07-17T10:30:00.000Z',
        revisionRequestedBy: null,
        revisionReason: 'İkinci miktarı düzeltin',
      },
    });
  });
});
