/**
 * TEST-ENV preflight — I/O adapter.
 *
 * Runs the fail-closed contract in `./test-env-contract.ts` before Vitest is
 * spawned. This file owns the database side effects: one read-only PostgreSQL
 * connection and three `--version` probes. Build freshness is delegated to
 * `./test-env-build-probe.ts`.
 *
 * It NEVER migrates, resets, truncates, drops or creates anything, and it never
 * prints credentials.
 *
 * Exit codes:
 *   0  environment satisfies the canonical contract — Vitest may start
 *   1  environment contract violated — Vitest must not start
 *
 * This file always executes; it is not import-guarded, so the preflight cannot
 * be silently skipped.
 */

import { execFileSync } from 'node:child_process';

import { Pool } from 'pg';

import {
  compareMigrationState,
  loadMigrationCatalog,
  MigrationCatalogError,
} from '../src/db/migration-catalog.js';
import { fetchAppliedVersions, getMigrationsDirectory } from '../src/db/schema-compatibility.js';
import { resolveBinary, parseToolVersion } from '../src/modules/backup/process.js';
import { probeBuild } from './test-env-build-probe.js';
import {
  TOOL_BINARY_ENV_KEYS,
  runTestEnvPreflight,
  type PreflightDeps,
  type SchemaProbeResult,
  type ToolName,
  type ToolProbeResult,
} from './test-env-contract.js';

const cwd = process.cwd();
const env = process.env;
const ci = env.CI === 'true';

/**
 * Missing `schema_migrations` classification. Mirrors the repository's existing
 * error sniff; migration *compatibility* semantics stay in
 * `compareMigrationState` and are never reimplemented here.
 */
function isMissingSchemaMigrationsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '42P01') return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    message.includes('schema_migrations') &&
    message.includes('does not exist')
  );
}

async function probeServerMajor(pool: Pool): Promise<number> {
  const result = await pool.query<{ version: string }>(
    "SELECT current_setting('server_version') AS version",
  );
  const raw = result.rows[0]?.version ?? '';
  const match = raw.match(/^(\d+)/);
  if (!match) throw new Error(`unparseable server_version: ${raw}`);
  return Number(match[1]);
}

async function probeSchema(pool: Pool): Promise<SchemaProbeResult> {
  let catalog;
  try {
    catalog = await loadMigrationCatalog(getMigrationsDirectory());
  } catch (error) {
    return {
      kind: 'catalog-invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (catalog.count === 0 || !catalog.head) {
    return { kind: 'catalog-invalid', message: 'migration catalog is empty or unavailable' };
  }

  let applied: string[];
  try {
    applied = await fetchAppliedVersions(pool);
  } catch (error) {
    if (isMissingSchemaMigrationsError(error)) return { kind: 'history-missing', summary: {} };
    if (error instanceof MigrationCatalogError) {
      return { kind: 'catalog-invalid', message: error.message };
    }
    return {
      kind: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const compatibility = compareMigrationState(catalog, applied);
  const summary: Record<string, unknown> = {
    catalogHead: catalog.head.version,
    catalogCount: catalog.count,
  };
  if (compatibility.status === 'BEHIND') {
    summary.appliedHead = compatibility.appliedHead;
    summary.pendingVersions = compatibility.pendingVersions;
  } else if (compatibility.status === 'EMPTY') {
    summary.pendingVersions = compatibility.pendingVersions;
  } else if (compatibility.status === 'AHEAD') {
    summary.appliedHead = compatibility.appliedHead;
    summary.unexpectedVersions = compatibility.unexpectedVersions;
  } else if (compatibility.status === 'DIVERGED') {
    // The DIVERGED variant exposes no `appliedHead`; its diagnostics are the
    // unexpected/missing/duplicate sets plus a reason, matching the repository's
    // own `formatCompatibilityForLog`.
    summary.unexpectedVersions = compatibility.unexpectedVersions;
    summary.missingVersions = compatibility.missingVersions;
    summary.duplicateVersions = compatibility.duplicateVersions;
    summary.reason = compatibility.reason;
  }

  if (compatibility.status === 'COMPATIBLE') return { kind: 'compatible', summary };
  return { kind: 'incompatible', status: compatibility.status, summary };
}

async function probeTools(): Promise<ToolProbeResult[]> {
  const results: ToolProbeResult[] = [];
  for (const tool of Object.keys(TOOL_BINARY_ENV_KEYS) as ToolName[]) {
    const binary = resolveBinary(env[TOOL_BINARY_ENV_KEYS[tool]], tool);
    try {
      const raw = execFileSync(binary, ['--version'], { encoding: 'utf8' });
      const parsed = parseToolVersion(raw, tool);
      results.push({ tool, binary, major: parsed.major, detail: parsed.raw });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      results.push({
        tool,
        binary: code === 'ENOENT' ? null : binary,
        major: null,
        detail: code === 'ENOENT' ? 'not found on PATH' : String((error as Error).message),
      });
    }
  }
  return results;
}

async function main(): Promise<number> {
  const pool = new Pool({
    connectionString: env.TEST_DATABASE_URL,
    max: 1,
    // Never let a stale socket hang the preflight: the contract must be fast and loud.
    connectionTimeoutMillis: 10_000,
  });

  const deps: PreflightDeps = {
    env,
    ci,
    cwd,
    probeServerMajor: () => probeServerMajor(pool),
    probeSchema: () => probeSchema(pool),
    probeTools,
    probeBuild: () => probeBuild(cwd),
  };

  let result;
  try {
    result = await runTestEnvPreflight(deps);
  } catch (error) {
    console.error('TEST_ENV_PREFLIGHT_FAILED code=TEST_ENV_PREFLIGHT_INTERNAL');
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (!result.ok) {
    console.error(`TEST_ENV_PREFLIGHT_FAILED code=${result.code}`);
    console.error(result.reason ?? 'test environment contract violated');
    console.error('Vitest was not started. See docs/operations/local-test-environment.md.');
    return 1;
  }

  const tools = result.tools.map((tool) => `${tool.tool}:${tool.major ?? 'absent'}`).join(',');
  console.log(
    `TEST_ENV_PREFLIGHT_OK database=${result.databaseName} url=${result.redactedUrl} ` +
      `postgres_major=${result.serverMajor} tools=${tools}`,
  );
  for (const note of result.notes) console.log(`TEST_ENV_PREFLIGHT_NOTE ${note}`);
  return 0;
}

process.exitCode = await main();
