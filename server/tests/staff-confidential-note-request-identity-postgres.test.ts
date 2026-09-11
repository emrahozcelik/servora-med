import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresStaffConfidentialNotesRepository } from '../src/modules/staff-confidential-notes/repository.js';
import { confidentialNoteAddRequestHash } from '../src/modules/staff-confidential-notes/request-hash.js';
import { StaffConfidentialNotesService } from '../src/modules/staff-confidential-notes/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type Fixture = {
  pool: Pool;
  organizationId: string;
  admin: SafeUser;
  staffId: string;
  staffBId: string;
  service: StaffConfidentialNotesService;
  published: unknown[];
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `b2note_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
      logger: { info: () => undefined, error: () => undefined },
    });

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('B2NOTE org') RETURNING id`,
    )).rows[0]!.id;
    const adminId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'B2NOTE Admin', $2, 'test-hash', 'ADMIN') RETURNING id`,
      [organizationId, `${randomUUID()}@b2note.test`],
    )).rows[0]!.id;
    const staffId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'B2NOTE Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@b2note.test`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Satış Temsilcisi')`,
      [organizationId, staffId],
    );
    const staffBId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'B2NOTE Staff B', $2, 'test-hash', 'STAFF') RETURNING id`,
      [organizationId, `${randomUUID()}@b2note.test`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Satış Temsilcisi')`,
      [organizationId, staffBId],
    );

    const published: unknown[] = [];
    const repository = new PostgresStaffConfidentialNotesRepository(pool);
    const admin: SafeUser = {
      id: adminId, organizationId, name: 'B2NOTE Admin', email: 'admin@b2note.test',
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    };
    await run({
      pool,
      organizationId,
      admin,
      staffId,
      staffBId,
      service: new StaffConfidentialNotesService(
        repository,
        { publish: (event) => published.push(event) },
        () => new Date('2026-09-11T10:00:00.000Z'),
      ),
      published,
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

type Snapshot = {
  notes: string;
  processed: string;
  audits: string;
  realtime: string;
};

async function snapshot(pool: Pool, organizationId: string): Promise<Snapshot> {
  const result = await pool.query<Snapshot>(
    `SELECT
       (SELECT COUNT(*)::text FROM staff_confidential_notes WHERE organization_id = $1) AS notes,
       (SELECT COUNT(*)::text FROM processed_actions WHERE organization_id = $1) AS processed,
       (SELECT COUNT(*)::text FROM audit_events WHERE organization_id = $1) AS audits,
       (SELECT COUNT(*)::text FROM realtime_events WHERE organization_id = $1) AS realtime`,
    [organizationId],
  );
  return result.rows[0]!;
}

function operationKey(subjectStaffUserId: string) {
  return `STAFF_CONFIDENTIAL_NOTE_CREATE:${subjectStaffUserId}`;
}

describe.skipIf(!databaseUrl)('B2-NOTE staff confidential-note request identity', () => {
  it('A/B/C/H: replays exact and normalization-equivalent ADDs, rejects a changed note, stores a verifiable hash', async () => {
    await withFixture(async ({ pool, organizationId, admin, staffId, service, published }) => {
      const first = await service.createNote(admin, staffId, {
        clientActionId: 'b2note-exact',
        body: 'B2NOTE first note',
      });
      expect(first.body).toBe('B2NOTE first note');
      const afterCreate = await snapshot(pool, organizationId);
      expect(afterCreate).toEqual({ notes: '1', processed: '1', audits: '1', realtime: '1' });
      expect(published).toHaveLength(1);

      // H: the new claim row carries a deterministic lowercase SHA-256 digest
      // of the normalized semantic request.
      const stored = (await pool.query<{ request_hash: string | null }>(
        `SELECT request_hash FROM processed_actions
          WHERE organization_id = $1 AND client_action_id = 'b2note-exact'`,
        [organizationId],
      )).rows[0]!.request_hash;
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).toBe(confidentialNoteAddRequestHash(staffId, 'B2NOTE first note'));

      // A: exact same normalized semantic request replays the same success
      // with zero additional side effects.
      const replayed = await service.createNote(admin, staffId, {
        clientActionId: 'b2note-exact',
        body: 'B2NOTE first note',
      });
      expect(replayed).toEqual(first);
      expect(await snapshot(pool, organizationId)).toEqual(afterCreate);
      expect(published).toHaveLength(1);

      // C: leading/trailing whitespace normalizes away, so this is the SAME
      // semantic request and must replay rather than fail.
      const trimmed = await service.createNote(admin, staffId, {
        clientActionId: 'b2note-exact',
        body: '  B2NOTE first note  ',
      });
      expect(trimmed).toEqual(first);
      expect(await snapshot(pool, organizationId)).toEqual(afterCreate);
      expect(published).toHaveLength(1);

      // B: same key + changed normalized note must fail closed with
      // CLIENT_ACTION_REUSED / 409 and zero additional side effects.
      await expect(service.createNote(admin, staffId, {
        clientActionId: 'b2note-exact',
        body: 'B2NOTE changed note',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterCreate);
      expect(published).toHaveLength(1);

      // Normalization is trim-only (unchanged by B2-NOTE): repeated internal
      // whitespace survives normalization, so it is a different semantic
      // request and must also fail closed.
      await expect(service.createNote(admin, staffId, {
        clientActionId: 'b2note-exact',
        body: 'B2NOTE   first   note',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterCreate);
      expect(published).toHaveLength(1);
    });
  });

  it('D: fails closed on a legacy NULL request_hash row', async () => {
    await withFixture(async ({ pool, organizationId, admin, staffId, service, published }) => {
      await pool.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash,
            status, status_code, response_body, completed_at)
         VALUES ($1, $2, 'b2note-legacy', $3, NULL, 'completed', 200,
           '{"id":"legacy-note","body":"legacy"}'::jsonb, NOW())`,
        [organizationId, admin.id, operationKey(staffId)],
      );
      const afterLegacy = await snapshot(pool, organizationId);

      await expect(service.createNote(admin, staffId, {
        clientActionId: 'b2note-legacy',
        body: 'B2NOTE legacy attempt',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterLegacy);
      expect(published).toHaveLength(0);
    });
  });

  it('E/F: preserves ACTION_IN_PROGRESS for exact requests, rejects changed requests', async () => {
    await withFixture(async ({ pool, organizationId, admin, staffId, service, published }) => {
      // E: a matching request_hash against a live IN_PROGRESS row keeps the
      // existing ACTION_IN_PROGRESS behavior.
      await pool.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash, status)
         VALUES ($1, $2, 'b2note-inflight-exact', $3, $4, 'processing')`,
        [
          organizationId,
          admin.id,
          operationKey(staffId),
          confidentialNoteAddRequestHash(staffId, 'B2NOTE inflight note'),
        ],
      );
      const afterSeed = await snapshot(pool, organizationId);
      await expect(service.createNote(admin, staffId, {
        clientActionId: 'b2note-inflight-exact',
        body: 'B2NOTE inflight note',
      })).rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterSeed);

      // F: a changed request must never inherit ACTION_IN_PROGRESS from
      // another semantic request merely because the key collided.
      await pool.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash, status)
         VALUES ($1, $2, 'b2note-inflight-changed', $3, $4, 'processing')`,
        [
          organizationId,
          admin.id,
          operationKey(staffId),
          confidentialNoteAddRequestHash(staffId, 'B2NOTE other note'),
        ],
      );
      const afterSecondSeed = await snapshot(pool, organizationId);
      await expect(service.createNote(admin, staffId, {
        clientActionId: 'b2note-inflight-changed',
        body: 'B2NOTE inflight note',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot(pool, organizationId)).toEqual(afterSecondSeed);
      expect(published).toHaveLength(0);
    });
  });

  it('G: keeps the idempotency namespace per staff subject', async () => {
    await withFixture(async ({ pool, organizationId, admin, staffId, staffBId, service }) => {
      const first = await service.createNote(admin, staffId, {
        clientActionId: 'b2note-shared',
        body: 'B2NOTE subject one',
      });
      const second = await service.createNote(admin, staffBId, {
        clientActionId: 'b2note-shared',
        body: 'B2NOTE subject two',
      });
      expect(second.id).not.toBe(first.id);
      expect(second.staffUserId).toBe(staffBId);
      expect(await snapshot(pool, organizationId)).toEqual({
        notes: '2', processed: '2', audits: '2', realtime: '2',
      });
      const rows = (await pool.query<{ operation_key: string; request_hash: string | null }>(
        `SELECT operation_key, request_hash FROM processed_actions
          WHERE organization_id = $1 AND client_action_id = 'b2note-shared'`,
        [organizationId],
      )).rows;
      expect(rows).toHaveLength(2);
      const byKey = new Map(rows.map((row) => [row.operation_key, row.request_hash]));
      expect(byKey.get(operationKey(staffId))).toBe(
        confidentialNoteAddRequestHash(staffId, 'B2NOTE subject one'),
      );
      expect(byKey.get(operationKey(staffBId))).toBe(
        confidentialNoteAddRequestHash(staffBId, 'B2NOTE subject two'),
      );
      expect(byKey.get(operationKey(staffId))).not.toBe(byKey.get(operationKey(staffBId)));
    });
  });
});
