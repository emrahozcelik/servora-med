import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

/**
 * D2 customer operational summary acceptance suite.
 *
 * Locks the read-only operational projection over existing JobCard data on a
 * fixed instant (no sleeps, no races): latest COMPLETED interaction by
 * manager_approved_at, next future-scheduled active work, split
 * approval/revision attention counts, latest COMPLETED meeting outcome with a
 * non-null outcome, and a visibility-safe follow-up navigation target.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const now = new Date('2026-08-04T10:00:00.000Z');

const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const managerId = randomUUID();
const staffAId = randomUUID();
const staffBId = randomUUID();
const otherManagerId = randomUUID();
const customerId = randomUUID();
const emptyCustomerId = randomUUID();
const fallbackCustomerId = randomUUID();
const foreignCustomerId = randomUUID();

const job1Id = randomUUID();
const tieA = randomUUID();
const tieB = randomUUID();
const [job2Id, job2bId] = tieA < tieB ? [tieA, tieB] : [tieB, tieA];
const cancelledId = randomUUID();
const invalidatedId = randomUUID();
const futureNewId = randomUUID();
const pastAcceptedId = randomUUID();
const waitingId = randomUUID();
const revisionId = randomUUID();
const meeting1Id = randomUUID();
const meeting2Id = randomUUID();
const meeting3Id = randomUUID();
const followUp1Id = randomUUID();
const followUp2Id = randomUUID();
const hiddenCompletedId = randomUUID();
const hiddenFollowUpId = randomUUID();
const fallbackSourceId = randomUUID();
const fallbackChildId = randomUUID();

const manager = { id: managerId, organizationId, role: 'MANAGER' as const };
const staffA = { id: staffAId, organizationId, role: 'STAFF' as const };
const staffB = { id: staffBId, organizationId, role: 'STAFF' as const };
const foreignManager = { id: otherManagerId, organizationId: otherOrganizationId, role: 'MANAGER' as const };

async function insertJob(
  pool: Pool,
  row: {
    id: string; type: string; status: string; title: string; assignee: string;
    customer?: string | null; scheduledAt?: string | null; createdAt?: string;
    extra?: string; extraValues?: unknown[];
  },
) {
  await pool.query(
    `INSERT INTO job_cards
      (organization_id, id, type, status, title, assigned_to, created_by,
       customer_id, scheduled_at, created_at, updated_at${row.extra ? `, ${row.extra}` : ''})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10${(row.extraValues ?? []).map((_, index) => `, $${11 + index}`).join('')})`,
    [organizationId, row.id, row.type, row.status, row.title, row.assignee, managerId,
      row.customer === undefined ? customerId : row.customer,
      row.scheduledAt ?? null, row.createdAt ?? '2026-08-01T00:00:00.000Z',
      ...(row.extraValues ?? [])],
  );
}

async function insertMeeting(pool: Pool, jobCardId: string, fields: Record<string, string | null>) {
  await pool.query(
    'INSERT INTO job_card_meeting_details (organization_id, job_card_id) VALUES ($1, $2)',
    [organizationId, jobCardId],
  );
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([column], index) => `${column} = $${index + 3}`).join(', ');
  await pool.query(
    `UPDATE job_card_meeting_details SET ${sets} WHERE organization_id = $1 AND job_card_id = $2`,
    [organizationId, jobCardId, ...entries.map(([, value]) => value)],
  );
}

describe.skipIf(!databaseUrl)('D2 customer operational summary', () => {
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const jobs = pool ? new PostgresJobCardRepository(pool) : null;
  const crm = pool && jobs ? new CrmService(new PostgresCrmRepository(pool), jobs) : null;

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO organizations (id, name, timezone)
       VALUES ($1, 'D2 Summary', 'Europe/Istanbul'), ($2, 'D2 Foreign', 'Europe/Istanbul')`,
      [organizationId, otherOrganizationId],
    );
    await pool!.query(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role)
       VALUES ($1, $4, 'D2 Manager', $5, 'hash', 'MANAGER'),
              ($2, $4, 'D2 Staff A', $6, 'hash', 'STAFF'),
              ($3, $4, 'D2 Staff B', $7, 'hash', 'STAFF'),
              ($8, $9, 'D2 Foreign', $10, 'hash', 'MANAGER')`,
      [managerId, staffAId, staffBId, organizationId,
        `${managerId}@d2.test`, `${staffAId}@d2.test`, `${staffBId}@d2.test`,
        otherManagerId, otherOrganizationId, `${otherManagerId}@d2.test`],
    );
    await pool!.query(
      `INSERT INTO customers (id, organization_id, name, customer_type, status)
       VALUES ($1, $4, 'D2 Klinik', 'clinic', 'active'),
              ($2, $4, 'D2 Bos', 'clinic', 'active'),
              ($3, $4, 'D2 Kaynak', 'clinic', 'active'),
              ($5, $6, 'D2 Yabanci', 'clinic', 'active')`,
      [customerId, emptyCustomerId, fallbackCustomerId, organizationId, foreignCustomerId, otherOrganizationId],
    );
    await insertJob(pool!, { id: job1Id, type: 'PRODUCT_DELIVERY', status: 'COMPLETED', title: 'Teslimat 1',
      assignee: staffAId, extra: 'staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['2026-08-01T08:00:00.000Z', staffAId, '2026-08-01T09:00:00.000Z', managerId, '2026-08-01T07:00:00.000Z'] });
    await insertJob(pool!, { id: job2Id, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'Gorev 2',
      assignee: staffAId, scheduledAt: '2026-08-02T09:00:00.000Z',
      extra: 'staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['2026-08-03T08:00:00.000Z', staffAId, '2026-08-03T09:00:00.000Z', managerId, '2026-08-02T08:00:00.000Z'] });
    await insertJob(pool!, { id: job2bId, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'Gorev 2B',
      assignee: staffAId,
      extra: 'staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['2026-08-03T08:30:00.000Z', staffAId, '2026-08-03T09:00:00.000Z', managerId, '2026-08-02T08:00:00.000Z'] });
    await insertJob(pool!, { id: cancelledId, type: 'GENERAL_TASK', status: 'CANCELLED', title: 'Iptal',
      assignee: staffAId, extra: 'cancelled_at, cancelled_by, cancel_reason',
      extraValues: ['2026-08-03T12:00:00.000Z', managerId, 'Musteri vazgecti'] });
    await insertJob(pool!, { id: invalidatedId, type: 'GENERAL_TASK', status: 'INVALIDATED', title: 'Gecersiz',
      assignee: staffAId, extra: 'invalidated_at, invalidated_by, invalidation_reason_code',
      extraValues: ['2026-08-03T16:00:00.000Z', managerId, 'OTHER'] });
    await insertJob(pool!, { id: futureNewId, type: 'GENERAL_TASK', status: 'NEW', title: 'Gelecek Yeni',
      assignee: staffAId, scheduledAt: '2026-08-06T09:00:00.000Z' });
    await insertJob(pool!, { id: pastAcceptedId, type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', title: 'Gecmis Kabul',
      assignee: staffAId, scheduledAt: '2026-08-03T09:00:00.000Z',
      extra: 'accepted_at, accepted_by, started_at',
      extraValues: ['2026-08-02T09:00:00.000Z', staffAId, '2026-08-02T10:00:00.000Z'] });
    await insertJob(pool!, { id: waitingId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', title: 'Onay Bekleyen',
      assignee: staffAId, scheduledAt: '2026-08-04T11:00:00.000Z',
      extra: 'staff_completed_at, staff_completed_by, started_at',
      extraValues: ['2026-08-04T09:00:00.000Z', staffAId, '2026-08-03T09:00:00.000Z'] });
    await insertJob(pool!, { id: revisionId, type: 'GENERAL_TASK', status: 'REVISION_REQUESTED', title: 'Revizyonlu Is',
      assignee: staffAId, scheduledAt: '2026-08-05T09:00:00.000Z',
      extra: 'staff_completed_at, staff_completed_by, started_at, revision_requested_at, revision_requested_by, revision_reason',
      extraValues: ['2026-08-04T08:00:00.000Z', staffAId, '2026-08-03T09:00:00.000Z',
        '2026-08-04T08:30:00.000Z', managerId, 'Eksik bilgi'] });
    await insertJob(pool!, { id: meeting1Id, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Gorusme 1',
      assignee: staffAId,
      extra: 'engagement_kind, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['SALES_MEETING', '2026-08-02T09:00:00.000Z', staffAId, '2026-08-02T10:00:00.000Z', managerId, '2026-08-02T08:00:00.000Z'] });
    await insertMeeting(pool!, meeting1Id, { meeting_at: '2026-08-02T10:00:00.000Z', outcome: 'POSITIVE',
      meeting_summary: 'Olumlu gecti', unsuccessful_reason_code: null, next_follow_up_at: null });
    await insertJob(pool!, { id: meeting2Id, type: 'SALES_MEETING', status: 'COMPLETED', title: 'Gorusme 2',
      assignee: staffAId,
      extra: 'engagement_kind, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['SALES_MEETING', '2026-08-02T10:30:00.000Z', staffAId, '2026-08-02T11:00:00.000Z', managerId, '2026-08-02T09:00:00.000Z'] });
    await insertMeeting(pool!, meeting2Id, {});
    await insertJob(pool!, { id: meeting3Id, type: 'SALES_MEETING', status: 'IN_PROGRESS', title: 'Gorusme 3',
      assignee: staffAId, scheduledAt: '2026-08-03T08:00:00.000Z',
      extra: 'engagement_kind, started_at', extraValues: ['SALES_MEETING', '2026-08-03T08:00:00.000Z'] });
    await insertMeeting(pool!, meeting3Id, { meeting_at: '2026-08-03T08:00:00.000Z', outcome: 'NO_DECISION' });
    await insertJob(pool!, { id: followUp1Id, type: 'GENERAL_TASK', status: 'NEW', title: 'Takip 1',
      assignee: staffAId, createdAt: '2026-08-03T10:00:00.000Z',
      extra: 'source_job_card_id, follow_up_instructions', extraValues: [job2Id, 'Takip 1'] });
    await insertJob(pool!, { id: followUp2Id, type: 'GENERAL_TASK', status: 'NEW', title: 'Takip 2',
      assignee: staffAId, createdAt: '2026-08-03T11:00:00.000Z',
      extra: 'source_job_card_id, follow_up_instructions', extraValues: [job1Id, 'Takip 2'] });
    await insertJob(pool!, { id: hiddenCompletedId, type: 'PRODUCT_DELIVERY', status: 'COMPLETED', title: 'Gizli Teslimat',
      assignee: staffBId,
      extra: 'staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['2026-08-03T14:00:00.000Z', staffBId, '2026-08-03T15:00:00.000Z', managerId, '2026-08-03T08:00:00.000Z'] });
    await insertJob(pool!, { id: hiddenFollowUpId, type: 'GENERAL_TASK', status: 'NEW', title: 'Gizli Takip',
      assignee: staffBId, createdAt: '2026-08-03T16:00:00.000Z',
      extra: 'source_job_card_id, follow_up_instructions', extraValues: [hiddenCompletedId, 'Gizli takip'] });
    await insertJob(pool!, { id: fallbackSourceId, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'Kaynak Is',
      assignee: staffAId, customer: fallbackCustomerId,
      extra: 'staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by, started_at',
      extraValues: ['2026-08-02T08:00:00.000Z', staffAId, '2026-08-02T09:00:00.000Z', managerId, '2026-08-02T07:00:00.000Z'] });
    await insertJob(pool!, { id: fallbackChildId, type: 'GENERAL_TASK', status: 'NEW', title: 'Harici Takip',
      assignee: staffBId, customer: null, createdAt: '2026-08-02T10:00:00.000Z',
      extra: 'source_job_card_id, follow_up_instructions', extraValues: [fallbackSourceId, 'Harici takip'] });
  });

  it('D2-A returns the empty summary shape for a customer without visible jobs', async () => {
    await expect(crm!.getCustomerOperationalSummary(manager, emptyCustomerId, now)).resolves.toEqual({
      latestInteraction: null,
      nextPlannedWork: null,
      pendingReview: { waitingApprovalCount: 0, revisionRequestedCount: 0 },
      latestMeetingOutcome: null,
      followUp: null,
    });
  });

  it('D2-B/D2-C/D2-P selects the latest COMPLETED job deterministically', async () => {
    const summary = await crm!.getCustomerOperationalSummary(staffA, customerId, now);
    expect(summary.latestInteraction).toMatchObject({
      jobCardId: job2bId, title: 'Gorev 2B', type: 'GENERAL_TASK',
      completedAt: '2026-08-03T09:00:00.000Z', assignee: { id: staffAId },
    });
  });

  it('D2-D/D2-F/D2-G selects the earliest eligible future work', async () => {
    const summary = await crm!.getCustomerOperationalSummary(manager, customerId, now);
    expect(summary.nextPlannedWork).toMatchObject({
      jobCardId: revisionId, status: 'REVISION_REQUESTED',
      scheduledAt: '2026-08-05T09:00:00.000Z',
    });
  });

  it('D2-E/D2-F reports split approval and revision attention counts', async () => {
    const summary = await crm!.getCustomerOperationalSummary(manager, customerId, now);
    expect(summary.pendingReview).toEqual({ waitingApprovalCount: 1, revisionRequestedCount: 1 });
  });

  it('D2-H/D2-I/D2-J surfaces only the completed non-null meeting outcome', async () => {
    const summary = await crm!.getCustomerOperationalSummary(manager, customerId, now);
    expect(summary.latestMeetingOutcome).toMatchObject({
      jobCardId: meeting1Id, outcome: 'POSITIVE',
      meetingAt: '2026-08-02T10:00:00.000Z', meetingSummary: 'Olumlu gecti',
      unsuccessfulReason: null, nextFollowUpAt: null,
    });
  });

  it('D2-K links the latest visible follow-up child', async () => {
    const summary = await crm!.getCustomerOperationalSummary(staffA, customerId, now);
    expect(summary.followUp).toEqual({ jobCardId: followUp2Id, kind: 'FOLLOW_UP_JOB' });
  });

  it('D2-N sees the broader organization projection as MANAGER', async () => {
    const summary = await crm!.getCustomerOperationalSummary(manager, customerId, now);
    expect(summary.latestInteraction?.jobCardId).toBe(hiddenCompletedId);
    expect(summary.followUp).toEqual({ jobCardId: hiddenFollowUpId, kind: 'FOLLOW_UP_JOB' });
  });

  it('D2-L/D2-M derives the STAFF summary only from assigned jobs', async () => {
    const summary = await crm!.getCustomerOperationalSummary(staffB, customerId, now);
    expect(summary.latestInteraction?.jobCardId).toBe(hiddenCompletedId);
    expect(summary.nextPlannedWork).toBeNull();
    expect(summary.pendingReview).toEqual({ waitingApprovalCount: 0, revisionRequestedCount: 0 });
    expect(summary.latestMeetingOutcome).toBeNull();
    expect(summary.followUp).toEqual({ jobCardId: hiddenFollowUpId, kind: 'FOLLOW_UP_JOB' });
  });

  it('D2-M hides child existence from STAFF without a visible child', async () => {
    const summary = await crm!.getCustomerOperationalSummary(staffA, fallbackCustomerId, now);
    expect(summary.latestInteraction?.jobCardId).toBe(fallbackSourceId);
    expect(summary.followUp).toBeNull();
  });

  it('falls back to the visible source job for MANAGER when no child is visible', async () => {
    const summary = await crm!.getCustomerOperationalSummary(manager, fallbackCustomerId, now);
    expect(summary.followUp).toEqual({ jobCardId: fallbackSourceId, kind: 'SOURCE_JOB' });
  });

  it('D2-O keeps the cross-organization isolation contract', async () => {
    await expect(crm!.getCustomerOperationalSummary(manager, foreignCustomerId, now))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    await expect(crm!.getCustomerOperationalSummary(foreignManager, customerId, now))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('issues exactly one JobCard query per summary read', async () => {
    const direct = new PostgresJobCardRepository(pool!);
    const spy = vi.spyOn(pool!, 'query');
    const before = spy.mock.calls.length;
    await direct.getCustomerOperationalSummary({ organizationId, customerId, actor: manager, now });
    const summaryQueries = spy.mock.calls.slice(before);
    expect(summaryQueries.length).toBe(1);
    expect(String(summaryQueries[0][0])).toContain('WITH visible AS');
    spy.mockRestore();
  });

  it('forwards a frozen instant and keeps the not-found contract at the service boundary', async () => {
    const port = { getCustomerOperationalSummary: vi.fn().mockResolvedValue('summary') };
    const repository = { getCustomerDetail: vi.fn().mockResolvedValue({ id: customerId }) };
    const service = new CrmService(repository as never, port as never);
    await expect(service.getCustomerOperationalSummary(manager, customerId, now)).resolves.toBe('summary');
    expect(port.getCustomerOperationalSummary).toHaveBeenCalledWith(
      { organizationId, customerId, actor: manager, now });
    repository.getCustomerDetail.mockResolvedValueOnce(null);
    await expect(service.getCustomerOperationalSummary(manager, customerId, now))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    const withoutPort = new CrmService(repository as never);
    await expect(withoutPort.getCustomerOperationalSummary(manager, customerId, now))
      .rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
  });
});
