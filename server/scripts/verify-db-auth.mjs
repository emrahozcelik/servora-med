#!/usr/bin/env node
/**
 * Pilot DB auth verification — secrets only via environment (never argv).
 *
 * Required env:
 *   DATABASE_URL  password-bearing URL (or other libpq-compatible form)
 *
 * Optional:
 *   EXPECT_USER   default: any non-empty current_user (set to "servora" for pilot)
 *   EXPECT_FAIL   if "1", connection must fail with PostgreSQL 28P01 (wrong password)
 *
 * Usage:
 *   env -i PATH=... DATABASE_URL='postgresql://...' node server/scripts/verify-db-auth.mjs
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
const expectUser = process.env.EXPECT_USER ?? '';
const expectFail = process.env.EXPECT_FAIL === '1';

if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

// Refuse accidental argv secrets (operator footgun).
for (const arg of process.argv.slice(2)) {
  if (arg.includes('postgresql://') || arg.includes('postgres://')) {
    console.error('refuse: connection string must not be passed on argv');
    process.exit(2);
  }
}

const client = new pg.Client({ connectionString: url });

let connected = false;
try {
  await client.connect();
  connected = true;
  if (expectFail) {
    console.error('expected connection failure but connected');
    process.exit(1);
  }
  const result = await client.query('SELECT current_user AS user, current_database() AS db');
  const user = result.rows[0]?.user;
  if (!user) {
    console.error('current_user missing');
    process.exit(1);
  }
  if (expectUser && user !== expectUser) {
    console.error(`expected current_user=${expectUser}, got ${user}`);
    process.exit(1);
  }
  // Do not print secrets or full URL — only identity labels.
  console.log(`ok db-auth user=${user}`);
  process.exit(0);
} catch (error) {
  if (expectFail && !connected && error?.code === '28P01') {
    console.log('ok db-auth expected-failure code=28P01');
    process.exit(0);
  }
  console.error('db-auth failed');
  process.exit(1);
} finally {
  try {
    await client.end();
  } catch {
    // ignore close errors
  }
}
