import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const schema = `duprace_${randomUUID().replaceAll('-', '')}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const org = randomUUID();
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const contactId = '10000000-0000-4000-8000-0000000000c1';

async function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function eventuallySettled<T>(promise: Promise<T>, ms = 400) {
  let settled = false;
  void promise.finally(() => { settled = true; });
  await delay(ms);
  return settled;
}

beforeAll(async () => {
  if (!pool || !admin) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool) });
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic race')", [org]);
  await pool.query(`INSERT INTO customers(id,organization_id,name,customer_type,status,data_class)
    VALUES($1,$3,'Sentetik Klinik','clinic','active','BUSINESS'),($2,$3,'SENTETİK KLİNİK','clinic','active','BUSINESS')`, [a, b, org]);
  await pool.query(`INSERT INTO contacts(id,organization_id,customer_id,name,is_active)
    VALUES($1,$2,$3,'Sentetik Kişi',true)`, [contactId, org, a]);
});

afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

it.skipIf(!databaseUrl)('TX-03: parent FOR UPDATE blocks a new Contact phantom (importer-style FK insert)', async () => {
  const lockClient = await pool!.connect();
  const insertClient = await pool!.connect();
  try {
    await lockClient.query('BEGIN');
    await lockClient.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, a]);
    const phantom = insertClient.query(
      `INSERT INTO contacts(id,organization_id,customer_id,name,is_active)
       VALUES($1,$2,$3,'Sentetik Phantom',true)`, [randomUUID(), org, a],
    );
    expect(await eventuallySettled(phantom)).toBe(false);
    await lockClient.query('COMMIT');
    await phantom;
    expect((await pool!.query("SELECT 1 FROM contacts WHERE organization_id=$1 AND name='Sentetik Phantom'", [org])).rowCount).toBe(1);
  } finally {
    await lockClient.query('ROLLBACK').catch(() => {});
    await insertClient.query('ROLLBACK').catch(() => {});
    lockClient.release(); insertClient.release();
    await pool!.query("DELETE FROM contacts WHERE organization_id=$1 AND name='Sentetik Phantom'", [org]);
  }
});

it.skipIf(!databaseUrl)('TX-04: a delete between pre-read and final Contact lock removes membership from the locked facts', async () => {
  const reader = await pool!.connect();
  const writer = await pool!.connect();
  try {
    await reader.query('BEGIN');
    const pre = await reader.query<{ id: string }>(
      'SELECT id FROM contacts WHERE organization_id=$1 AND customer_id=$2 ORDER BY id', [org, a],
    );
    expect(pre.rows.map((row) => row.id)).toContain(contactId);
    await writer.query('DELETE FROM contacts WHERE organization_id=$1 AND id=$2', [org, contactId]);
    const final = await reader.query<{ id: string }>(
      'SELECT id FROM contacts WHERE organization_id=$1 AND customer_id=$2 AND id=ANY($3::uuid[]) ORDER BY id',
      [org, a, pre.rows.map((row) => row.id)],
    );
    expect(final.rows).toEqual([]);
    await reader.query('COMMIT');
  } finally {
    await reader.query('ROLLBACK').catch(() => {});
    writer.release(); reader.release();
    await pool!.query(`INSERT INTO contacts(id,organization_id,customer_id,name,is_active)
      VALUES($1,$2,$3,'Sentetik Kişi',true) ON CONFLICT (id) DO NOTHING`, [contactId, org, a]);
  }
});

it.skipIf(!databaseUrl)('TX-04: final Contact FOR SHARE makes a concurrent delete wait until the review releases', async () => {
  const lockClient = await pool!.connect();
  const deleteClient = await pool!.connect();
  try {
    await lockClient.query('BEGIN');
    await lockClient.query('SELECT id FROM contacts WHERE organization_id=$1 AND id=$2 FOR SHARE', [org, contactId]);
    const deletion = deleteClient.query('DELETE FROM contacts WHERE organization_id=$1 AND id=$2', [org, contactId]);
    expect(await eventuallySettled(deletion)).toBe(false);
    await lockClient.query('COMMIT');
    await deletion;
    expect((await pool!.query('SELECT 1 FROM contacts WHERE organization_id=$1 AND id=$2', [org, contactId])).rowCount).toBe(0);
  } finally {
    await lockClient.query('ROLLBACK').catch(() => {});
    lockClient.release(); deleteClient.release();
    await pool!.query(`INSERT INTO contacts(id,organization_id,customer_id,name,is_active)
      VALUES($1,$2,$3,'Sentetik Kişi',true) ON CONFLICT (id) DO NOTHING`, [contactId, org, a]);
  }
});
