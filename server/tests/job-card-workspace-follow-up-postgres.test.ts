import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardListQuery } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql',
  '016_google_reverse_geocoding.sql',
  '017_calendar.sql',
  '018_messaging.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql',
  '024_job_card_notes_invoice_number.sql',
  '027_follow_up_proposals.sql',
  '028_notification_center_dismissal.sql',
  '029_messaging_conversation_archive.sql',
  '030_backup_domain_foundation.sql',
  '031_backup_engine_failure_taxonomy_and_dump_version.sql',
  '032_backup_r2_failure_taxonomy.sql',
  '033_backup_worker_runtime.sql',
  '034_demo_data_foundation.sql',
  '035_demo_data_purge_foundation.sql',
  '036_job_card_invalidated.sql',
  '042_unsuccessful_visit_reason.sql',
  '043_job_card_schedule_and_assignment_history.sql',
  '044_job_card_accountability_facts.sql',
];

function listQuery(overrides: Partial<JobCardListQuery> = {}): JobCardListQuery {
  return {
    q: null, type: null, assignedTo: null, customerId: null, priority: null,
    dueBefore: null, dueAfter: null, followUp: null,
    status: 'all', limit: 25, offset: 0, overdue: false,
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)('JobCard workspace follow-up filter PostgreSQL contract', () => {
  it('lists and boards only follow-up children with Staff scoping preserved', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `job_workspace_followup_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      for (const migration of MIGRATIONS) {
        const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
        await pool.query(await readFile(path, 'utf8'));
      }

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Follow-up workspace') RETURNING id`,
      )).rows[0]!.id;
      async function user(name: string, role: 'MANAGER' | 'STAFF') {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
          [organizationId, name, `${randomUUID()}@test.local`, role],
        )).rows[0]!.id;
      }
      const managerId = await user('Yönetici', 'MANAGER');
      const staffAId = await user('Ayşe Personel', 'STAFF');
      const staffBId = await user('Başka Personel', 'STAFF');
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
         VALUES ($1, $2, $3), ($1, $4, $3)`,
        [organizationId, staffAId, managerId, staffBId],
      );
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'ABC Klinik', 'clinic', 'active') RETURNING id`, [organizationId],
      )).rows[0]!.id;

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(repository, () => new Date('2026-07-14T09:00:00.000Z'));
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
      const staffB: JobCardActor = { id: staffBId, organizationId, role: 'STAFF' };

      let source = await service.create(staffA, {
        clientActionId: 'create-followup-source', type: 'GENERAL_TASK',
        title: 'Kaynak iş', description: null,
        customerId, contactId: null, assignedTo: staffAId,
        priority: 'normal', dueDate: null, scheduledAt: null,
      });
      source = await service.start(staffA, source.id, {
        clientActionId: 'start-followup-source', expectedVersion: source.version,
      });
      source = await service.submitForApproval(staffA, source.id, {
        clientActionId: 'submit-followup-source', expectedVersion: source.version,
        note: 'Kaynak tamamlandı.',
      });
      source = await service.approve(manager, source.id, {
        clientActionId: 'approve-followup-source', expectedVersion: source.version,
      });
      expect(source).toMatchObject({ status: 'COMPLETED' });

      const childA = await service.createFollowUp(manager, source.id, {
        clientActionId: 'create-followup-a', type: 'GENERAL_TASK',
        title: 'Takip işi A', followUpInstructions: 'Klinik dönüşünü takip et.',
        scheduledAt: null, assignedTo: staffAId,
        priority: 'normal', dueDate: null, contactId: null, engagementKind: null,
      });
      const childB = await service.createFollowUp(manager, source.id, {
        clientActionId: 'create-followup-b', type: 'GENERAL_TASK',
        title: 'Takip işi B', followUpInstructions: 'Numune sonucunu takip et.',
        scheduledAt: null, assignedTo: staffBId,
        priority: 'normal', dueDate: null, contactId: null, engagementKind: null,
      });

      const managerFollowUps = await service.list(manager, listQuery({ followUp: 'only' }));
      expect(managerFollowUps.items.map((item) => item.id).sort())
        .toEqual([childA.id, childB.id].sort());
      expect(managerFollowUps.items.map((item) => item.id)).not.toContain(source.id);

      const managerAll = await service.list(manager, listQuery());
      expect(managerAll.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([source.id, childA.id, childB.id]),
      );

      const staffAFollowUps = await service.list(staffA, listQuery({ followUp: 'only' }));
      expect(staffAFollowUps.items.map((item) => item.id)).toEqual([childA.id]);

      const staffBFollowUps = await service.list(staffB, listQuery({ followUp: 'only' }));
      expect(staffBFollowUps.items.map((item) => item.id)).toEqual([childB.id]);

      const board = await service.board(manager, {
        q: null, type: null, assignedTo: null, customerId: null, priority: null,
        dueBefore: null, dueAfter: null, followUp: 'only', limit: 25,
      });
      const boardIds = Object.values(board.columns).flatMap((column) => column.items.map((item) => item.id));
      expect(boardIds.sort()).toEqual([childA.id, childB.id].sort());
      expect(boardIds).not.toContain(source.id);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
