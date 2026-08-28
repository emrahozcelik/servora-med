#!/usr/bin/env node

/**
 * Read-only release/production migration equivalence probe.
 *
 * The command intentionally emits only migration identifiers and aggregate
 * counts. It receives DATABASE_URL through the protected process environment;
 * credentials are never printed or placed on an argv value.
 */
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const releaseDirectory = process.argv[2] ?? '';
const versionPattern = /^(\d{3})_([A-Za-z0-9_]+)\.sql$/;

function fail() {
  console.error('Migration state unavailable.');
  process.exitCode = 1;
}

function csv(values) {
  return values.join(',');
}

function countValue(row, key) {
  const value = Number(row?.[key]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid count for ${key}`);
  }
  return value;
}

async function loadCatalog(migrationsDirectory) {
  const files = await readdir(migrationsDirectory);
  const entries = files
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = versionPattern.exec(filename);
      if (!match) throw new Error('invalid migration filename');
      return {
        number: Number.parseInt(match[1], 10),
        version: filename.slice(0, -'.sql'.length),
      };
    })
    .sort((left, right) => left.number - right.number);

  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (seen.has(entry.number)) throw new Error('duplicate migration number');
    seen.add(entry.number);
    if (entry.number !== index + 1) throw new Error('migration number gap');
  }
  return entries;
}

async function main() {
  if (!releaseDirectory.startsWith('/') || releaseDirectory.includes('\0')) {
    fail();
    return;
  }

  const migrationsDirectory = path.join(releaseDirectory, 'server', 'dist', 'db', 'migrations');
  const catalog = await loadCatalog(migrationsDirectory);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('missing database url');

  const entrypoint = pathToFileURL(path.join(releaseDirectory, 'server', 'dist', 'db', 'index.js')).href;
  const requireFromRelease = createRequire(entrypoint);
  const { Pool } = requireFromRelease('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    application_name: 'servora-med-deploy-state',
  });

  try {
    const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const applied = result.rows.map((row) => String(row.version));
    const catalogVersions = catalog.map((entry) => entry.version);
    const catalogSet = new Set(catalogVersions);
    const appliedSet = new Set(applied);
    const pending = catalogVersions.filter((version) => !appliedSet.has(version));
    const unexpected = applied.filter((version) => !catalogSet.has(version));
    const appliedHead = [...catalogVersions].reverse().find((version) => appliedSet.has(version)) ?? '';
    const exactCatalog = pending.length === 0
      && unexpected.length === 0
      && applied.length === catalogVersions.length
      && new Set(applied).size === applied.length;

    console.log(`catalog_count=${catalog.length}`);
    console.log(`catalog_head=${catalog.at(-1)?.version ?? ''}`);
    console.log(`catalog_versions=${csv(catalogVersions)}`);
    console.log(`applied_count=${applied.length}`);
    console.log(`applied_head=${appliedHead}`);
    console.log(`applied_versions=${csv(applied)}`);
    console.log(`pending_versions=${csv(pending)}`);
    console.log(`pending_count=${pending.length}`);
    console.log(`unexpected_versions=${csv(unexpected)}`);
    console.log(`unexpected_count=${unexpected.length}`);
    console.log(`exact_catalog=${exactCatalog ? 'true' : 'false'}`);

    // These are aggregate, non-sensitive invariants used to prove that a
    // deployment did not move business data. Keep this query read-only and
    // never select names, emails, hashes, tokens, or other row contents.
    const countsResult = await pool.query(`
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
        )::bigint AS demo_data
    `);
    const counts = countsResult.rows[0];
    for (const key of ['organizations', 'admins', 'staff', 'customers', 'products', 'jobs', 'demo_data']) {
      console.log(`${key}=${countValue(counts, key)}`);
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch {
  fail();
}
