#!/usr/bin/env node

/**
 * Runtime setup script for Servora-Med development/checkpoint work.
 *
 * One-command database reset + seed:
 *   npx tsx scripts/dev-runtime-setup.ts
 *
 * What it does:
 *   1. Drops and recreates the configured DATABASE_URL database
 *   2. Runs all migrations
 *   3. Seeds Admin, Manager, Staff, and inactive Manager users
 *   4. Creates a test GENERAL_TASK JobCard (ACCEPTED, assigned to Staff)
 *   5. Prints a summary table of all IDs, emails, and the shared password
 *
 * Prerequisites:
 *   - PostgreSQL running locally (socket or TCP)
 *   - .env file with DATABASE_URL (postgresql:///dbname?host=/tmp or similar)
 *
 * The script connects to the *default* postgres database to drop/recreate the
 * target database, then reconnects to the target for migrations and seed.
 *
 * All synthetic users share the same password (default: TestPass12345! unless
 * overridden via DEV_SEED_PASSWORD env var).
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in environment.`);
  return value;
}

const TARGET_DATABASE_URL = required('DATABASE_URL');
const DEV_SEED_PASSWORD = process.env.DEV_SEED_PASSWORD?.trim() || 'TestPass12345!';

// Detect preferred admin connection: strip the db name and connect to 'postgres'.
// e.g. postgresql:///servora_med_dev?host=/tmp → postgresql:///postgres?host=/tmp
function adminUrl(targetUrl: string): string {
  const u = new URL(targetUrl);
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must be a postgresql:// or postgres:// URL');
  }
  u.pathname = '/postgres';
  return u.toString();
}

const ADMIN_URL = adminUrl(TARGET_DATABASE_URL);
const MIGRATIONS_DIR = join(
  fileURLToPath(import.meta.url), '..', '..', 'src', 'db', 'migrations',
);

// SCrypt imports from the project's auth module (E SM dynamic import).
async function hashPass(password: string): Promise<string> {
  const { hashPassword } = await import('../src/modules/auth/crypto.js');
  return hashPassword(password);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dropCreateTarget(adminPool: Pool, targetDb: string): Promise<void> {
  const target = targetDb.replace(/[^a-zA-Z0-9_]/g, '');
  // Terminate existing connections to the target database so we can drop it.
  await adminPool.query(
    `SELECT pg_terminate_backend(pg_stat_activity.pid)
       FROM pg_stat_activity
      WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid()`,
    [target],
  );
  await adminPool.query(`DROP DATABASE IF EXISTS "${target}"`);
  await adminPool.query(`CREATE DATABASE "${target}"`);
  console.log(`  Database "${target}" recreated.`);
}

function extractTargetDb(url: string): string {
  const u = new URL(url);
  return (u.pathname || '/postgres').replace(/^\//, '');
}

async function applyMigrations(pool: Pool): Promise<void> {
  // Apply .sql files in lexical order.
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => extname(f) === '.sql')
    .sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await pool.query(sql);
  }
  console.log(`  Applied ${files.length} migrations.`);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedResult {
  organizationId: string;
  users: Record<'ADMIN' | 'MANAGER' | 'STAFF' | 'INACTIVE_MANAGER', { id: string; email: string }>;
  jobCardId: string;
  password: string;
}

async function seed(pool: Pool, password: string): Promise<SeedResult> {
  const passwordHash = await hashPass(password);
  const orgId = randomUUID();

  await pool.query('BEGIN');
  try {
    // Organization
    await pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [
      orgId,
      'Servora Med Dev',
    ]);

    // Users — each gets a unique hash even with the same password (random salt).
    const roles = [
      { key: 'ADMIN' as const, name: 'Admin User', email: 'admin@servora.local', active: true },
      { key: 'MANAGER' as const, name: 'Manager User', email: 'manager@servora.local', active: true },
      { key: 'STAFF' as const, name: 'Staff User', email: 'staff@servora.local', active: true },
      { key: 'INACTIVE_MANAGER' as const, name: 'Inactive Manager', email: 'inactive@servora.local', active: false },
    ];

    const userIds = new Map<string, string>();
    for (const { key, name, email, active } of roles) {
      const id = randomUUID();
      const role = key === 'INACTIVE_MANAGER' ? 'MANAGER' : key;
      // Fresh hash per user (random salt).
      const hash = await hashPass(password);
      await pool.query(
        `INSERT INTO users (organization_id, id, name, email, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, id, name, email, hash, role, active],
      );
      userIds.set(key, id);
    }

    // Test JobCard — GENERAL_TASK, ACCEPTED, assigned to Staff
    const jobCardId = randomUUID();
    const staffId = userIds.get('STAFF')!;
    await pool.query(
      `INSERT INTO job_cards
         (organization_id, id, type, status, title, assigned_to, created_by,
          version, accepted_at, accepted_by)
       VALUES ($1, $2, 'GENERAL_TASK', 'ACCEPTED', $3, $4, $4,
               1, NOW(), $4)`,
      [orgId, jobCardId, 'Dev Test Job (Checkpoint)', staffId],
    );

    await pool.query('COMMIT');

    return {
      organizationId: orgId,
      users: {
        ADMIN: { id: userIds.get('ADMIN')!, email: 'admin@servora.local' },
        MANAGER: { id: userIds.get('MANAGER')!, email: 'manager@servora.local' },
        STAFF: { id: staffId, email: 'staff@servora.local' },
        INACTIVE_MANAGER: { id: userIds.get('INACTIVE_MANAGER')!, email: 'inactive@servora.local' },
      },
      jobCardId,
      password,
    };
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const targetDb = extractTargetDb(TARGET_DATABASE_URL);
  const adminPool = new Pool({ connectionString: ADMIN_URL });

  console.log('━━━ Servora-Med Dev Runtime Setup ━━━');
  console.log(`  Admin URL : ${ADMIN_URL.replace(/\/\/.*@/, '//<creds>@')}`);
  console.log(`  Target DB : ${targetDb}`);
  console.log(`  Password  : ${DEV_SEED_PASSWORD}`);
  console.log('');

  try {
    // 1. Drop and recreate database
    console.log('1. Resetting database…');
    await dropCreateTarget(adminPool, targetDb);
  } finally {
    await adminPool.end();
  }

  // 2. Migrations + seed on the fresh database
  const targetPool = new Pool({ connectionString: TARGET_DATABASE_URL });
  try {
    console.log('2. Applying migrations…');
    await applyMigrations(targetPool);

    console.log('3. Seeding synthetic users and test data…');
    const result = await seed(targetPool, DEV_SEED_PASSWORD);

    console.log('');
    console.log('━━━ Seed Complete ━━━');
    console.log('');
    console.log('  Shared password for all users:');
    console.log(`    ${result.password}`);
    console.log('');
    console.log('  Users:');
    console.log('  ┌──────────────────┬───────────────────────────────┬──────────────────────────────────────┐');
    console.log('  │ Role             │ Email                         │ ID                                   │');
    console.log('  ├──────────────────┼───────────────────────────────┼──────────────────────────────────────┤');
    for (const [role, { id, email }] of Object.entries(result.users)) {
      const label = role.replace(/_/g, ' ').padEnd(16);
      console.log(`  │ ${label} │ ${email.padEnd(29)} │ ${id} │`);
    }
    console.log('  └──────────────────┴───────────────────────────────┴──────────────────────────────────────┘');
    console.log('');
    console.log('  Test JobCard:');
    console.log(`    ID     : ${result.jobCardId}`);
    console.log(`    Status : ACCEPTED (GENERAL_TASK)`);
    console.log(`    URL    : /jobs/${result.jobCardId}`);
    console.log('');
    console.log('  Organization ID:');
    console.log(`    ${result.organizationId}`);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('  Start the API server:');
    console.log('    cd server && npx tsx --env-file=.env src/index.ts');
    console.log('');
    console.log('  Start the Vite dev server (separate terminal):');
    console.log('    cd web && npx vite --port 5173');
    console.log('');
  } finally {
    await targetPool.end();
  }
}

main().catch((error) => {
  console.error('Setup failed:', error);
  process.exit(1);
});
