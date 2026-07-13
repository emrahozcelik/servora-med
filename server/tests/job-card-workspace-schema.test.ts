import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
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

afterAll(async () => { await pool?.end(); });

describe.skipIf(!databaseUrl)('006 JobCard workspace PostgreSQL migration', () => {
  it('enforces organization-owned notes and lifecycle timestamps', async () => {
    const schema = `job_card_workspace_${randomUUID().replaceAll('-', '')}`;
    const client = await pool!.connect();

    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query('BEGIN');

      for (const migration of [
        '001_auth_foundation.sql',
        '002_delivery_tracer.sql',
        '003_people.sql',
        '004_crm_contacts.sql',
        '005_product_catalog.sql',
        '006_jobcard_workspace.sql',
      ]) {
        const migrationPath = fileURLToPath(
          new URL(`../src/db/migrations/${migration}`, import.meta.url),
        );
        await client.query(await readFile(migrationPath, 'utf8'));
      }

      const firstOrganization = await client.query<{ id: string }>(
        "INSERT INTO organizations (name) VALUES ('Workspace One') RETURNING id",
      );
      const secondOrganization = await client.query<{ id: string }>(
        "INSERT INTO organizations (name) VALUES ('Workspace Two') RETURNING id",
      );
      const firstOrganizationId = firstOrganization.rows[0]!.id;
      const secondOrganizationId = secondOrganization.rows[0]!.id;

      const firstUser = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Workspace Staff One', $2, 'test-hash', 'STAFF') RETURNING id`,
        [firstOrganizationId, `${randomUUID()}@test.local`],
      );
      const secondUser = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Workspace Staff Two', $2, 'test-hash', 'STAFF') RETURNING id`,
        [secondOrganizationId, `${randomUUID()}@test.local`],
      );
      const firstUserId = firstUser.rows[0]!.id;
      const secondUserId = secondUser.rows[0]!.id;

      const firstJobCard = await client.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'Workspace task one', $2, $2) RETURNING id`,
        [firstOrganizationId, firstUserId],
      );
      const secondJobCard = await client.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'Workspace task two', $2, $2) RETURNING id`,
        [secondOrganizationId, secondUserId],
      );
      const firstJobCardId = firstJobCard.rows[0]!.id;
      const secondJobCardId = secondJobCard.rows[0]!.id;

      await expect(client.query(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, 'A valid note') RETURNING id`,
        [firstOrganizationId, firstJobCardId, firstUserId],
      )).resolves.toMatchObject({ rowCount: 1 });

      await client.query('SAVEPOINT cross_author');
      await expect(client.query(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, 'Cross organization author')`,
        [firstOrganizationId, firstJobCardId, secondUserId],
      )).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT cross_author');

      await client.query('SAVEPOINT cross_job');
      await expect(client.query(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, 'Cross organization job')`,
        [firstOrganizationId, secondJobCardId, firstUserId],
      )).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT cross_job');

      await client.query('SAVEPOINT blank_note');
      await expect(client.query(
        `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, '   ')`,
        [firstOrganizationId, firstJobCardId, firstUserId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT blank_note');

      await client.query('SAVEPOINT planned_without_timestamp');
      await expect(client.query(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'PLANNED', 'Invalid planned task', $2, $2)`,
        [firstOrganizationId, firstUserId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT planned_without_timestamp');

      await client.query('SAVEPOINT started_without_timestamp');
      await expect(client.query(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'IN_PROGRESS', 'Invalid started task', $2, $2)`,
        [firstOrganizationId, firstUserId],
      )).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT started_without_timestamp');
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
