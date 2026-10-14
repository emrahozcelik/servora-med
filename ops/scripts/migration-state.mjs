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
import {
  classifyMigrationState,
  formatMigrationVersions,
} from './migration-reconciliation.mjs';
import {
  BUSINESS_DATA_INVARIANTS_SQL,
  BUSINESS_INVARIANT_KEYS,
  validateBusinessInvariantCounts,
} from './deployment-db-guard.mjs';

const releaseDirectory = process.argv[2] ?? '';
const versionPattern = /^(\d{3})_([A-Za-z0-9_]+)\.sql$/;

function fail() {
  console.error('Migration state unavailable.');
  process.exitCode = 1;
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
    // Match migration store, startup and readiness: canonical version order.
    // applied_at is not an execution-order proof; neither reader can establish
    // actual historical execution order from the current schema.
    const result = await pool.query(
      'SELECT version FROM schema_migrations ORDER BY version ASC',
    );
    const applied = result.rows.map((row) => String(row.version));
    const catalogVersions = catalog.map((entry) => entry.version);
    const reconciliation = classifyMigrationState(catalogVersions, applied);
    const pending = reconciliation.pendingVersions;
    const unexpected = reconciliation.unexpectedVersions;
    const appliedHead = applied.at(-1) ?? '';
    const exactCatalog = reconciliation.status === 'EXACT';

    console.log(`catalog_count=${catalog.length}`);
    console.log(`catalog_head=${catalog.at(-1)?.version ?? ''}`);
    console.log(`catalog_versions=${formatMigrationVersions(catalogVersions)}`);
    console.log(`applied_count=${applied.length}`);
    console.log(`applied_head=${formatMigrationVersions([appliedHead])}`);
    console.log(`applied_versions=${formatMigrationVersions(applied)}`);
    console.log(`pending_versions=${formatMigrationVersions(pending)}`);
    console.log(`pending_count=${pending.length}`);
    console.log(`unexpected_versions=${formatMigrationVersions(unexpected)}`);
    console.log(`unexpected_count=${unexpected.length}`);
    console.log(`migration_status=${reconciliation.status}`);
    console.log(`migration_reason=${reconciliation.reason}`);
    console.log(`duplicate_versions=${formatMigrationVersions(reconciliation.duplicateVersions)}`);
    console.log(`exact_catalog=${exactCatalog ? 'true' : 'false'}`);

    // Aggregate, non-sensitive invariants used to prove that a deployment did
    // not move business data. The SQL and validator are shared with the
    // service-UID recovery guard so both comparison paths use one contract.
    const countsResult = await pool.query(BUSINESS_DATA_INVARIANTS_SQL);
    const counts = validateBusinessInvariantCounts(countsResult.rows[0]);
    for (const key of BUSINESS_INVARIANT_KEYS) {
      console.log(`${key}=${counts[key]}`);
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
