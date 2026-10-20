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
