import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { meetingDetailsUpdateRequestHash } from '../src/modules/job-cards/critical-action-request-hash.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import type { CrmActor } from '../src/modules/crm/types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `meeting_met_contact_${randomUUID().replaceAll('-', '')}`;
const adminPool = url ? new Pool({ connectionString: url }) : null;
const pool = url
  ? new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
  : null;

beforeAll(async () => {
  if (!pool || !adminPool) return;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({
    migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    store: new PostgresMigrationStore(pool),
  });
});

afterAll(async () => {
  await pool?.end();
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  }
});

const requestTime = new Date('2026-07-15T12:00:00.000Z');
const SCHEDULED_AT = '2026-07-15T07:30:00.000Z';

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const organizationId = randomUUID();
  const managerId = randomUUID();
  const adminId = randomUUID();
  const staffId = randomUUID();
  const otherStaffId = randomUUID();
  await pool!.query(`INSERT INTO organizations (id, name, timezone) VALUES ($1, 'Slice 3 org', 'Europe/Istanbul')`, [
    organizationId,
  ]);
  await pool!.query(
    `INSERT INTO users (id, organization_id, name, email, password_hash, role)
     VALUES ($1, $5, 'Manager', $6, 'synthetic', 'MANAGER'),
            ($2, $5, 'Admin', $7, 'synthetic', 'ADMIN'),
            ($3, $5, 'Staff', $8, 'synthetic', 'STAFF'),
            ($4, $5, 'Other staff', $9, 'synthetic', 'STAFF')`,
    [managerId, adminId, staffId, otherStaffId, organizationId,
      `${managerId}@test.local`, `${adminId}@test.local`, `${staffId}@test.local`,
      `${otherStaffId}@test.local`],
  );
  await pool!.query(
    `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
     VALUES ($1, $2, $4), ($1, $3, $4)`,
    [organizationId, staffId, otherStaffId, managerId],
  );
  const customerId = (await pool!.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'Klinik A', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
  const otherCustomerId = (await pool!.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'Klinik B', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
  const contactId = (await pool!.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, title, phone, is_primary)
     VALUES ($1, $2, 'Dr. Deniz', 'Başhekim', '0532 111 22 33', TRUE) RETURNING id`,
    [organizationId, customerId],
  )).rows[0]!.id;
  const secondContactId = (await pool!.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
     VALUES ($1, $2, 'Sekreter Ece', FALSE) RETURNING id`,
    [organizationId, customerId],
  )).rows[0]!.id;
  const inactiveContactId = (await pool!.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, is_active, is_primary)
     VALUES ($1, $2, 'Eski kişi', FALSE, FALSE) RETURNING id`,
    [organizationId, customerId],
  )).rows[0]!.id;
  const otherCustomerContactId = (await pool!.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
     VALUES ($1, $2, 'Diğer müşteri kişisi', TRUE) RETURNING id`,
    [organizationId, otherCustomerId],
  )).rows[0]!.id;

  const repository = new PostgresJobCardRepository(pool!);
  const service = new JobCardService(repository, () => requestTime);
  const crmService = new CrmService(new PostgresCrmRepository(pool!));
  const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
  const otherStaff: JobCardActor = { id: otherStaffId, organizationId, role: 'STAFF' };
  const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
  const admin: JobCardActor = { id: adminId, organizationId, role: 'ADMIN' };
  const crmManager: CrmActor = { id: managerId, organizationId, role: 'MANAGER' };
  const crmAdmin: CrmActor = { id: adminId, organizationId, role: 'ADMIN' };

  let scheduleCursor = 0;
  async function startedMeeting(
    targetCustomerId = customerId,
    actor: JobCardActor = staff,
    plannedContactId: string | null = targetCustomerId === customerId ? contactId : null,
  ) {
    // Back-to-back planned intervals keep the customer-visit duplicate policy
    // from rejecting the fixture itself; all starts stay before requestTime.
    const offsetMinutes = scheduleCursor * 60;
    scheduleCursor += 1;
    const scheduledAt = new Date(Date.parse(SCHEDULED_AT) + offsetMinutes * 60_000).toISOString();
    const scheduledEndsAt = new Date(Date.parse(scheduledAt) + 60 * 60_000).toISOString();
    let job = await service.create(actor, {
      clientActionId: `create-${randomUUID()}`,
      type: 'SALES_MEETING',
      title: 'İmplant değerlendirme görüşmesi',
      description: null,
      customerId: targetCustomerId,
      contactId: plannedContactId,
      assignedTo: staffId,
      priority: 'normal',
      dueDate: '2026-07-15',
      scheduledAt,
      scheduledEndsAt,
      engagementKind: 'SALES_MEETING',
    });
    job = await service.start(actor, job.id, {
      clientActionId: `start-${randomUUID()}`,
      expectedVersion: job.version,
    });
    return job;
  }

  async function readyResult(jobId: string, version: number, metContactId?: string | null) {
    return service.patchMeetingDetails(staff, jobId, {
      clientActionId: `result-${randomUUID()}`,
      expectedVersion: version,
      meetingAt: '2026-07-15T11:00:00.000Z',
      outcome: 'POSITIVE',
      meetingSummary: 'Görüşme olumlu geçti.',
      ...(metContactId === undefined ? {} : { metContactId }),
    }, { includeMetContactCapability: true });
  }

  const state = async (jobId: string) => {
    const job = (await pool!.query<{ version: number; status: string; assigned_to: string }>(
      'SELECT version, status, assigned_to FROM job_cards WHERE id = $1', [jobId],
    )).rows[0]!;
    const meeting = (await pool!.query<{ met_contact_id: string | null; meeting_summary: string | null }>(
      'SELECT met_contact_id, meeting_summary FROM job_card_meeting_details WHERE job_card_id = $1',
      [jobId],
    )).rows[0]!;
    const activities = (await pool!.query<{ event_type: string; metadata: Record<string, unknown> }>(
      `SELECT event_type, metadata FROM job_card_activity_logs
        WHERE job_card_id = $1 AND event_type = 'MEETING_DETAILS_UPDATED'
        ORDER BY created_at, id`, [jobId],
    )).rows;
    return { job, meeting, activities };
  };

  return {
    organizationId, managerId, adminId, staffId, otherStaffId,
    customerId, otherCustomerId, contactId, secondContactId, inactiveContactId,
    otherCustomerContactId, repository, service, crmService,
    staff, otherStaff, manager, admin, crmManager, crmAdmin,
    startedMeeting, readyResult, state,
  };
}

describe.skipIf(!url)('Slice 3 görüşülen kişi — PostgreSQL contract', () => {  it('assigns an existing active contact with audit, version bump and identity', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const result = await f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-assign', expectedVersion: job.version, metContactId: f.contactId,
    }, { includeMetContactCapability: true });
    expect(result.metContactId).toBe(f.contactId);
    expect(result.metContact).toEqual({ id: f.contactId, name: 'Dr. Deniz', title: 'Başhekim' });
    expect(result.jobCardVersion).toBe(job.version + 1);
    const after = await f.state(job.id);
    expect(after.meeting.met_contact_id).toBe(f.contactId);
    expect(after.activities).toHaveLength(1);
    expect(after.activities[0]!.metadata.changedFields).toEqual(['metContactId']);
    const read = await f.service.getMeetingDetails(f.staff, job.id, { includeMetContactCapability: true });
    expect(read.metContactId).toBe(f.contactId);
    expect(read.metContact).toEqual({ id: f.contactId, name: 'Dr. Deniz', title: 'Başhekim' });
  });

  it('rejects a contact of another customer without mutating the row', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const before = await f.state(job.id);
    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-foreign-customer', expectedVersion: job.version,
      metContactId: f.otherCustomerContactId,
    })).rejects.toMatchObject({
      code: 'CONTACT_NOT_IN_CUSTOMER', statusCode: 409,
      message: 'İlgili kişi seçilen müşteriye bağlı değil.',
    });
    expect(await f.state(job.id)).toEqual(before);
  });

  it('conceals a cross-organization contact as not found', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const otherOrgId = randomUUID();
    await pool!.query(`INSERT INTO organizations (id, name, timezone) VALUES ($1, 'Other org', 'Europe/Istanbul')`, [otherOrgId]);
    const foreignCustomerId = (await pool!.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Yabancı klinik', 'clinic', 'active') RETURNING id`,
      [otherOrgId],
    )).rows[0]!.id;
    const foreignContactId = (await pool!.query<{ id: string }>(
      `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
       VALUES ($1, $2, 'Yabancı kişi', TRUE) RETURNING id`,
      [otherOrgId, foreignCustomerId],
    )).rows[0]!.id;
    const before = await f.state(job.id);
    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-cross-org', expectedVersion: job.version, metContactId: foreignContactId,
    })).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND', statusCode: 404 });
    expect(await f.state(job.id)).toEqual(before);
  });

  it('rejects an inactive contact without mutating the row', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const before = await f.state(job.id);
    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-inactive', expectedVersion: job.version,
      metContactId: f.inactiveContactId,
    })).rejects.toMatchObject({
      code: 'CONTACT_INACTIVE', statusCode: 409,
      message: 'Pasif ilgili kişi iş kartında kullanılamaz.',
    });
    expect(await f.state(job.id)).toEqual(before);
  });

  it('conceals unassigned and reassigned staff without mutating the row', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const before = await f.state(job.id);
    await expect(f.service.patchMeetingDetails(f.otherStaff, job.id, {
      clientActionId: 'met-other-staff', expectedVersion: job.version, metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    expect(await f.state(job.id)).toEqual(before);
    await pool!.query('UPDATE job_cards SET assigned_to = $2 WHERE id = $1', [job.id, f.otherStaffId]);
    const reassigned = await f.state(job.id);
    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-reassigned', expectedVersion: job.version, metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    expect(await f.state(job.id)).toEqual(reassigned);
  });

  it('keeps closed and invalidated job cards uneditable', async () => {
    const f = await fixture();
    const waiting = await f.startedMeeting();
    let details = await f.readyResult(waiting.id, waiting.version);
    await f.service.submitForApproval(f.staff, waiting.id, {
      clientActionId: 'met-submit', expectedVersion: details.jobCardVersion,
      note: 'Görüşme tamamlandı.',
    });
    const waitingBefore = await f.state(waiting.id);
    await expect(f.service.patchMeetingDetails(f.staff, waiting.id, {
      clientActionId: 'met-waiting', expectedVersion: waitingBefore.job.version,
      metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    expect(await f.state(waiting.id)).toEqual(waitingBefore);

    const completed = await f.startedMeeting();
    details = await f.readyResult(completed.id, completed.version);
    await f.service.submitForApproval(f.staff, completed.id, {
      clientActionId: 'met-submit-2', expectedVersion: details.jobCardVersion,
      note: 'Görüşme tamamlandı.',
    });
    await f.service.approve(f.manager, completed.id, {
      clientActionId: 'met-approve', expectedVersion: details.jobCardVersion + 1,
    });
    const completedBefore = await f.state(completed.id);
    await expect(f.service.patchMeetingDetails(f.staff, completed.id, {
      clientActionId: 'met-completed', expectedVersion: completedBefore.job.version,
      metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    expect(await f.state(completed.id)).toEqual(completedBefore);

    const cancelled = await f.startedMeeting();
    await f.service.cancel(f.staff, cancelled.id, {
      clientActionId: 'met-cancel', expectedVersion: cancelled.version,
      cancelReason: 'Müşteri iptal etti.',
    });
    const cancelledBefore = await f.state(cancelled.id);
    await expect(f.service.patchMeetingDetails(f.staff, cancelled.id, {
      clientActionId: 'met-cancelled', expectedVersion: cancelledBefore.job.version,
      metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    expect(await f.state(cancelled.id)).toEqual(cancelledBefore);

    const invalidated = await f.startedMeeting();
    await f.service.invalidate(f.admin, invalidated.id, {
      clientActionId: 'met-invalidate', expectedVersion: invalidated.version,
      reasonCode: 'OTHER', note: 'Sentetik geçersiz kılma',
    });
    const invalidatedBefore = await f.state(invalidated.id);
    await expect(f.service.patchMeetingDetails(f.staff, invalidated.id, {
      clientActionId: 'met-invalidated', expectedVersion: invalidatedBefore.job.version,
      metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE', statusCode: 409 });
    expect(await f.state(invalidated.id)).toEqual(invalidatedBefore);
  });

  it('rejects a stale expectedVersion and lets exactly one concurrent writer win', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const before = await f.state(job.id);
    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-stale', expectedVersion: job.version - 1, metContactId: f.contactId,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(await f.state(job.id)).toEqual(before);

    const concurrent = await Promise.allSettled([
      f.service.patchMeetingDetails(f.staff, job.id, {
        clientActionId: 'met-race-a', expectedVersion: job.version, metContactId: f.contactId,
      }, { includeMetContactCapability: true }),
      f.service.patchMeetingDetails(f.staff, job.id, {
        clientActionId: 'met-race-b', expectedVersion: job.version, metContactId: f.secondContactId,
      }, { includeMetContactCapability: true }),
    ]);
    expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = concurrent.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ metContactId: string | null }>;
    const after = await f.state(job.id);
    expect(after.meeting.met_contact_id).toBe(winner.value.metContactId);
    expect(after.activities).toHaveLength(1);
    expect(after.job.version).toBe(job.version + 1);
  });

  it('replays identical requests once and rejects action reuse with different content', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const payload = {
      clientActionId: 'met-idempotent', expectedVersion: job.version, metContactId: f.contactId,
    };
    const first = await f.service.patchMeetingDetails(
      f.staff, job.id, payload, { includeMetContactCapability: true },
    );
    const replay = await f.service.patchMeetingDetails(
      f.staff, job.id, payload, { includeMetContactCapability: true },
    );
    expect(replay).toEqual(first);
    const afterReplay = await f.state(job.id);
    expect(afterReplay.activities).toHaveLength(1);
    expect(afterReplay.job.version).toBe(job.version + 1);
    expect(afterReplay.meeting.met_contact_id).toBe(f.contactId);

    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-idempotent', expectedVersion: job.version, metContactId: f.secondContactId,
    })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });

    const duplicate = await Promise.allSettled([
      f.service.patchMeetingDetails(f.staff, job.id, {
        clientActionId: 'met-in-flight', expectedVersion: afterReplay.job.version,
        meetingSummary: 'Aynı anda iki istek.',
      }),
      f.service.patchMeetingDetails(f.staff, job.id, {
        clientActionId: 'met-in-flight', expectedVersion: afterReplay.job.version,
        meetingSummary: 'Aynı anda iki istek.',
      }),
    ]);
    const fulfilled = duplicate.filter((r) => r.status === 'fulfilled');
    const rejected = duplicate.filter((r) => r.status === 'rejected');
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const entry of rejected) {
      expect((entry as PromiseRejectedResult).reason).toMatchObject({
        code: 'ACTION_IN_PROGRESS', statusCode: 409,
      });
    }
    const finalState = await f.state(job.id);
    expect(finalState.activities).toHaveLength(2);
  });

  it('clears the met contact explicitly and audits the change', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const assigned = await f.readyResult(job.id, job.version, f.contactId);
    expect(assigned.metContactId).toBe(f.contactId);
    const cleared = await f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-clear', expectedVersion: assigned.jobCardVersion, metContactId: null,
    }, { includeMetContactCapability: true });
    expect(cleared.metContactId).toBeNull();
    expect(cleared.metContact).toBeNull();
    const after = await f.state(job.id);
    expect(after.meeting.met_contact_id).toBeNull();
    expect(after.activities).toHaveLength(2);
    expect(after.activities[1]!.metadata.changedFields).toEqual(['metContactId']);
  });

  it('submits for approval without a met contact or active contacts (no new gate)', async () => {
    const f = await fixture();
    const job = await f.startedMeeting(f.otherCustomerId);
    const details = await f.readyResult(job.id, job.version);
    expect(details.metContactId).toBeNull();
    const submitted = await f.service.submitForApproval(f.staff, job.id, {
      clientActionId: 'met-submit-no-gate', expectedVersion: details.jobCardVersion,
      note: 'Kişi kaydı olmadan gönderim.',
    });
    expect(submitted.status).toBe('WAITING_APPROVAL');
    const after = await f.state(job.id);
    expect(after.meeting.met_contact_id).toBeNull();
  });

  it('lets a manager patch the met contact on an eligible meeting', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const result = await f.service.patchMeetingDetails(f.manager, job.id, {
      clientActionId: 'met-manager', expectedVersion: job.version, metContactId: f.secondContactId,
    }, { includeMetContactCapability: true });
    expect(result.metContact).toEqual({ id: f.secondContactId, name: 'Sekreter Ece', title: null });
    const after = await f.state(job.id);
    expect(after.meeting.met_contact_id).toBe(f.secondContactId);
  });

  it('blocks permanent delete of a referenced met contact and allows deactivation with history', async () => {
    const f = await fixture();
    // The planned contact stays empty so deactivation is not blocked by the
    // existing active-job guard on job_cards.contact_id; the met reference is
    // the only link under test.
    const job = await f.startedMeeting(f.customerId, f.staff, null);
    await f.readyResult(job.id, job.version, f.contactId);
    const contact = (await pool!.query<{ version: number }>(
      'SELECT version FROM contacts WHERE id = $1', [f.contactId],
    )).rows[0]!;
    await expect(f.crmService.deleteContact(
      f.crmAdmin, f.customerId, f.contactId, contact.version,
    )).rejects.toMatchObject({
      code: 'CONTACT_HAS_OPERATION_HISTORY', statusCode: 409,
      message: 'Bu kişi operasyon geçmişinde kullanıldığı için kalıcı olarak silinemez.',
    });
    expect((await pool!.query('SELECT 1 FROM contacts WHERE id = $1', [f.contactId])).rowCount).toBe(1);
    const deactivated = await f.crmService.deactivateContact(
      f.crmManager, f.customerId, f.contactId, contact.version,
    );
    expect(deactivated.isActive).toBe(false);
    const read = await f.service.getMeetingDetails(f.staff, job.id, { includeMetContactCapability: true });
    expect(read.metContact).toEqual({ id: f.contactId, name: 'Dr. Deniz', title: 'Başhekim' });
    expect((await f.state(job.id)).meeting.met_contact_id).toBe(f.contactId);
  });

  it('reader gate: legacy shapes exclude met fields and the opt-in always includes them', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const legacyKeys = [
      'jobCardId', 'jobCardVersion', 'meetingAt', 'meetingSummary', 'nextFollowUpAt',
      'outcome', 'unsuccessfulReason',
    ];
    const legacyRead = await f.service.getMeetingDetails(f.staff, job.id);
    expect(Object.keys(legacyRead).sort()).toEqual(legacyKeys);
    expect(legacyRead).not.toHaveProperty('metContactId');
    expect(legacyRead).not.toHaveProperty('metContact');

    const optInRead = await f.service.getMeetingDetails(f.staff, job.id, {
      includeMetContactCapability: true,
    });
    expect(Object.keys(optInRead).sort()).toEqual(
      [...legacyKeys, 'metContact', 'metContactId'].sort(),
    );
    expect(optInRead).toMatchObject({ metContactId: null, metContact: null });

    const legacyPatch = await f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-gate-legacy', expectedVersion: job.version,
      metContactId: f.contactId,
    });
    expect(Object.keys(legacyPatch).sort()).toEqual(legacyKeys);
    expect(legacyPatch).not.toHaveProperty('metContactId');
    const persistedAfterLegacy = (await pool!.query<{ met_contact_id: string | null }>(
      'SELECT met_contact_id FROM job_card_meeting_details WHERE job_card_id = $1', [job.id],
    )).rows[0]!;
    expect(persistedAfterLegacy.met_contact_id).toBe(f.contactId);

    const optInPatch = await f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-gate-optin', expectedVersion: job.version + 1,
      metContactId: f.secondContactId,
    }, { includeMetContactCapability: true });
    expect(Object.keys(optInPatch).sort()).toEqual(
      [...legacyKeys, 'metContact', 'metContactId'].sort(),
    );
    expect(optInPatch.metContactId).toBe(f.secondContactId);
  });

  it('keeps editing other fields when the unchanged met contact was deactivated later', async () => {
    const f = await fixture();
    // No planned contact so deactivation only faces the met reference.
    const job = await f.startedMeeting(f.customerId, f.staff, null);
    const assigned = await f.readyResult(job.id, job.version, f.contactId);
    expect(assigned.metContactId).toBe(f.contactId);
    const contact = (await pool!.query<{ version: number }>(
      'SELECT version FROM contacts WHERE id = $1', [f.contactId],
    )).rows[0]!;
    await f.crmService.deactivateContact(f.crmManager, f.customerId, f.contactId, contact.version);

    const updated = await f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-inactive-unchanged', expectedVersion: assigned.jobCardVersion,
      metContactId: f.contactId, meetingSummary: 'Kişi pasifleşti; özet güncellendi.',
    }, { includeMetContactCapability: true });
    expect(updated.metContactId).toBe(f.contactId);
    expect(updated.metContact).toEqual({ id: f.contactId, name: 'Dr. Deniz', title: 'Başhekim' });
    const after = await f.state(job.id);
    expect(after.meeting.met_contact_id).toBe(f.contactId);
    expect(after.meeting.meeting_summary).toBe('Kişi pasifleşti; özet güncellendi.');
    expect(after.activities.at(-1)!.metadata.changedFields).toEqual(['meetingSummary']);

    // Selecting a different (inactive) contact is still validated and rejected.
    await expect(f.service.patchMeetingDetails(f.staff, job.id, {
      clientActionId: 'met-inactive-new', expectedVersion: updated.jobCardVersion,
      metContactId: f.inactiveContactId,
    })).rejects.toMatchObject({ code: 'CONTACT_INACTIVE', statusCode: 409 });
  });

  it('projects canonical and pre-056 receipts to the requesting reader shape', async () => {
    const f = await fixture();
    const job = await f.startedMeeting();
    const payload = {
      clientActionId: 'met-receipt-canonical', expectedVersion: job.version, metContactId: f.contactId,
    };
    const first = await f.service.patchMeetingDetails(
      f.staff, job.id, payload, { includeMetContactCapability: true },
    );
    // The stored receipt is canonical even for an opt-in writer.
    const stored = (await pool!.query<{ response_body: Record<string, unknown> }>(
      `SELECT response_body FROM processed_actions
        WHERE organization_id = $1 AND user_id = $2 AND client_action_id = $3`,
      [f.organizationId, f.staffId, payload.clientActionId],
    )).rows[0]!;
    expect(stored.response_body.metContactId).toBe(f.contactId);
    expect((stored.response_body.metContact as { id: string }).id).toBe(f.contactId);

    const legacyReplay = await f.service.patchMeetingDetails(f.staff, job.id, payload);
    expect(Object.keys(legacyReplay).sort()).toEqual([
      'jobCardId', 'jobCardVersion', 'meetingAt', 'meetingSummary', 'nextFollowUpAt',
      'outcome', 'unsuccessfulReason',
    ]);
    const optInReplay = await f.service.patchMeetingDetails(
      f.staff, job.id, payload, { includeMetContactCapability: true },
    );
    expect(optInReplay).toEqual(first);

    // Pre-056 receipt: completed before the met-contact column existed.
    const legacyJob = await f.startedMeeting();
    const legacyActionId = 'met-receipt-legacy';
    const legacyInput = {
      clientActionId: legacyActionId, expectedVersion: legacyJob.version,
      meetingSummary: 'Eski kayıt',
    };
    const legacyBody = {
      jobCardId: legacyJob.id, meetingAt: '2026-07-15T10:30:00.000Z', outcome: 'POSITIVE',
      unsuccessfulReason: null, meetingSummary: 'Eski kayıt', nextFollowUpAt: null,
      jobCardVersion: legacyJob.version + 1,
    };
    await pool!.query(
      `INSERT INTO processed_actions
         (organization_id, user_id, client_action_id, operation_key, request_hash, status,
          status_code, response_body, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', 200, $6::jsonb, NOW())`,
      [f.organizationId, f.staffId, legacyActionId, `MEETING_DETAILS_UPDATE:${legacyJob.id}`,
        meetingDetailsUpdateRequestHash(legacyJob.id, legacyInput), JSON.stringify(legacyBody)],
    );
    const before = await f.state(legacyJob.id);
    const upgradedReplay = await f.service.patchMeetingDetails(
      f.staff, legacyJob.id, legacyInput, { includeMetContactCapability: true },
    );
    expect(upgradedReplay.jobCardVersion).toBe(legacyBody.jobCardVersion);
    expect(upgradedReplay.meetingSummary).toBe('Eski kayıt');
    // The pre-056 operation truthfully reports "not recorded", never a guess.
    expect(upgradedReplay.metContactId).toBeNull();
    expect(upgradedReplay.metContact).toBeNull();
    const legacyShapedReplay = await f.service.patchMeetingDetails(f.staff, legacyJob.id, legacyInput);
    expect(legacyShapedReplay).not.toHaveProperty('metContactId');
    expect(legacyShapedReplay).not.toHaveProperty('metContact');
    // Replays change neither audit nor version.
    expect(await f.state(legacyJob.id)).toEqual(before);
    await expect(f.service.patchMeetingDetails(f.staff, legacyJob.id, {
      ...legacyInput, meetingSummary: 'Farklı içerik',
    }, { includeMetContactCapability: true })).rejects.toMatchObject({
      code: 'CLIENT_ACTION_REUSED', statusCode: 409,
    });
  });

  it('projects met-contact history into the contact hasOperationHistory reads', async () => {
    const f = await fixture();
    // The planned reference stays empty so the met reference is the only link.
    const job = await f.startedMeeting(f.customerId, f.staff, null);
    await f.readyResult(job.id, job.version, f.contactId);
    const contact = await f.crmService.getContact(f.crmAdmin, f.customerId, f.contactId);
    expect(contact.hasOperationHistory).toBe(true);
    const list = await f.crmService.listContacts(f.crmAdmin, f.customerId, {
      q: null, status: 'all', limit: 50, offset: 0,
    });
    expect(list.items.find((item) => item.id === f.contactId)?.hasOperationHistory).toBe(true);
    const detail = await f.crmService.getCustomer(f.crmAdmin, f.customerId);
    expect(detail.contacts.find((item) => item.id === f.contactId)?.hasOperationHistory).toBe(true);
  });
});
