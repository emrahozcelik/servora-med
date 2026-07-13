import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL('../src/db/migrations/006_jobcard_workspace.sql', import.meta.url));
let sql = '';
beforeAll(async () => { sql = await readFile(path, 'utf8'); });

describe('006 JobCard workspace migration', () => {
  it('creates organization-owned append-only notes', () => {
    expect(sql).toMatch(/CREATE TABLE job_card_notes/i);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, job_card_id\)[\s\S]*job_cards \(organization_id, id\)/i);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, author_id\)[\s\S]*users \(organization_id, id\)/i);
    expect(sql).not.toMatch(/UPDATE job_card_notes|DELETE FROM job_card_notes/i);
  });

  it('rejects the approved whitespace set without stripping arbitrary format characters', () => {
    expect(sql).toContain(
      "CHECK (length(btrim(note, E' \\t\\n\\r\\f\\v' || chr(160) || chr(8232) || chr(8233))) > 0)",
    );
  });

  it('adds deterministic read indexes and lifecycle checks', () => {
    expect(sql).toMatch(/job_card_notes \(job_card_id, created_at DESC, id DESC\)/i);
    expect(sql).toMatch(/job_cards \(organization_id, updated_at DESC, id DESC\)/i);
    expect(sql).toMatch(/staff_completed_at ASC, id ASC[\s\S]*WAITING_APPROVAL/i);
    expect(sql).toContain('job_cards_planned_status_timestamp_check');
    expect(sql).toContain('job_cards_started_status_timestamp_check');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const baseMigrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
];

afterAll(async () => { await pool?.end(); });

async function applyBaseMigrations(client: PoolClient) {
  for (const migration of baseMigrations) {
    const migrationPath = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await client.query(await readFile(migrationPath, 'utf8'));
  }
}

async function withIsolatedSchema(run: (client: PoolClient) => Promise<void>) {
  const schema = `job_card_workspace_${randomUUID().replaceAll('-', '')}`;
  const client = await pool!.connect();

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query('BEGIN');
    await applyBaseMigrations(client);
    await run(client);
  } finally {
    await client.query('ROLLBACK');
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
}

async function createOrganizationAndUser(client: PoolClient, label: string) {
  const organization = await client.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [label],
  );
  const organizationId = organization.rows[0]!.id;
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${label} Staff`, `${randomUUID()}@test.local`],
  );
  return { organizationId, userId: user.rows[0]!.id };
}

describe.skipIf(!databaseUrl)('006 JobCard workspace PostgreSQL migration', () => {
  it('rejects an invalid legacy PLANNED row without rewriting it', async () => {
    await withIsolatedSchema(async (client) => {
      const { organizationId, userId } = await createOrganizationAndUser(client, 'Legacy Planned');
      const jobCard = await client.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'PLANNED', 'Invalid legacy planned task', $2, $2)
         RETURNING id`,
        [organizationId, userId],
      );

      await client.query('SAVEPOINT migration_006');
      await expect(client.query(sql)).rejects.toMatchObject({
        message: 'Cannot add planned timestamp constraint: invalid JobCard rows exist',
      });
      await client.query('ROLLBACK TO SAVEPOINT migration_006');

      await expect(client.query<{ planned_at: Date | null }>(
        'SELECT planned_at FROM job_cards WHERE id = $1',
        [jobCard.rows[0]!.id],
      )).resolves.toMatchObject({ rows: [{ planned_at: null }] });
    });
  });

  it.each([
    ['IN_PROGRESS', null, null, null, null, null, null, null],
    ['WAITING_APPROVAL', new Date(), 'USER', null, null, null, null, null],
    ['REVISION_REQUESTED', new Date(), 'USER', null, null, new Date(), 'USER', 'Revise'],
    ['COMPLETED', new Date(), 'USER', new Date(), 'USER', null, null, null],
  ] as const)(
    'rejects an invalid legacy %s row without rewriting it',
    async (
      status,
      staffCompletedAt,
      staffCompletedBy,
      managerApprovedAt,
      managerApprovedBy,
      revisionRequestedAt,
      revisionRequestedBy,
      revisionReason,
    ) => {
      await withIsolatedSchema(async (client) => {
        const { organizationId, userId } = await createOrganizationAndUser(client, `Legacy ${status}`);
        const jobCard = await client.query<{ id: string }>(
          `INSERT INTO job_cards (
             organization_id, type, status, title, assigned_to, created_by,
             staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
             revision_requested_at, revision_requested_by, revision_reason
           ) VALUES ($1, 'GENERAL_TASK', $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            organizationId,
            status,
            `Invalid legacy ${status} task`,
            userId,
            staffCompletedAt,
            staffCompletedBy === 'USER' ? userId : null,
            managerApprovedAt,
            managerApprovedBy === 'USER' ? userId : null,
            revisionRequestedAt,
            revisionRequestedBy === 'USER' ? userId : null,
            revisionReason,
          ],
        );

        await client.query('SAVEPOINT migration_006');
        await expect(client.query(sql)).rejects.toMatchObject({
          message: 'Cannot add started timestamp constraint: invalid JobCard rows exist',
        });
        await client.query('ROLLBACK TO SAVEPOINT migration_006');

        await expect(client.query<{ started_at: Date | null }>(
          'SELECT started_at FROM job_cards WHERE id = $1',
          [jobCard.rows[0]!.id],
        )).resolves.toMatchObject({ rows: [{ started_at: null }] });
      });
    },
  );

  it('accepts valid legacy rows and activates note and lifecycle constraints', async () => {
    await withIsolatedSchema(async (client) => {
      const first = await createOrganizationAndUser(client, 'Workspace One');
      const second = await createOrganizationAndUser(client, 'Workspace Two');

      const firstJobCard = await client.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by, planned_at
         ) VALUES ($1, 'GENERAL_TASK', 'PLANNED', 'Valid legacy planned task', $2, $2, NOW())
         RETURNING id`,
        [first.organizationId, first.userId],
      );
      await client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by, started_at
         ) VALUES ($1, 'GENERAL_TASK', 'IN_PROGRESS', 'Valid legacy started task', $2, $2, NOW())`,
        [first.organizationId, first.userId],
      );
      const secondJobCard = await client.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'Workspace task two', $2, $2) RETURNING id`,
        [second.organizationId, second.userId],
      );

      await expect(client.query(sql)).resolves.toBeDefined();

      await expect(client.query(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, 'A valid note') RETURNING id`,
        [first.organizationId, firstJobCard.rows[0]!.id, first.userId],
      )).resolves.toMatchObject({ rowCount: 1 });

      await expect(client.query(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [first.organizationId, firstJobCard.rows[0]!.id, first.userId, '\u200B'],
      )).resolves.toMatchObject({ rowCount: 1 });

      const rejectedNotes = ['   ', '\t', '\n', '\u00A0', '\u2028', '\u2029'];
      for (const [index, note] of rejectedNotes.entries()) {
        const savepoint = `blank_note_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        await expect(client.query(
          `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
           VALUES ($1, $2, $3, $4)`,
          [first.organizationId, firstJobCard.rows[0]!.id, first.userId, note],
        )).rejects.toMatchObject({ code: '23514' });
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }

      for (const [savepoint, organizationId, jobCardId, authorId] of [
        ['cross_author', first.organizationId, firstJobCard.rows[0]!.id, second.userId],
        ['cross_job', first.organizationId, secondJobCard.rows[0]!.id, first.userId],
      ] as const) {
        await client.query(`SAVEPOINT ${savepoint}`);
        await expect(client.query(
          `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
           VALUES ($1, $2, $3, 'Cross organization note')`,
          [organizationId, jobCardId, authorId],
        )).rejects.toMatchObject({ code: '23503' });
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }

      for (const [savepoint, status] of [
        ['planned_without_timestamp', 'PLANNED'],
        ['started_without_timestamp', 'IN_PROGRESS'],
      ] as const) {
        await client.query(`SAVEPOINT ${savepoint}`);
        await expect(client.query(
          `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
           VALUES ($1, 'GENERAL_TASK', $2, 'Invalid lifecycle task', $3, $3)`,
          [first.organizationId, status, first.userId],
        )).rejects.toMatchObject({ code: '23514' });
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    });
  });
});
