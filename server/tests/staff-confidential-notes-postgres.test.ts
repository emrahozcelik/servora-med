import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import type { Pool as PoolType } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresStaffConfidentialNotesRepository } from '../src/modules/staff-confidential-notes/repository.js';
import { StaffConfidentialNotesService } from '../src/modules/staff-confidential-notes/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('Staff confidential notes PostgreSQL integration', () => {
  it('persists notes, audit, and realtime with idempotent replay and no cross-table body leakage', async () => {
    const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
    if (!adminPool) return;
    const schema = `scn_${randomUUID().replaceAll('-', '')}`;
    let pool: PoolType | null = null;
    const published: unknown[] = [];
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await runMigrations({
        migrationsDirectory,
        store: new PostgresMigrationStore(pool),
      });

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('SCN org') RETURNING id`,
      )).rows[0]!.id;
      const adminId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'SCN Admin', $2, 'hash', 'ADMIN') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const managerId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'SCN Manager', $2, 'hash', 'MANAGER') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const staffId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'SCN Staff', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const staffProfileId = (await pool.query<{ id: string }>(
        `INSERT INTO staff_profiles (organization_id, user_id, title)
         VALUES ($1, $2, 'Satış Temsilcisi') RETURNING id`,
        [organizationId, staffId],
      )).rows[0]!.id;
      const noProfileStaffId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'SCN No Profile', $2, 'hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const otherOrgId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('SCN other org') RETURNING id`,
      )).rows[0]!.id;
      const crossOrgAdminId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'SCN Cross Admin', $2, 'hash', 'ADMIN') RETURNING id`,
        [otherOrgId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;

      const repository = new PostgresStaffConfidentialNotesRepository(pool);
      const service = new StaffConfidentialNotesService(
        repository,
        { publish: (event) => published.push(event) },
        () => new Date('2026-08-03T10:00:00.000Z'),
      );

      const actor = (id: string, organizationId: string, role: SafeUser['role']): SafeUser => ({
        id, organizationId, name: 'Actor', email: `${id}@test.local`, role,
        mustChangePassword: false, isActive: true, version: 1,
      });
      const admin = actor(adminId, organizationId, 'ADMIN');
      const manager = actor(managerId, organizationId, 'MANAGER');
      const staff = actor(staffId, organizationId, 'STAFF');
      const crossOrgAdmin = actor(crossOrgAdminId, otherOrgId, 'ADMIN');

      // Migration contract: new tables/columns/constraints exist.
      const auditTypes = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'audit_events'::regclass AND conname = 'audit_events_event_type_check'`,
      )).rows[0]!.def as string;
      expect(auditTypes).toContain('STAFF_CONFIDENTIAL_NOTE_CREATED');
      const auditSubjects = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'audit_events'::regclass AND conname = 'audit_events_subject_type_check'`,
      )).rows[0]!.def as string;
      expect(auditSubjects).toContain('STAFF_CONFIDENTIAL_NOTE');
      const realtimeTypes = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'realtime_events'::regclass AND conname = 'realtime_events_event_type_check'`,
      )).rows[0]!.def as string;
      expect(realtimeTypes).toContain('confidential-note.created');
      const realtimeEntities = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'realtime_events'::regclass AND conname = 'realtime_events_entity_type_check'`,
      )).rows[0]!.def as string;
      expect(realtimeEntities).toContain('confidential-note');
      const sourceCheck = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'realtime_events'::regclass AND conname = 'realtime_events_activity_source_check'`,
      )).rows[0]!.def as string;
      expect(sourceCheck).toContain('staff_note_id');
      const profileFk = (await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'staff_confidential_notes'::regclass
            AND conname = 'staff_confidential_notes_staff_profile_fk'`,
      )).rows[0]!.def as string;
      expect(profileFk).toContain('REFERENCES staff_profiles(user_id)');
      expect(staffProfileId).toBeTruthy();
      const indexCount = (await pool.query(
        `SELECT COUNT(*)::int AS count FROM pg_indexes
          WHERE schemaname = '${schema}' AND tablename = 'staff_confidential_notes'`,
      )).rows[0]!.count as number;
      expect(indexCount).toBeGreaterThanOrEqual(2);

      // A legacy operational JobCard note is created first and must remain untouched.
      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Legacy job', $2, $3) RETURNING id`,
        [organizationId, staffId, adminId],
      )).rows[0]!.id;
      const legacyActivityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type, client_action_id)
         VALUES ($1, $2, $3, 'NOTE_ADDED', 'legacy-activity') RETURNING id`,
        [organizationId, jobCardId, staffId],
      )).rows[0]!.id;
      const legacyNoteId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_notes
           (organization_id, job_card_id, author_id, note, author_name_snapshot,
            author_role_snapshot, workflow_stage, context, related_activity_id, record_version)
         VALUES ($1, $2, $3, 'Legacy operational note', 'SCN Staff', 'STAFF', 'NEW', 'GENERAL', $4, 1)
         RETURNING id`,
        [organizationId, jobCardId, staffId, legacyActivityId],
      )).rows[0]!.id;

      // ADMIN creates.
      const note = await service.createNote(admin, staffId, {
        clientActionId: 'scn-action-1',
        body: '  Gizli not gövdesi  ',
      });
      expect(note.body).toBe('Gizli not gövdesi');
      expect(note.staffUserId).toBe(staffId);
      expect(note.authorUserId).toBe(adminId);

      const noteRows = (await pool.query<{ body: string }>(
        `SELECT body FROM staff_confidential_notes WHERE organization_id = $1`,
        [organizationId],
      )).rows;
      expect(noteRows).toHaveLength(1);
      expect(noteRows[0]!.body).toBe('Gizli not gövdesi');

      const auditRows = (await pool.query<{
        subject_type: string;
        event_type: string;
        subject_id: string;
        new_value: unknown;
        metadata: { staffUserId: string };
      }>(
        `SELECT subject_type, event_type, subject_id, new_value, metadata
           FROM audit_events WHERE organization_id = $1`,
        [organizationId],
      )).rows;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.subject_type).toBe('STAFF_CONFIDENTIAL_NOTE');
      expect(auditRows[0]!.event_type).toBe('STAFF_CONFIDENTIAL_NOTE_CREATED');
      expect(auditRows[0]!.subject_id).toBe(note.id);
      expect(auditRows[0]!.new_value).toBeNull();
      expect(auditRows[0]!.metadata.staffUserId).toBe(staffId);
      expect(JSON.stringify(auditRows[0]!)).not.toContain('Gizli not gövdesi');

      const realtimeRows = (await pool.query<{
        staff_note_id: string;
        event_type: string;
        entity_type: string;
        audience_roles: string[];
        audience_user_ids: string[];
        resource_keys: string[];
      }>(
        `SELECT staff_note_id, event_type, entity_type, audience_roles, audience_user_ids, resource_keys
           FROM realtime_events WHERE organization_id = $1`,
        [organizationId],
      )).rows;
      expect(realtimeRows).toHaveLength(1);
      expect(realtimeRows[0]!.staff_note_id).toBe(note.id);
      expect(realtimeRows[0]!.event_type).toBe('confidential-note.created');
      expect(realtimeRows[0]!.entity_type).toBe('confidential-note');
      expect(realtimeRows[0]!.audience_roles).toEqual(['ADMIN', 'MANAGER']);
      expect(realtimeRows[0]!.audience_user_ids).toEqual([]);
      expect(realtimeRows[0]!.resource_keys).toEqual([`staff-confidential-notes:${staffId}`]);
      expect(JSON.stringify(realtimeRows[0]!)).not.toContain('Gizli not gövdesi');

      // MANAGER can list and create.
      const page = await service.listNotes(manager, staffId, { limit: 20, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.items[0]!.body).toBe('Gizli not gövdesi');
      await service.createNote(manager, staffId, {
        clientActionId: 'scn-action-2',
        body: 'Yönetici notu',
      });
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM staff_confidential_notes WHERE organization_id = $1`,
        [organizationId],
      )).rows[0]!.count).toBe(2);

      // Idempotent replay: same action id -> same note, no new rows/audit/realtime.
      const replay = await service.createNote(admin, staffId, {
        clientActionId: 'scn-action-1',
        body: 'Gizli not gövdesi',
      });
      expect(replay).toEqual(note);
      expect(replay.createdAt).toBe(note.createdAt);
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM staff_confidential_notes WHERE organization_id = $1`,
        [organizationId],
      )).rows[0]!.count).toBe(2);
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_events WHERE organization_id = $1`,
        [organizationId],
      )).rows[0]!.count).toBe(2);
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM realtime_events WHERE organization_id = $1`,
        [organizationId],
      )).rows[0]!.count).toBe(2);
      expect(published).toHaveLength(2);

      // Staff denied on both routes; no disclosure of existence.
      await expect(service.createNote(staff, staffId, { clientActionId: 'x', body: 'y' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.listNotes(staff, staffId, { limit: 20, offset: 0 }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

      // Cross-org and non-STAFF subjects are 404.
      await expect(service.createNote(crossOrgAdmin, staffId, { clientActionId: 'x', body: 'y' }))
        .rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 });
      await expect(service.createNote(admin, managerId, { clientActionId: 'x', body: 'y' }))
        .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });

      // A real staff profile is required: STAFF-role user without one is 404.
      await expect(service.createNote(admin, noProfileStaffId, { clientActionId: 'x', body: 'y' }))
        .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
      await expect(service.listNotes(admin, noProfileStaffId, { limit: 20, offset: 0 }))
        .rejects.toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND', statusCode: 404 });
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM staff_confidential_notes WHERE organization_id = $1`,
        [organizationId],
      )).rows[0]!.count).toBe(2);

      // Malformed userId is rejected before any PostgreSQL query runs (404, never 500).
      await expect(service.createNote(admin, 'not-a-uuid', { clientActionId: 'x', body: 'y' }))
        .rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 });
      await expect(service.listNotes(admin, 'not-a-uuid', { limit: 20, offset: 0 }))
        .rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 });

      // Inactive actor (defense in depth) is FORBIDDEN.
      await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [managerId]);
      await expect(service.createNote(manager, staffId, { clientActionId: 'x', body: 'y' }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await pool.query(`UPDATE users SET is_active = TRUE WHERE id = $1`, [managerId]);

      // Legacy operational notes are untouched.
      const legacy = (await pool.query(
        `SELECT note, id FROM job_card_notes WHERE id = $1`,
        [legacyNoteId],
      )).rows[0]!;
      expect(legacy.note).toBe('Legacy operational note');
      expect((await pool.query(
        `SELECT COUNT(*)::int AS count FROM job_card_notes WHERE organization_id = $1`,
        [organizationId],
      )).rows[0]!.count).toBe(1);

      // The audit subject index pattern stays queryable per staff member.
      const perStaffAudit = (await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_events
          WHERE organization_id = $1 AND subject_type = 'STAFF_CONFIDENTIAL_NOTE'`,
        [organizationId],
      )).rows[0]!.count;
      expect(perStaffAudit).toBe(2);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
