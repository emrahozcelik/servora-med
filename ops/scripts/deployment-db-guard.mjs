/** Unprivileged DB identity/catalog guard. No SQL mutation or migration.
 * The trusted host controller must verify the immutable release before calling
 * this service-UID probe; this module does not make a release authoritative.
 */
import { createRequire } from 'node:module';
import { classifyMigrationState } from './migration-reconciliation.mjs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const MIGRATION_LOCK = 872_014_011; // Same key as PostgresMigrationStore.
const IDENTITY_KEYS = ['clusterId', 'databaseName', 'databaseOid', 'role', 'host', 'port'];

/** Aggregate, non-sensitive business invariants used to prove that a
 * migration did not move business data. Single source of truth shared with
 * migration-state.mjs; read-only and never selects row contents.
 */
export const BUSINESS_INVARIANT_KEYS = Object.freeze(
  ['organizations', 'admins', 'staff', 'customers', 'products', 'jobs', 'demo_data']);
export const BUSINESS_DATA_INVARIANTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM organizations)::bigint AS organizations,
    (SELECT COUNT(*) FROM users WHERE role = 'ADMIN')::bigint AS admins,
    (SELECT COUNT(*) FROM staff_profiles)::bigint AS staff,
    (SELECT COUNT(*) FROM customers)::bigint AS customers,
    (SELECT COUNT(*) FROM products)::bigint AS products,
    (SELECT COUNT(*) FROM job_cards)::bigint AS jobs,
    (
      (SELECT COUNT(*) FROM demo_datasets WHERE status = 'ACTIVE')
      + (SELECT COUNT(*) FROM users WHERE data_class = 'DEMO')
      + (SELECT COUNT(*) FROM customers WHERE data_class = 'DEMO')
      + (SELECT COUNT(*) FROM products WHERE data_class = 'DEMO')
      + (SELECT COUNT(*) FROM job_cards WHERE data_class = 'DEMO')
      + (SELECT COUNT(*) FROM conversations WHERE data_class = 'DEMO')
      + (SELECT COUNT(*) FROM calendar_events WHERE data_class = 'DEMO')
    )::bigint AS demo_data`;

export function validateBusinessInvariantCounts(row) {
  const counts = {};
  for (const key of BUSINESS_INVARIANT_KEYS) {
    const value = Number(row?.[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('RECOVERY_DATABASE_INVARIANTS_INVALID');
    counts[key] = value;
  }
  return counts;
}

export function validateDatabaseIdentity(expectedIdentity) {
  if (!expectedIdentity || Object.keys(expectedIdentity).length !== IDENTITY_KEYS.length
    || IDENTITY_KEYS.some(key => !Object.hasOwn(expectedIdentity,key))
    || typeof expectedIdentity.clusterId !== 'string' || !/^[1-9][0-9]*$/.test(expectedIdentity.clusterId)
    || typeof expectedIdentity.databaseOid !== 'string' || !/^[1-9][0-9]*$/.test(expectedIdentity.databaseOid)
    || !['databaseName', 'role'].every(key => typeof expectedIdentity[key] === 'string' && /^[a-z_][a-z0-9_]*$/.test(expectedIdentity[key]))
    || expectedIdentity.host !== '127.0.0.1'
    || !Number.isInteger(expectedIdentity.port) || expectedIdentity.port < 1 || expectedIdentity.port > 65535) {
    throw new Error('RECOVERY_DATABASE_EXPECTATION_INVALID');
  }
  return expectedIdentity;
}

export async function withDeploymentDatabaseLock(options, operation) {
  if (process.getuid?.() === 0) throw new Error('RECOVERY_DATABASE_ROOT_EXECUTION_FORBIDDEN');
  const { releaseDirectory, expectedIdentity, expectedCatalog } = options;
  validateDatabaseIdentity(expectedIdentity);
  if (typeof releaseDirectory !== 'string'
    || !/^\/opt\/servora-med\/releases\/[0-9a-f]{40}$/.test(releaseDirectory)
    || !Array.isArray(expectedCatalog)
    || classifyMigrationState(expectedCatalog, expectedCatalog).status !== 'EXACT') {
    throw new Error('RECOVERY_DATABASE_EXPECTATION_INVALID');
  }
  let url;
  try { url = new URL(process.env.DATABASE_URL); } catch { throw new Error('RECOVERY_DATABASE_CONFIGURATION_INVALID'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== expectedIdentity.host
    || Number(url.port || 5432) !== expectedIdentity.port || url.search || url.hash || !url.password
    || decodeURIComponent(url.username) !== expectedIdentity.role
    || decodeURIComponent(url.pathname.slice(1)) !== expectedIdentity.databaseName) {
    throw new Error('RECOVERY_DATABASE_CONFIGURATION_INVALID');
  }
  const { Client } = createRequire(`${releaseDirectory}/server/package.json`)('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'servora-med-recovery-guard' });
  let locked = false;
  let lost = false;
  let notifyDisconnect;
  const disconnected = new Promise(resolve => { notifyDisconnect = resolve; });
  client.on('error', () => { lost = true; notifyDisconnect(); });
  const assertExact = async () => {
    if (lost) throw new Error('RECOVERY_DATABASE_PROBE_FAILED');
    const identity = (await client.query(`SELECT (pg_control_system()).system_identifier::text AS "clusterId",
      current_database() AS "databaseName", (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",
      current_user AS role, host(inet_server_addr()) AS host, inet_server_port() AS port`)).rows[0];
    if (IDENTITY_KEYS.some(key => identity[key] !== expectedIdentity[key])) throw new Error('RECOVERY_DATABASE_IDENTITY_MISMATCH');
    const applied = (await client.query('SELECT version FROM public.schema_migrations ORDER BY version ASC')).rows.map(row => row.version);
    if (classifyMigrationState(expectedCatalog, applied).status !== 'EXACT') throw new Error('RECOVERY_DATABASE_NOT_EXACT');
    return { identity, applied };
  };
  const readInvariants = async () => {
    if (lost) throw new Error('RECOVERY_DATABASE_PROBE_FAILED');
    const counts = validateBusinessInvariantCounts((await client.query(BUSINESS_DATA_INVARIANTS_SQL)).rows[0]);
    return Object.fromEntries(BUSINESS_INVARIANT_KEYS.map(key => [key, counts[key]]));
  };
  try {
    await client.connect();
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK])).rows[0].locked;
    if (!locked) throw new Error('RECOVERY_DATABASE_LOCK_BUSY');
    const {identity,applied} = await assertExact();
    return await operation({ identity, applied, assertExact, readInvariants, disconnected });
  } catch (error) {
    // Do not propagate pg/URL errors with connection details to root logs.
    if (['RECOVERY_DATABASE_IDENTITY_MISMATCH', 'RECOVERY_DATABASE_LOCK_BUSY', 'RECOVERY_DATABASE_NOT_EXACT',
      'RECOVERY_DATABASE_INVARIANTS_INVALID'].includes(error.message)) throw error;
    throw new Error('RECOVERY_DATABASE_PROBE_FAILED');
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); } catch { /* disconnect releases session lock */ }
    }
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--hold') throw new Error('RECOVERY_DATABASE_PROTOCOL_INVALID');
    const input = createInterface({input:process.stdin,crlfDelay:Infinity});
    const lines = input[Symbol.asyncIterator]();
    const first = (await lines.next()).value;
    if (typeof first !== 'string' || Buffer.byteLength(first) > 32768) throw new Error('RECOVERY_DATABASE_PROTOCOL_INVALID');
    const options = JSON.parse(first);
    if (Object.keys(options).length !== 3 || !['releaseDirectory','expectedIdentity','expectedCatalog'].every(key => Object.hasOwn(options,key))) {
      throw new Error('RECOVERY_DATABASE_PROTOCOL_INVALID');
    }
    await withDeploymentDatabaseLock(options, async ({assertExact,readInvariants,disconnected}) => {
      process.stdout.write('READY\n');
      for (let count = 0; count < 1000; count++) {
        const next = await Promise.race([lines.next(), disconnected.then(() => { throw new Error('RECOVERY_DATABASE_PROBE_FAILED'); })]);
        if (next.done || next.value === 'RELEASE') return;
        if (next.value === 'CHECK') { await assertExact(); process.stdout.write('EXACT\n'); continue; }
        if (next.value === 'COUNTS') {
          await assertExact();
          process.stdout.write('COUNTS='+JSON.stringify(await readInvariants())+'\n');
          continue;
        }
        throw new Error('RECOVERY_DATABASE_PROTOCOL_INVALID');
      }
      throw new Error('RECOVERY_DATABASE_PROTOCOL_INVALID');
    });
    input.close();
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'RECOVERY_DATABASE_PROBE_FAILED');
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
