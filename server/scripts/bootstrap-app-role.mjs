#!/usr/bin/env node
/**
 * Create/update application role password without putting secrets on argv.
 *
 * Required env:
 *   ADMIN_DATABASE_URL  superuser/bootstrap connection (prefer peer/socket; may be URL without app password)
 *   APP_DB_PASSWORD     new password for application role (never logged)
 * Optional:
 *   APP_DB_ROLE         default servora
 *   APP_DB_NAME         default servora_med (created if missing, owned by role)
 *
 * Password is applied with a parameterized query ($1), not string interpolation or argv.
 */
import pg from 'pg';

const adminUrl = process.env.ADMIN_DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
const role = process.env.APP_DB_ROLE ?? 'servora';
const dbName = process.env.APP_DB_NAME ?? 'servora_med';

if (!adminUrl) {
  console.error('ADMIN_DATABASE_URL is required');
  process.exit(2);
}
if (!password) {
  console.error('APP_DB_PASSWORD is required');
  process.exit(2);
}
if (!/^[a-z][a-z0-9_]*$/.test(role) || !/^[a-z][a-z0-9_]*$/.test(dbName)) {
  console.error('invalid APP_DB_ROLE or APP_DB_NAME');
  process.exit(2);
}

for (const arg of process.argv.slice(2)) {
  if (arg.includes('postgresql://') || arg.includes('postgres://') || arg === password) {
    console.error('refuse: secrets must not be passed on argv');
    process.exit(2);
  }
}

const client = new pg.Client({ connectionString: adminUrl });

try {
  await client.connect();

  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) {
    // Identifier validated above. Create without password, then set password via bind
    // parameter so the secret is never interpolated into SQL text or process argv.
    await client.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
  }
  await client.query(
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD $1`,
    [password],
  );

  const flags = await client.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole
     FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  const row = flags.rows[0];
  if (!row || row.rolsuper || row.rolcreatedb || row.rolcreaterole) {
    console.error('role privilege check failed (must be NOSUPERUSER/NOCREATEDB/NOCREATEROLE)');
    process.exit(1);
  }

  const dbExists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (dbExists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${dbName} OWNER ${role}`);
  }

  console.log(`ok bootstrap-app-role role=${role} db=${dbName}`);
  process.exit(0);
} catch {
  console.error('bootstrap-app-role failed');
  process.exit(1);
} finally {
  try {
    await client.end();
  } catch {
    // ignore
  }
}
