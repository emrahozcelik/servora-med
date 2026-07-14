import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardBaseFilters, JobCardListQuery } from '../src/modules/job-cards/types.js';

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
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'ABC Klinik', 'clinic', 'active') RETURNING id`, [organizationId],
      )).rows[0]!.id;
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
      let completed = await service.plan(staff, completedJobId, { clientActionId: 'plan', expectedVersion: 2 });
      completed = await service.start(staff, completedJobId, { clientActionId: 'start', expectedVersion: completed.version });
      completed = await service.submitForApproval(staff, completedJobId, { clientActionId: 'submit', expectedVersion: completed.version });
      completed = await service.approve(manager, completedJobId, { clientActionId: 'approve', expectedVersion: completed.version });
      expect(completed).toMatchObject({ status: 'COMPLETED', version: 6 });
      await expect(service.approve(manager, completedJobId, { clientActionId: 'approve', expectedVersion: 5 })).resolves.toEqual(completed);

      await addItem(cancelledJobId, 'delivery-revision');
      let revised = await service.start(staff, cancelledJobId, { clientActionId: 'start-revision', expectedVersion: 2 });
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
      expect(closedBoard.closedCounts).toEqual({ COMPLETED: 1, CANCELLED: 1 });
      const activity = await service.listActivity(manager, completedJobId, { limit: 50, offset: 0 });
      expect(activity.items.map((item) => item.eventType)).toEqual(expect.arrayContaining([
        'DELIVERY_ITEM_ADDED', 'JOB_PLANNED', 'JOB_STARTED', 'JOB_SUBMITTED_FOR_APPROVAL',
        'JOB_APPROVED', 'NOTE_ADDED',
      ]));
      expect(activity.items.filter((item) => item.eventType === 'JOB_APPROVED')).toHaveLength(1);
      expect(JSON.stringify(activity)).not.toMatch(/oldValue|newValue|metadata|clientActionId|Birinci not|İkinci not/);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
