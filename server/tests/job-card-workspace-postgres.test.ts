import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardBaseFilters, JobCardListQuery } from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const filters: JobCardBaseFilters = {
  q: null, type: null, assignedTo: null, customerId: null, priority: null,
  dueBefore: null, dueAfter: null,
};
const listQuery: JobCardListQuery = { ...filters, status: 'all', limit: 25, offset: 0 };

describe.skipIf(!databaseUrl)('JobCard workspace PostgreSQL contract', () => {
  it('runs scoped projections, lifecycle, notes, activity safety, and terminal invariants', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `job_workspace_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      for (const migration of [
        '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
        '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
        '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
        '009_job_acceptance_and_scheduling.sql',
      ]) {
        const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
        await pool.query(await readFile(path, 'utf8'));
      }

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Workspace contract') RETURNING id`,
      )).rows[0]!.id;
      async function user(name: string, role: 'MANAGER' | 'STAFF') {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
          [organizationId, name, `${randomUUID()}@test.local`, role],
        )).rows[0]!.id;
      }
      const managerId = await user('Yönetici', 'MANAGER');
      const staffId = await user('Ayşe Personel', 'STAFF');
      const otherStaffId = await user('Başka Personel', 'STAFF');
      await pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + interval '1 day')`,
        [managerId, 'a'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
         VALUES ($1, $2, $3), ($1, $4, $3)`,
        [organizationId, staffId, managerId, otherStaffId],
      );
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'ABC Klinik', 'clinic', 'active') RETURNING id`, [organizationId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO contacts (organization_id, customer_id, name, is_primary)
         VALUES ($1, $2, 'Dr. Deniz', TRUE)`,
        [organizationId, customerId],
      );
      const productId = (await pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit) VALUES ($1, 'İmplant Seti', 'adet') RETURNING id`, [organizationId],
      )).rows[0]!.id;
      async function job(title: string, assignee = staffId) {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO job_cards (organization_id, type, title, customer_id, assigned_to, created_by)
           VALUES ($1, 'PRODUCT_DELIVERY', $2, $3, $4, $4) RETURNING id`,
          [organizationId, title, customerId, assignee],
        )).rows[0]!.id;
      }
      const completedJobId = await job('Tamamlanacak teslim');
      const cancelledJobId = await job('Düzeltilecek teslim');
      const hiddenJobId = await job('Başka personelin işi', otherStaffId);

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(repository, () => new Date('2026-07-14T09:00:00.000Z'));
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };

      let generalTask = await service.create(staff, {
        clientActionId: 'create-general-task', type: 'GENERAL_TASK',
        title: 'Klinik dönüşünü takip et', description: null,
        customerId: null, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: null, scheduledAt: null,
      });
      expect(generalTask).toMatchObject({
        type: 'GENERAL_TASK', status: 'ACCEPTED', version: 1,
        title: 'Klinik dönüşünü takip et', description: null,
        customer: null, contact: null, scheduledAt: null,
        assignee: { id: staffId, name: 'Ayşe Personel' },
        workflowContext: {
          lifecycle: {
            acceptedAt: '2026-07-14T09:00:00.000Z',
            acceptedBy: { id: staffId, name: 'Ayşe Personel' },
          },
        },
      });

      const generalTaskList = await service.list(staff, {
        ...listQuery, type: 'GENERAL_TASK',
      });
      expect(generalTaskList.items.map((item) => item.title))
        .toContain('Klinik dönüşünü takip et');
      await expect(service.list({ id: otherStaffId, organizationId, role: 'STAFF' }, {
        ...listQuery, type: 'GENERAL_TASK',
      })).resolves.toMatchObject({ items: [], total: 0 });
      expect((await service.list(manager, { ...listQuery, type: 'GENERAL_TASK' })).items)
        .toHaveLength(1);
      expect((await service.list(manager, { ...listQuery, type: 'PRODUCT_DELIVERY' })).items)
        .toHaveLength(3);

      await expect(service.listDeliveryItems(staff, generalTask.id))
        .rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 409 });
      await expect(service.addDeliveryItem(staff, generalTask.id, {
        clientActionId: 'invalid-general-delivery', expectedVersion: generalTask.version,
        productId, deliveryPurpose: 'SALE', deliveredAt: '2026-07-14T08:00:00.000Z', quantity: 1,
      })).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 409 });
      await expect(service.patchDeliveryItem(staff, generalTask.id, randomUUID(), {
        expectedVersion: generalTask.version, quantity: 3,
      })).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 409 });
      await expect(service.removeDeliveryItem(staff, generalTask.id, randomUUID(), {
        expectedVersion: generalTask.version,
      })).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 409 });
      expect((await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_card_delivery_items WHERE job_card_id = $1',
        [generalTask.id],
      )).rows[0]!.count).toBe('0');

      generalTask = await service.start(staff, generalTask.id, {
        clientActionId: 'start-general-task', expectedVersion: generalTask.version,
      });
      generalTask = await service.submitForApproval(staff, generalTask.id, {
        clientActionId: 'submit-general-task', expectedVersion: generalTask.version,
      });
      generalTask = await service.requestRevision(manager, generalTask.id, {
        clientActionId: 'revise-general-task', expectedVersion: generalTask.version,
        revisionReason: 'Takip sonucunu açıklayın',
      });
      generalTask = await service.resume(staff, generalTask.id, {
        clientActionId: 'resume-general-task', expectedVersion: generalTask.version,
      });
      generalTask = await service.submitForApproval(staff, generalTask.id, {
        clientActionId: 'resubmit-general-task', expectedVersion: generalTask.version,
      });
      generalTask = await service.approve(manager, generalTask.id, {
        clientActionId: 'approve-general-task', expectedVersion: generalTask.version,
      });
      expect(generalTask).toMatchObject({ status: 'COMPLETED', version: 7 });
      const generalTaskNote = await service.addNote(staff, generalTask.id, {
        clientActionId: 'note-general-task', note: 'Klinik dönüşü alındı.',
      });
      expect(generalTaskNote.note).toBe('Klinik dönüşü alındı.');
      const generalTaskActivity = await service.listActivity(manager, generalTask.id, {
        limit: 50, offset: 0,
      });
      expect(generalTaskActivity.items.map((item) => item.eventType)).toEqual(expect.arrayContaining([
        'JOB_CREATED', 'JOB_STARTED', 'JOB_SUBMITTED_FOR_APPROVAL',
        'JOB_REVISION_REQUESTED', 'JOB_RESUMED', 'JOB_APPROVED', 'NOTE_ADDED',
      ]));
      expect(JSON.stringify(generalTaskActivity)).not.toContain('Klinik dönüşü alındı.');

      let salesMeeting = await service.create(staff, {
        clientActionId: 'create-sales-meeting', type: 'SALES_MEETING',
        title: 'Kontrol görüşmesi', description: null,
        customerId, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: '2026-07-14',
        scheduledAt: '2026-07-14T10:00:00.000Z',
      });
      expect(salesMeeting).toMatchObject({
        type: 'SALES_MEETING', status: 'ACCEPTED', version: 1,
        scheduledAt: '2026-07-14T10:00:00.000Z',
        customer: { id: customerId, name: 'ABC Klinik' },
        assignee: { id: staffId, name: 'Ayşe Personel' },
      });
      expect((await service.list(staff, {
        ...listQuery, type: 'SALES_MEETING',
      })).items).toEqual([
        expect.objectContaining({
          id: salesMeeting.id, type: 'SALES_MEETING', deliveryItemCount: 0,
          scheduledAt: '2026-07-14T10:00:00.000Z',
        }),
      ]);
      // Board still groups ACCEPTED under a later column rename task; list remains authoritative.
      expect((await service.board(staff, {
        ...filters, type: 'SALES_MEETING', limit: 25,
      })).columns.NEW.items).toEqual([]);

      salesMeeting = await service.start(staff, salesMeeting.id, {
        clientActionId: 'start-sales-meeting', expectedVersion: salesMeeting.version,
      });
      const meetingDetails = await service.patchMeetingDetails(staff, salesMeeting.id, {
        clientActionId: 'save-sales-meeting-result', expectedVersion: salesMeeting.version,
        meetingAt: '2026-07-14T08:00:00.000Z', outcome: 'FOLLOW_UP_REQUIRED',
        meetingSummary: 'Kontrol ziyareti tamamlandı.', nextFollowUpAt: null,
      });
      salesMeeting = await service.submitForApproval(staff, salesMeeting.id, {
        clientActionId: 'submit-sales-meeting',
        expectedVersion: meetingDetails.jobCardVersion,
      });
      const waitingReports = new PostgresReportsRepository(pool);
      await expect(waitingReports.getApprovalSummary({
        organizationId,
        requestTime: new Date('2026-07-14T09:00:00.000Z'),
      })).resolves.toMatchObject({ pendingCount: 1 });
      await expect(repository.getApprovalItems({
        organizationId,
        requestTime: new Date('2026-07-14T09:00:00.000Z'),
        limit: 25,
        offset: 0,
      })).resolves.toEqual([
        expect.objectContaining({ id: salesMeeting.id, type: 'SALES_MEETING' }),
      ]);
      salesMeeting = await service.approve(manager, salesMeeting.id, {
        clientActionId: 'approve-sales-meeting', expectedVersion: salesMeeting.version,
      });
      expect(salesMeeting).toMatchObject({ status: 'COMPLETED', version: 5 });
      const salesMeetingActivity = await service.listActivity(manager, salesMeeting.id, {
        limit: 50, offset: 0,
      });
      expect(salesMeetingActivity.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: 'MEETING_DETAILS_UPDATED',
          details: {
            kind: 'MEETING_DETAILS',
            changedFields: ['meetingAt', 'outcome', 'meetingSummary'],
          },
        }),
      ]));
      expect(JSON.stringify(salesMeetingActivity)).not.toContain('Kontrol ziyareti tamamlandı.');

      const staffList = await service.list(staff, listQuery);
      expect(staffList.items.map((item) => item.id)).toEqual(expect.arrayContaining([completedJobId, cancelledJobId]));
      expect(staffList.items.map((item) => item.id)).not.toContain(hiddenJobId);
      await expect(service.list(staff, { ...listQuery, assignedTo: otherStaffId })).resolves.toMatchObject({ items: [], total: 0 });

      const managerBoard = await service.board(manager, { ...filters, limit: 25 });
      expect(managerBoard.columns.NEW.items.map((item) => item.id)).toContain(hiddenJobId);
      const staffBoard = await service.board(staff, { ...filters, limit: 25 });
      expect(staffBoard.columns.NEW.items.map((item) => item.id)).not.toContain(hiddenJobId);

      async function addItem(jobCardId: string, action: string) {
        return service.addDeliveryItem(staff, jobCardId, {
          clientActionId: action, expectedVersion: 1, productId, deliveryPurpose: 'SALE',
          deliveredAt: '2026-07-14T08:00:00.000Z', quantity: 2,
        });
      }
      await addItem(completedJobId, 'delivery-complete');
      let completed = await service.acceptAssignment(staff, completedJobId, {
        clientActionId: 'accept', expectedVersion: 2,
      });
      completed = await service.start(staff, completedJobId, { clientActionId: 'start', expectedVersion: completed.version });
      completed = await service.submitForApproval(staff, completedJobId, { clientActionId: 'submit', expectedVersion: completed.version });
      completed = await service.approve(manager, completedJobId, { clientActionId: 'approve', expectedVersion: completed.version });
      expect(completed).toMatchObject({ status: 'COMPLETED', version: 6 });
      await expect(service.approve(manager, completedJobId, { clientActionId: 'approve', expectedVersion: 5 })).resolves.toEqual(completed);

      await addItem(cancelledJobId, 'delivery-revision');
      let revised = await service.acceptAssignment(staff, cancelledJobId, {
        clientActionId: 'accept-revision', expectedVersion: 2,
      });
      revised = await service.start(staff, cancelledJobId, {
        clientActionId: 'start-revision', expectedVersion: revised.version,
      });
      const firstStartedAt = (await pool.query<{ started_at: Date }>('SELECT started_at FROM job_cards WHERE id=$1', [cancelledJobId])).rows[0]!.started_at;
      revised = await service.submitForApproval(staff, cancelledJobId, { clientActionId: 'submit-revision', expectedVersion: revised.version });
      revised = await service.requestRevision(manager, cancelledJobId, {
        clientActionId: 'revision', expectedVersion: revised.version, revisionReason: 'Miktarı doğrulayın',
      });
      revised = await service.resume(staff, cancelledJobId, { clientActionId: 'resume', expectedVersion: revised.version });
      const resumedStartedAt = (await pool.query<{ started_at: Date }>('SELECT started_at FROM job_cards WHERE id=$1', [cancelledJobId])).rows[0]!.started_at;
      expect(resumedStartedAt.toISOString()).toBe(firstStartedAt.toISOString());
      revised = await service.cancel(manager, cancelledJobId, {
        clientActionId: 'cancel', expectedVersion: revised.version, cancelReason: 'Yeni randevu kartı açılacak',
      });
      expect(revised.status).toBe('CANCELLED');
      const cancelledDetail = await repository.findJobCardDetail(organizationId, cancelledJobId);
      expect(cancelledDetail?.lifecycle).toMatchObject({
        startedAt: firstStartedAt.toISOString(),
        submittedAt: expect.any(String),
        submittedBy: { id: staffId, name: 'Ayşe Personel' },
        revisionRequestedAt: expect.any(String),
        revisionRequestedBy: { id: managerId, name: 'Yönetici' },
        revisionReason: 'Miktarı doğrulayın',
        cancelledAt: expect.any(String),
        cancelledBy: { id: managerId, name: 'Yönetici' },
        cancelReason: 'Yeni randevu kartı açılacak',
        cancelledFromStatus: 'IN_PROGRESS',
      });
      await expect(repository.findJobCardDetail(randomUUID(), cancelledJobId)).resolves.toBeNull();

      const completedVersion = completed.version;
      const [noteOne, noteTwo] = await Promise.all([
        service.addNote(staff, completedJobId, { clientActionId: 'note-one', note: 'Birinci not' }),
        service.addNote(staff, completedJobId, { clientActionId: 'note-two', note: 'İkinci not' }),
      ]);
      await expect(service.addNote(staff, completedJobId, { clientActionId: 'note-one', note: 'Birinci not' })).resolves.toEqual(noteOne);
      expect(noteTwo.id).not.toBe(noteOne.id);
      expect((await service.detail(staff, completedJobId)).version).toBe(completedVersion);
      await expect(service.patch(staff, completedJobId, { expectedVersion: completedVersion, title: 'Değişmemeli' }))
        .rejects.toMatchObject({ code: 'JOB_NOT_EDITABLE' });

      const closedBoard = await service.board(manager, { ...filters, limit: 25 });
      expect(closedBoard.closedCounts).toEqual({ COMPLETED: 3, CANCELLED: 1 });
      const activity = await service.listActivity(manager, completedJobId, { limit: 50, offset: 0 });
      expect(activity.items.map((item) => item.eventType)).toEqual(expect.arrayContaining([
        'DELIVERY_ITEM_ADDED', 'JOB_ACCEPTED', 'JOB_STARTED', 'JOB_SUBMITTED_FOR_APPROVAL',
        'JOB_APPROVED', 'NOTE_ADDED',
      ]));
      expect(activity.items.filter((item) => item.eventType === 'JOB_APPROVED')).toHaveLength(1);
      expect(JSON.stringify(activity)).not.toMatch(/oldValue|newValue|metadata|clientActionId|Birinci not|İkinci not/);

      const reports = new PostgresReportsRepository(pool);
      const dashboard = await reports.getDashboard({
        organizationId, requestedRange: { from: '2026-07-14', to: '2026-07-14' },
        requestTime: new Date('2026-07-14T09:00:00.000Z'),
      });
      expect(dashboard.counters.completedInPeriod).toBe(3);
      expect(dashboard.completedTrend).toEqual([{ date: '2026-07-14', count: 3 }]);
      await expect(reports.getOne({
        organizationId,
        staffUserId: staffId,
        requestedRange: { from: '2026-07-14', to: '2026-07-14' },
        requestTime: new Date('2026-07-14T09:00:00.000Z'),
      })).resolves.toMatchObject({
        counters: { completedInPeriod: 3 },
      });
      const deliveries = await reports.getDeliveryReport({
        organizationId, requestedRange: { from: '2026-07-14', to: '2026-07-14' },
        requestTime: new Date('2026-07-14T09:00:00.000Z'), groupBy: 'purpose',
        staffUserId: null, limit: 50, offset: 0,
      });
      expect(deliveries).toMatchObject({
        groupBy: 'purpose', total: 1,
        items: [{ purpose: 'SALE', unit: 'adet', quantity: '2.000' }],
      });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
