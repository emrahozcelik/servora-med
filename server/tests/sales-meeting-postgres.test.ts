import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const requestTime = new Date('2026-07-15T12:00:00.000Z');

async function applyMigrations(pool: Pool) {
  for (const migration of [
    '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
    '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
    '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
    '009_job_acceptance_and_scheduling.sql',
  ]) {
    const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
    await pool.query(await readFile(path, 'utf8'));
  }
}

const SCHEDULED_AT = '2026-07-15T10:30:00.000Z';

describe.skipIf(!databaseUrl)('Sales Meeting PostgreSQL acceptance', () => {
  it('preserves transactions, concurrency, lifecycle, report scope, and safe audit output', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `sales_meeting_acceptance_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      await applyMigrations(pool);

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Sales Meeting acceptance', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      async function createUser(name: string, role: 'MANAGER' | 'STAFF') {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
          [organizationId, name, `${randomUUID()}@test.local`, role],
        )).rows[0]!.id;
      }
      const managerId = await createUser('Murat Yönetici', 'MANAGER');
      const staffId = await createUser('Ayşe Personel', 'STAFF');
      const otherStaffId = await createUser('Başka Personel', 'STAFF');
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
         VALUES ($1, $2, $3), ($1, $4, $3)`,
        [organizationId, staffId, managerId, otherStaffId],
      );
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'ABC Klinik', 'clinic', 'active') RETURNING id`, [organizationId],
      )).rows[0]!.id;
      const contactId = (await pool.query<{ id: string }>(
        `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
         VALUES ($1, $2, 'Dr. Deniz', TRUE) RETURNING id`, [organizationId, customerId],
      )).rows[0]!.id;
      const productId = (await pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit)
         VALUES ($1, 'İmplant Seti', 'adet') RETURNING id`, [organizationId],
      )).rows[0]!.id;

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(repository, () => requestTime);
      const reports = new PostgresReportsRepository(pool);
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
      const otherStaff: JobCardActor = { id: otherStaffId, organizationId, role: 'STAFF' };
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };

      const createInput = {
        clientActionId: 'meeting-create', type: 'SALES_MEETING' as const,
        title: 'İmplant değerlendirme görüşmesi', description: null,
        customerId, contactId, assignedTo: staffId, priority: 'normal' as const,
        dueDate: '2026-07-15', scheduledAt: SCHEDULED_AT,
      };
      let meeting = await service.create(staff, createInput);
      expect(meeting).toMatchObject({
        dueDate: '2026-07-15', scheduledAt: SCHEDULED_AT, status: 'ACCEPTED',
      });
      await expect(service.create(staff, createInput)).resolves.toEqual(meeting);
      expect((await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_meeting_details WHERE job_card_id = $1`,
        [meeting.id],
      )).rows[0]!.count).toBe('1');
      // NEW/ACCEPTED: meeting result is not readable until execution starts (exact edit contract).
      await expect(service.getMeetingDetails(staff, meeting.id)).rejects.toMatchObject({
        code: 'JOB_NOT_EDITABLE', statusCode: 409,
        message: 'JobCard bu durumda düzenlenemez.',
      });
      await expect(service.detail(otherStaff, meeting.id))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      meeting = await service.start(staff, meeting.id, {
        clientActionId: 'meeting-start', expectedVersion: meeting.version,
      });
      const concurrent = await Promise.allSettled([
        service.patchMeetingDetails(staff, meeting.id, {
          clientActionId: 'meeting-patch-a', expectedVersion: meeting.version,
          outcome: 'NO_DECISION',
        }),
        service.patchMeetingDetails(staff, meeting.id, {
          clientActionId: 'meeting-patch-b', expectedVersion: meeting.version,
          outcome: 'FOLLOW_UP_REQUIRED',
        }),
      ]);
      expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(concurrent.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'VERSION_CONFLICT', statusCode: 409 },
      });
      let details = await service.getMeetingDetails(staff, meeting.id);
      await expect(service.patchMeetingDetails(staff, meeting.id, {
        clientActionId: 'meeting-no-op', expectedVersion: details.jobCardVersion,
        outcome: details.outcome,
      })).rejects.toMatchObject({
        code: 'MEETING_DETAILS_UNCHANGED', statusCode: 400,
        message: 'Görüşme sonucunda kaydedilecek bir değişiklik yok.',
      });
      await expect(service.patchMeetingDetails(staff, meeting.id, {
        clientActionId: 'meeting-stale-version', expectedVersion: meeting.version,
        meetingSummary: 'Eski sürüm yazmamalı.',
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });

      details = await service.patchMeetingDetails(staff, meeting.id, {
        clientActionId: 'meeting-clear-result', expectedVersion: details.jobCardVersion,
        meetingAt: null, outcome: null, meetingSummary: null, nextFollowUpAt: null,
      });
      await pool.query(`UPDATE customers SET status = 'inactive' WHERE id = $1`, [customerId]);
      await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [staffId]);
      await expect(service.submitForApproval(staff, meeting.id, {
        clientActionId: 'submit-customer-priority', expectedVersion: details.jobCardVersion,
      })).rejects.toMatchObject({ code: 'CUSTOMER_INACTIVE', statusCode: 409 });
      await pool.query(`UPDATE customers SET status = 'active' WHERE id = $1`, [customerId]);
      await expect(service.submitForApproval(staff, meeting.id, {
        clientActionId: 'submit-assignee-priority', expectedVersion: details.jobCardVersion,
      })).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ELIGIBLE', statusCode: 400 });
      await pool.query(`UPDATE users SET is_active = TRUE WHERE id = $1`, [staffId]);
      await expect(service.submitForApproval(staff, meeting.id, {
        clientActionId: 'submit-meeting-readiness', expectedVersion: details.jobCardVersion,
      })).rejects.toMatchObject({ code: 'MEETING_NOT_READY', statusCode: 400 });

      details = await service.patchMeetingDetails(staff, meeting.id, {
        clientActionId: 'meeting-boundary-result', expectedVersion: details.jobCardVersion,
        meetingAt: '2026-07-15T12:15:00.000Z', outcome: 'FOLLOW_UP_REQUIRED',
        meetingSummary: 'Takip görüşmesi planlanacak.', nextFollowUpAt: null,
      });
      meeting = await service.submitForApproval(staff, meeting.id, {
        clientActionId: 'meeting-submit', expectedVersion: details.jobCardVersion,
      });
      const withdrawn = await service.withdrawFromApproval(staff, meeting.id, {
        clientActionId: 'meeting-withdraw', expectedVersion: meeting.version,
      });
      await expect(service.withdrawFromApproval(staff, meeting.id, {
        clientActionId: 'meeting-withdraw', expectedVersion: meeting.version,
      })).resolves.toEqual(withdrawn);
      details = await service.patchMeetingDetails(staff, meeting.id, {
        clientActionId: 'meeting-after-withdraw', expectedVersion: withdrawn.version,
        meetingSummary: 'Geri çekildikten sonra düzeltildi.',
      });
      meeting = await service.submitForApproval(staff, meeting.id, {
        clientActionId: 'meeting-after-withdraw-submit', expectedVersion: details.jobCardVersion,
      });
      meeting = await service.requestRevision(manager, meeting.id, {
        clientActionId: 'meeting-revision', expectedVersion: meeting.version,
        revisionReason: 'Sonucu olumlu olarak düzeltin.',
      });
      meeting = await service.resume(staff, meeting.id, {
        clientActionId: 'meeting-resume', expectedVersion: meeting.version,
      });
      details = await service.patchMeetingDetails(staff, meeting.id, {
        clientActionId: 'meeting-correction', expectedVersion: meeting.version,
        outcome: 'POSITIVE', meetingSummary: 'Görüşme olumlu tamamlandı.',
      });
      meeting = await service.submitForApproval(staff, meeting.id, {
        clientActionId: 'meeting-resubmit', expectedVersion: details.jobCardVersion,
      });
      meeting = await service.approve(manager, meeting.id, {
        clientActionId: 'meeting-approve', expectedVersion: meeting.version,
      });
      expect(meeting.status).toBe('COMPLETED');

      let generalTask = await service.create(staff, {
        clientActionId: 'general-create', type: 'GENERAL_TASK', title: 'Görüşme sonrası görev',
        description: null, customerId: null, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: null, scheduledAt: null,
      });
      generalTask = await service.start(staff, generalTask.id, {
        clientActionId: 'general-start', expectedVersion: generalTask.version,
      });
      generalTask = await service.submitForApproval(staff, generalTask.id, {
        clientActionId: 'general-submit', expectedVersion: generalTask.version,
      });
      generalTask = await service.approve(manager, generalTask.id, {
        clientActionId: 'general-approve', expectedVersion: generalTask.version,
      });

      let delivery = await service.create(staff, {
        clientActionId: 'delivery-create', type: 'PRODUCT_DELIVERY', title: 'Numune teslimi',
        description: null, customerId, contactId, assignedTo: staffId,
        priority: 'normal', dueDate: null, scheduledAt: SCHEDULED_AT,
      });
      const deliveryMutation = await service.addDeliveryItem(staff, delivery.id, {
        clientActionId: 'delivery-item', expectedVersion: delivery.version, productId,
        deliveryPurpose: 'SAMPLE', deliveredAt: '2026-07-15T08:00:00.000Z', quantity: 2,
      });
      delivery = await service.start(staff, delivery.id, {
        clientActionId: 'delivery-start', expectedVersion: deliveryMutation.jobCardVersion,
      });
      delivery = await service.submitForApproval(staff, delivery.id, {
        clientActionId: 'delivery-submit', expectedVersion: delivery.version,
      });
      delivery = await service.approve(manager, delivery.id, {
        clientActionId: 'delivery-approve', expectedVersion: delivery.version,
      });

      const activity = await service.listActivity(manager, meeting.id, { limit: 50, offset: 0 });
      expect(activity.items.map((item) => item.eventType)).toEqual(expect.arrayContaining([
        'JOB_CREATED', 'JOB_STARTED', 'MEETING_DETAILS_UPDATED',
        'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVAL_WITHDRAWN',
        'JOB_REVISION_REQUESTED', 'JOB_RESUMED', 'JOB_APPROVED',
      ]));
      expect(JSON.stringify(activity)).not.toMatch(/Takip görüşmesi|Görüşme olumlu|oldValue|newValue|metadata/);

      const range = { from: '2026-07-15', to: '2026-07-15' };
      await expect(reports.getDashboard({ organizationId, requestedRange: range, requestTime }))
        .resolves.toMatchObject({ counters: { completedInPeriod: 3 } });
      await expect(reports.getOne({ organizationId, staffUserId: staffId,
        requestedRange: range, requestTime })).resolves.toMatchObject({
        counters: { completedInPeriod: 3 },
      });
      await expect(reports.getStaffMeetingsByOutcome({ organizationId, staffUserId: staffId,
        requestedRange: range, requestTime })).resolves.toEqual([
        { outcome: 'POSITIVE', count: 1 }, { outcome: 'FOLLOW_UP_REQUIRED', count: 0 },
        { outcome: 'NO_DECISION', count: 0 }, { outcome: 'NOT_INTERESTED', count: 0 },
      ]);
      await expect(reports.getDeliveryReport({ organizationId, requestedRange: range,
        requestTime, groupBy: 'purpose', staffUserId: null, limit: 50, offset: 0 }))
        .resolves.toMatchObject({ total: 1,
          items: [{ purpose: 'SAMPLE', unit: 'adet', quantity: '2.000' }] });

      async function createWaitingTask(suffix: string) {
        let task = await service.create(staff, {
          clientActionId: `race-${suffix}-create`, type: 'GENERAL_TASK' as const,
          title: `Lifecycle race ${suffix}`, description: null, customerId: null,
          contactId: null, assignedTo: staffId, priority: 'normal' as const,
          dueDate: null, scheduledAt: null,
        });
        task = await service.start(staff, task.id, {
          clientActionId: `race-${suffix}-start`, expectedVersion: task.version,
        });
        return service.submitForApproval(staff, task.id, {
          clientActionId: `race-${suffix}-submit`, expectedVersion: task.version,
        });
      }

      async function expectLifecycleRace(
        suffix: string,
        eventTypes: [string, string],
        commands: (task: Awaited<ReturnType<typeof createWaitingTask>>) => [Promise<unknown>, Promise<unknown>],
      ) {
        const task = await createWaitingTask(suffix);
        const results = await Promise.allSettled(commands(task));
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
          reason: { code: 'VERSION_CONFLICT', statusCode: 409 },
        });
        const events = (await service.listActivity(manager, task.id, { limit: 50, offset: 0 }))
          .items.map((item) => item.eventType);
        expect(events.filter((eventType) => eventTypes.includes(eventType))).toHaveLength(1);
      }

      await expectLifecycleRace(
        'approve-withdraw', ['JOB_APPROVED', 'JOB_APPROVAL_WITHDRAWN'],
        (task) => [
          service.approve(manager, task.id, {
            clientActionId: 'race-approve-withdraw-approve', expectedVersion: task.version,
          }),
          service.withdrawFromApproval(manager, task.id, {
            clientActionId: 'race-approve-withdraw-withdraw', expectedVersion: task.version,
          }),
        ],
      );
      await expectLifecycleRace(
        'revision-withdraw', ['JOB_REVISION_REQUESTED', 'JOB_APPROVAL_WITHDRAWN'],
        (task) => [
          service.requestRevision(manager, task.id, {
            clientActionId: 'race-revision-withdraw-revision', expectedVersion: task.version,
            revisionReason: 'Yarış testi düzeltmesi.',
          }),
          service.withdrawFromApproval(staff, task.id, {
            clientActionId: 'race-revision-withdraw-withdraw', expectedVersion: task.version,
          }),
        ],
      );
      await expectLifecycleRace(
        'cancel-withdraw', ['JOB_CANCELLED', 'JOB_APPROVAL_WITHDRAWN'],
        (task) => [
          service.cancel(staff, task.id, {
            clientActionId: 'race-cancel-withdraw-cancel', expectedVersion: task.version,
            cancelReason: 'Yarış testi iptali.',
          }),
          service.withdrawFromApproval(staff, task.id, {
            clientActionId: 'race-cancel-withdraw-withdraw', expectedVersion: task.version,
          }),
        ],
      );
      await expectLifecycleRace(
        'cancel-approve', ['JOB_CANCELLED', 'JOB_APPROVED'],
        (task) => [
          service.cancel(staff, task.id, {
            clientActionId: 'race-cancel-approve-cancel', expectedVersion: task.version,
            cancelReason: 'Yarış testi iptali.',
          }),
          service.approve(manager, task.id, {
            clientActionId: 'race-cancel-approve-approve', expectedVersion: task.version,
          }),
        ],
      );

      let editCancelRace = await service.create(staff, {
        clientActionId: 'race-edit-cancel-create', type: 'SALES_MEETING',
        title: 'Düzenleme ve iptal yarışı', description: null, customerId, contactId,
        assignedTo: staffId, priority: 'normal', dueDate: '2026-07-15',
        scheduledAt: SCHEDULED_AT,
      });
      editCancelRace = await service.start(staff, editCancelRace.id, {
        clientActionId: 'race-edit-cancel-start', expectedVersion: editCancelRace.version,
      });
      const editCancelResults = await Promise.allSettled([
        service.patchMeetingDetails(staff, editCancelRace.id, {
          clientActionId: 'race-edit-cancel-edit', expectedVersion: editCancelRace.version,
          meetingAt: '2026-07-15T12:00:00.000Z', outcome: 'NO_DECISION',
        }),
        service.cancel(staff, editCancelRace.id, {
          clientActionId: 'race-edit-cancel-cancel', expectedVersion: editCancelRace.version,
          cancelReason: 'Eşzamanlı iptal testi.',
        }),
      ]);
      expect(editCancelResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(editCancelResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(editCancelResults.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'VERSION_CONFLICT', statusCode: 409 },
      });
      const editCancelEvents = (await service.listActivity(
        manager, editCancelRace.id, { limit: 50, offset: 0 },
      )).items.map((item) => item.eventType);
      expect(editCancelEvents.filter((eventType) => [
        'MEETING_DETAILS_UPDATED', 'JOB_CANCELLED',
      ].includes(eventType))).toHaveLength(1);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
