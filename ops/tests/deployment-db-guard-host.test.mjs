import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { withDeploymentDatabaseLock } from '../scripts/deployment-db-guard.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

assert.equal(hostname(), 'lima-servora-r4-20261012');
assert.notEqual(process.getuid(), 0);
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/servora_med_test_r4_host');
const releaseDirectory='/opt/servora-med/releases/e4ca2b19f7865dca3f1e4597dd099ed167667a19';
const { Pool }=createRequire(`${releaseDirectory}/server/package.json`)('pg');

test('rejects another cluster identity even with the exact same migration history', async () => {
  const pool=new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const identity=(await pool.query(`SELECT (pg_control_system()).system_identifier::text AS "clusterId",
      current_database() AS "databaseName", (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",
      current_user AS role, host(inet_server_addr()) AS host, inet_server_port() AS port`)).rows[0];
    const catalog=(await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC')).rows.map(r=>r.version);
    let called=false;
    await assert.rejects(withDeploymentDatabaseLock({ releaseDirectory,
      expectedIdentity:{...identity,clusterId:'1'},expectedCatalog:catalog },
    async () => {called=true;}), /RECOVERY_DATABASE_IDENTITY_MISMATCH/);
    assert.equal(called,false);
  } finally {await pool.end();}
});

test('the service-UID guard holds the real migration lock until the root protocol releases it', {timeout:10000}, async () => {
  const pool = new Pool({connectionString:process.env.DATABASE_URL});
  const client = await pool.connect();
  let child;
  try {
    const identity = (await client.query(`SELECT (pg_control_system()).system_identifier::text AS "clusterId",
      current_database() AS "databaseName", (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",
      current_user AS role, host(inet_server_addr()) AS host, inet_server_port() AS port`)).rows[0];
    const catalog = (await client.query('SELECT version FROM schema_migrations ORDER BY version ASC')).rows.map(row => row.version);
    child = spawn('/usr/bin/node',['/usr/local/libexec/servora-med/deployment-db-guard.mjs','--hold'],{stdio:['pipe','pipe','pipe']});
    const exit = once(child,'exit');
    const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
    child.stdin.write(JSON.stringify({releaseDirectory,expectedIdentity:identity,expectedCatalog:catalog})+'\n');
    assert.equal((await lines.next()).value,'READY');
    assert.equal((await client.query('SELECT pg_try_advisory_lock(872014011) AS locked')).rows[0].locked,false);
    child.stdin.write('CHECK\n');
    assert.equal((await lines.next()).value,'EXACT');
    child.stdin.end('RELEASE\n');
    assert.deepEqual(await exit,[0,null]);
    assert.equal((await client.query('SELECT pg_try_advisory_lock(872014011) AS locked')).rows[0].locked,true);
    await client.query('SELECT pg_advisory_unlock(872014011)');
  } finally { child?.kill(); client.release(); await pool.end(); }
});
