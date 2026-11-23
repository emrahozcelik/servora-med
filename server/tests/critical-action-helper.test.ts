import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { runCriticalAction } from '../src/db/critical-action.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `critical_${randomUUID().replaceAll('-', '')}`;
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const org = randomUUID();
const actor = randomUUID();

beforeAll(async () => {
  if (!pool || !admin) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool) });
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic')", [org]);
  await pool.query("INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,'Actor','critical@example.invalid','unused','ADMIN')", [actor, org]);
});

afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

it.skipIf(!databaseUrl)('TX-12: opt-in statement/lock timeouts apply before the receipt claim', async () => {
  const claim = { organizationId: org, userId: actor, clientActionId: randomUUID(), operationKey: 'CRM_TEST', requestHash: 'a'.repeat(64) };
  await expect(runCriticalAction(pool!, claim, async (client) => {
    const settings = await client.query<{ statement_timeout: string; lock_timeout: string }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout",
    );
    expect(settings.rows[0]).toEqual({ statement_timeout: '2s', lock_timeout: '250ms' });
    await client.query('SELECT pg_sleep(3)');
    return { response: { ok: true }, realtimeEvents: [] };
  }, { statementTimeoutMs: 2000, lockTimeoutMs: 250 })).rejects.toMatchObject({ code: '57014' });
  expect((await pool!.query('SELECT 1 FROM processed_actions WHERE organization_id=$1 AND client_action_id=$2', [org, claim.clientActionId])).rowCount).toBe(0);
});

it.skipIf(!databaseUrl)('TX-05: a completion update with zero rows is a hard rollback, never a committed receipt', async () => {
  const claim = { organizationId: org, userId: actor, clientActionId: randomUUID(), operationKey: 'CRM_TEST', requestHash: 'b'.repeat(64) };
  await expect(runCriticalAction(pool!, claim, async (client) => {
    await client.query('DELETE FROM processed_actions WHERE organization_id=$1 AND user_id=$2 AND client_action_id=$3 AND operation_key=$4',
      [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey]);
    return { response: { ok: true }, realtimeEvents: [] };
  })).rejects.toMatchObject({ code: 'CRITICAL_ACTION_RECEIPT_INCOMPLETE' });
  expect((await pool!.query('SELECT 1 FROM processed_actions WHERE organization_id=$1 AND client_action_id=$2', [org, claim.clientActionId])).rowCount).toBe(0);
});

/**
 * A deadlock or serialization failure rolled back the whole attempt, so nothing
 * was claimed and the identical request (same clientActionId) can be replayed.
 * It must never surface as an opaque 500 / raw SQLSTATE.
 */
it.skipIf(!databaseUrl)('TX-13: 40P01 and 40001 map to the retryable 409 and the receipt is released', async () => {
  for (const code of ['40P01', '40001']) {
    const claim = {
      organizationId: org, userId: actor, clientActionId: randomUUID(),
      operationKey: `CRM_RETRY_${code}`, requestHash: 'c'.repeat(64),
    };
    await expect(runCriticalAction(pool!, claim, async (client) => {
      await client.query(
        `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='${code}', MESSAGE='synthetic ${code}'; END $$`,
      );
      return { response: { ok: true }, realtimeEvents: [] };
    })).rejects.toMatchObject({
      code: 'ACTION_IN_PROGRESS',
      statusCode: 409,
      message: 'İşlem başka bir işlemle çakıştı. Aynı istekle yeniden deneyin.',
    });
    expect((await pool!.query(
      'SELECT 1 FROM processed_actions WHERE organization_id=$1 AND user_id=$2 AND client_action_id=$3',
      [org, actor, claim.clientActionId],
    )).rowCount).toBe(0);
    // The same identity is retryable: the receipt claim is not left behind.
    await expect(runCriticalAction(pool!, claim, async () => (
      { response: { ok: true }, realtimeEvents: [] }
    ))).resolves.toMatchObject({ kind: 'completed' });
  }
});

it.skipIf(!databaseUrl)('TX-14: a real deadlock aborts the loser with the retryable 409, never a raw 40P01', async () => {
  await pool!.query('CREATE TABLE IF NOT EXISTS deadlock_probe (id integer PRIMARY KEY)');
  await pool!.query('INSERT INTO deadlock_probe (id) VALUES (1),(2) ON CONFLICT DO NOTHING');
  let firstLocks = 0;
  let release!: () => void;
  const bothFirstLocks = new Promise<void>((resolve) => { release = resolve; });
  const run = (order: readonly number[], suffix: string) => runCriticalAction(
    pool!,
    {
      organizationId: org, userId: actor, clientActionId: randomUUID(),
      operationKey: `CRM_DEADLOCK_${suffix}`,
    },
    async (client) => {
      // Both sides hold their first row lock before either asks for the other,
      // so the second requests necessarily form a deadlock cycle.
      await client.query('SELECT id FROM deadlock_probe WHERE id=$1 FOR UPDATE', [order[0]]);
      firstLocks += 1;
      if (firstLocks === 2) release();
      await bothFirstLocks;
      await client.query('SELECT id FROM deadlock_probe WHERE id=$1 FOR UPDATE', [order[1]]);
      return { response: { ok: true }, realtimeEvents: [] };
    },
  );
  const settled = await Promise.allSettled([run([1, 2], 'A'), run([2, 1], 'B')]);
  const rejected = settled.filter((result) => result.status === 'rejected');
  expect(rejected).toHaveLength(1);
  // The loser is the retryable 409; the raw driver SQLSTATE never escapes.
  expect(rejected[0]!.reason).toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });
  expect((rejected[0]!.reason as { code?: string }).code).not.toBe('40P01');
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
});

it.skipIf(!databaseUrl)('TX-15: a failing ROLLBACK never replaces the original failure', async () => {
  const claim = { organizationId: org, userId: actor, clientActionId: randomUUID(), operationKey: 'CRM_TEST' };
  await expect(runCriticalAction(pool!, claim, async (client) => {
    // The terminated backend ends the socket asynchronously; keep that expected
    // disconnection from becoming an unhandled 'error' event.
    client.on('error', () => {});
    await client.query('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => {});
    throw new Error('original failure');
  })).rejects.toThrow('original failure');
  expect((await pool!.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
});
