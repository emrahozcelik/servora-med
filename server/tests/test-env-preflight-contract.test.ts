/**
 * TEST-ENV preflight contract — permanent acceptance tests.
 *
 * These tests encode the audit-selected `TEST_ENV_PREFLIGHT_CONTRACT`: a wrong
 * local test environment must fail BEFORE Vitest starts, and an unexecuted
 * acceptance test must be reported as SKIPPED rather than PASSED.
 *
 * They are deliberately independent of the developer's real `.env` and of any
 * PostgreSQL instance: every external observation is injected.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { probeBuild } from '../scripts/test-env-build-probe.js';
import {
  ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX,
  REQUIRED_BUILD_ARTIFACTS,
  REQUIRED_POSTGRES_MAJOR,
  TestEnvContractError,
  classifyBuildFreshness,
  isIsolatedLocalTestDatabaseName,
  isLoopbackHost,
  isProtectedTestDatabaseName,
  isSharedLocalTestDatabaseName,
  parseTestDatabaseUrl,
  redactTestDatabaseUrl,
  runTestEnvPreflight,
  validateTestDatabaseHost,
  validateTestDatabaseIdentity,
  type PreflightDeps,
} from '../scripts/test-env-contract.js';
import {
  NON_LEAKING_CAPABILITY_FLAGS,
  buildCanonicalTestEnv,
} from '../scripts/test-env-runtime-env.mjs';

const scriptsDirectory = fileURLToPath(new URL('../scripts', import.meta.url));
const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url));

const VALID_LOCAL_URL = `postgresql://test-user:test-password@127.0.0.1:5432/${ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX}unit`;

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: { TEST_DATABASE_URL: VALID_LOCAL_URL },
    ci: false,
    cwd: process.cwd(),
    probeServerMajor: async () => REQUIRED_POSTGRES_MAJOR,
    probeSchema: async () => ({
      kind: 'compatible',
      summary: { catalogHead: '045_calendar_request_hash', catalogCount: 45 },
    }),
    probeTools: async () => [
      { tool: 'psql', binary: 'psql', major: REQUIRED_POSTGRES_MAJOR },
      { tool: 'pg_dump', binary: 'pg_dump', major: REQUIRED_POSTGRES_MAJOR },
      { tool: 'pg_restore', binary: 'pg_restore', major: REQUIRED_POSTGRES_MAJOR },
    ],
    probeBuild: async () => ({
      missingArtifacts: [],
      oldestArtifactMtimeMs: 2_000,
      newestSourceMtimeMs: 1_000,
    }),
    ...overrides,
  };
}

async function failureCode(deps: PreflightDeps): Promise<string | undefined> {
  const result = await runTestEnvPreflight(deps);
  expect(result.ok).toBe(false);
  return result.code;
}

describe('TEST-ENV contract — TEST_DATABASE_URL authority', () => {
  it('requires TEST_DATABASE_URL and never falls back to DATABASE_URL', async () => {
    expect(await failureCode(makeDeps({ env: {} }))).toBe('TEST_ENV_TEST_DATABASE_URL_REQUIRED');

    // A conforming DATABASE_URL must not be silently promoted.
    expect(
      await failureCode(
        makeDeps({ env: { DATABASE_URL: 'postgresql://test-user:test-password@127.0.0.1:5432/servora_med_test_unit' } }),
      ),
    ).toBe('TEST_ENV_TEST_DATABASE_URL_REQUIRED');
  });

  it('rejects a malformed TEST_DATABASE_URL', async () => {
    expect(await failureCode(makeDeps({ env: { TEST_DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/db' } }))).toBe(
      'TEST_ENV_TEST_DATABASE_URL_MALFORMED',
    );
    expect(await failureCode(makeDeps({ env: { TEST_DATABASE_URL: '   ' } }))).toBe(
      'TEST_ENV_TEST_DATABASE_URL_REQUIRED',
    );
  });

  it('requires an explicit database name', () => {
    expect(() => parseTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/')).toThrowError(
      expect.objectContaining({ code: 'TEST_ENV_TEST_DATABASE_NAME_REQUIRED' }),
    );
  });

  it('parses the database name structurally rather than by substring', () => {
    const parsed = parseTestDatabaseUrl(
      'postgresql://test-user:test-password@127.0.0.1:5432/servora_med_test_unit?sslmode=require',
    );
    expect(parsed.databaseName).toBe('servora_med_test_unit');
    expect(parsed.username).toBe('test-user');
    expect(parsed.password).toBe('test-password');
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe('5432');

    // `servora_med_test` must not be treated as protected via substring.
    expect(isProtectedTestDatabaseName('servora_med_test')).toBe(false);
    expect(isSharedLocalTestDatabaseName('servora_med_test')).toBe(true);
  });

  it('never exposes the password in diagnostics', () => {
    const raw = 'postgresql://test-user:sup3r-s3cret@127.0.0.1:5432/servora_med_test_unit';
    const redacted = redactTestDatabaseUrl(raw);
    expect(redacted).not.toContain('sup3r-s3cret');
    expect(redacted).toContain('test-user');
    expect(redacted).toContain('servora_med_test_unit');
    expect(redactTestDatabaseUrl(undefined)).toBe('<unset>');
  });
});

describe('TEST-ENV contract — credential shape', () => {
  it('rejects a missing username', async () => {
    expect(
      await failureCode(
        makeDeps({ env: { TEST_DATABASE_URL: 'postgresql://:pw@127.0.0.1:5432/servora_med_test_unit' } }),
      ),
    ).toBe('TEST_ENV_TEST_DATABASE_URL_USERNAME_REQUIRED');
  });

  it('rejects a missing password', async () => {
    expect(
      await failureCode(
        makeDeps({ env: { TEST_DATABASE_URL: 'postgresql://test-user@127.0.0.1:5432/servora_med_test_unit' } }),
      ),
    ).toBe('TEST_ENV_TEST_DATABASE_URL_PASSWORD_REQUIRED');
  });
});

describe('TEST-ENV contract — database identity', () => {
  it('refuses protected production and staging identities', async () => {
    for (const name of ['servora_med', 'servora_med_staging']) {
      expect(
        await failureCode(makeDeps({ env: { TEST_DATABASE_URL: `postgresql://test-user:test-password@127.0.0.1:5432/${name}` } })),
      ).toBe('TEST_ENV_PROTECTED_DATABASE_NAME');
    }
  });

  it('refuses the shared persistent local test database outside CI', async () => {
    expect(
      await failureCode(
        makeDeps({ env: { TEST_DATABASE_URL: 'postgresql://test-user:test-password@127.0.0.1:5432/servora_med_test' } }),
      ),
    ).toBe('TEST_ENV_SHARED_TEST_DATABASE_NAME');
  });

  it('refuses a local name that is not explicitly isolated', async () => {
    expect(
      await failureCode(
        makeDeps({ env: { TEST_DATABASE_URL: 'postgresql://test-user:test-password@127.0.0.1:5432/servora_med_other' } }),
      ),
    ).toBe('TEST_ENV_SHARED_TEST_DATABASE_NAME');
    expect(isIsolatedLocalTestDatabaseName(`${ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX}x`)).toBe(true);
    expect(isIsolatedLocalTestDatabaseName(ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX)).toBe(false);
  });

  it('accepts an explicitly isolated local name', async () => {
    const result = await runTestEnvPreflight(makeDeps());
    expect(result.ok).toBe(true);
    expect(result.databaseName).toBe(`${ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX}unit`);
  });

  it('keeps the CI ephemeral service-owned database accepted', async () => {
    const result = await runTestEnvPreflight(
      makeDeps({
        ci: true,
        env: { TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/servora_med_test' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('still refuses a protected identity in CI', () => {
    const parsed = parseTestDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/servora_med');
    expect(() => validateTestDatabaseIdentity(parsed, { ci: true })).toThrowError(
      expect.objectContaining({ code: 'TEST_ENV_PROTECTED_DATABASE_NAME' }),
    );
  });
});

describe('TEST-ENV contract — host safety', () => {
  it('accepts loopback forms', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('refuses a non-loopback host for local canonical runs', () => {
    const parsed = parseTestDatabaseUrl('postgresql://test-user:test-password@db.example.com:5432/servora_med_test_unit');
    expect(() => validateTestDatabaseHost(parsed, { ci: false })).toThrowError(
      expect.objectContaining({ code: 'TEST_ENV_NON_LOOPBACK_HOST' }),
    );
    expect(isLoopbackHost('db.example.com')).toBe(false);
  });

  it('refuses a non-loopback host through the orchestrator', async () => {
    expect(
      await failureCode(
        makeDeps({ env: { TEST_DATABASE_URL: 'postgresql://test-user:test-password@db.example.com:5432/servora_med_test_unit' } }),
      ),
    ).toBe('TEST_ENV_NON_LOOPBACK_HOST');
  });
});

describe('TEST-ENV contract — PostgreSQL 17 strict parity', () => {
  it('rejects a PostgreSQL 16 server explicitly', async () => {
    expect(await failureCode(makeDeps({ probeServerMajor: async () => 16 }))).toBe(
      'TEST_ENV_POSTGRES_MAJOR_MISMATCH',
    );
  });

  it('accepts a PostgreSQL 17 server', async () => {
    const result = await runTestEnvPreflight(makeDeps({ probeServerMajor: async () => 17 }));
    expect(result.ok).toBe(true);
    expect(result.serverMajor).toBe(17);
  });

  it('rejects a PostgreSQL 16 client toolset explicitly', async () => {
    for (const tool of ['psql', 'pg_dump', 'pg_restore'] as const) {
      expect(
        await failureCode(
          makeDeps({
            probeTools: async () => [
              { tool, binary: tool, major: 16 },
            ],
          }),
        ),
      ).toBe('TEST_ENV_TOOL_MAJOR_MISMATCH');
    }
  });

  it('accepts a PostgreSQL 17 toolset', async () => {
    const result = await runTestEnvPreflight(makeDeps());
    expect(result.ok).toBe(true);
    expect(result.tools.map((tool) => tool.major)).toEqual([17, 17, 17]);
  });

  it('reports an absent tool as a note instead of substituting another major', async () => {
    const result = await runTestEnvPreflight(
      makeDeps({
        probeTools: async () => [
          { tool: 'pg_dump', binary: null, major: null },
          { tool: 'pg_restore', binary: null, major: null },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.notes.join(' ')).toContain('not resolvable');
  });
});

describe('TEST-ENV contract — schema head fail-fast', () => {
  it('accepts an exact migration head', async () => {
    const result = await runTestEnvPreflight(makeDeps());
    expect(result.ok).toBe(true);
    expect(result.notes.join(' ')).toContain('COMPATIBLE');
  });

  it.each(['BEHIND', 'EMPTY', 'AHEAD', 'DIVERGED'] as const)(
    'fails closed on %s before Vitest',
    async (status) => {
      expect(
        await failureCode(
          makeDeps({
            probeSchema: async () => ({
              kind: 'incompatible',
              status,
              summary: { catalogHead: '045_calendar_request_hash', catalogCount: 45 },
            }),
          }),
        ),
      ).toBe('TEST_ENV_SCHEMA_NOT_COMPATIBLE');
    },
  );

  it('fails closed when migration history is missing', async () => {
    expect(
      await failureCode(makeDeps({ probeSchema: async () => ({ kind: 'history-missing', summary: {} }) })),
    ).toBe('TEST_ENV_SCHEMA_HISTORY_MISSING');
  });

  it('fails closed when the database is unavailable', async () => {
    expect(
      await failureCode(makeDeps({ probeSchema: async () => ({ kind: 'unavailable', message: 'connect ECONNREFUSED' }) })),
    ).toBe('TEST_ENV_DATABASE_UNAVAILABLE');
    expect(
      await failureCode(
        makeDeps({
          probeServerMajor: async () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
      ),
    ).toBe('TEST_ENV_DATABASE_UNAVAILABLE');
  });

  it('fails closed when the migration catalog is invalid', async () => {
    expect(
      await failureCode(makeDeps({ probeSchema: async () => ({ kind: 'catalog-invalid', message: 'gap at 043' }) })),
    ).toBe('TEST_ENV_MIGRATION_CATALOG_INVALID');
  });
});

describe('TEST-ENV contract — build freshness', () => {
  it('classifies missing artifacts', () => {
    const status = classifyBuildFreshness({
      missingArtifacts: ['dist/db/migrate.js'],
      oldestArtifactMtimeMs: null,
      newestSourceMtimeMs: 1_000,
    });
    expect(status.status).toBe('missing');
    expect(status.missing).toEqual(['dist/db/migrate.js']);
  });

  it('classifies stale artifacts', () => {
    expect(
      classifyBuildFreshness({
        missingArtifacts: [],
        oldestArtifactMtimeMs: 1_000,
        newestSourceMtimeMs: 2_000,
      }).status,
    ).toBe('stale');
  });

  it('accepts fresh artifacts', () => {
    expect(
      classifyBuildFreshness({
        missingArtifacts: [],
        oldestArtifactMtimeMs: 2_000,
        newestSourceMtimeMs: 1_000,
      }).status,
    ).toBe('ok');
  });

  it('fails closed before Vitest when build artifacts are missing or stale', async () => {
    expect(
      await failureCode(
        makeDeps({
          probeBuild: async () => ({
            missingArtifacts: ['dist/db/migrate.js'],
            oldestArtifactMtimeMs: null,
            newestSourceMtimeMs: 1_000,
          }),
        }),
      ),
    ).toBe('TEST_ENV_BUILD_MISSING');

    expect(
      await failureCode(
        makeDeps({
          probeBuild: async () => ({
            missingArtifacts: [],
            oldestArtifactMtimeMs: 1_000,
            newestSourceMtimeMs: 2_000,
          }),
        }),
      ),
    ).toBe('TEST_ENV_BUILD_STALE');
  });

  it('declares the artifacts the current test suite actually executes', () => {
    expect(REQUIRED_BUILD_ARTIFACTS).toEqual([
      'dist/db/migrate.js',
      'dist/db/schema-check.js',
      'dist/db/migrations',
    ]);
  });
});

describe('TEST-ENV contract — build probe (real filesystem, isolated temp root)', () => {
  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'testenv-build-'));
    await mkdir(path.join(root, 'dist/db/migrations'), { recursive: true });
    await mkdir(path.join(root, 'src/db'), { recursive: true });
    await writeFile(path.join(root, 'dist/db/migrate.js'), 'built');
    await writeFile(path.join(root, 'dist/db/schema-check.js'), 'built');
    await writeFile(path.join(root, 'dist/db/migrations/001_x.sql'), 'select 1;');
    await writeFile(path.join(root, 'src/db/service.ts'), 'export {};');
    return root;
  }

  it('reports no missing artifacts and a fresh verdict after a build', async () => {
    const root = await makeRoot();
    try {
      const base = new Date('2026-01-01T00:00:00Z');
      for (const relative of ['dist/db/migrate.js', 'dist/db/schema-check.js', 'dist/db/migrations/001_x.sql']) {
        await utimes(path.join(root, relative), base, base);
      }
      await utimes(path.join(root, 'src/db/service.ts'), new Date('2025-01-01T00:00:00Z'), new Date('2025-01-01T00:00:00Z'));

      const input = await probeBuild(root);
      expect(input.missingArtifacts).toEqual([]);
      expect(input.oldestArtifactMtimeMs).not.toBeNull();
      expect(input.newestSourceMtimeMs).not.toBeNull();
      expect(classifyBuildFreshness(input).status).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects a stale artifact set (source newer than build)', async () => {
    const root = await makeRoot();
    try {
      const old = new Date('2025-01-01T00:00:00Z');
      const fresh = new Date('2026-06-01T00:00:00Z');
      for (const relative of ['dist/db/migrate.js', 'dist/db/schema-check.js', 'dist/db/migrations/001_x.sql']) {
        await utimes(path.join(root, relative), old, old);
      }
      await utimes(path.join(root, 'src/db/service.ts'), fresh, fresh);

      expect(classifyBuildFreshness(await probeBuild(root)).status).toBe('stale');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing artifacts explicitly', async () => {
    const root = await makeRoot();
    try {
      const input = await probeBuild(root, ['dist/db/migrate.js', 'dist/db/absent.js']);
      expect(input.missingArtifacts).toEqual(['dist/db/absent.js']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('TEST-ENV contract — canonical spawned environment', () => {
  it('forces NODE_ENV=test rather than inheriting the developer mode', () => {
    const env = buildCanonicalTestEnv({ NODE_ENV: 'development', PATH: '/usr/bin' });
    expect(env.NODE_ENV).toBe('test');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not leak fail-closed capability gates from a developer .env', () => {
    const base: Record<string, string | undefined> = {
      ACTION_SCOPED_GEOLOCATION_ENABLED: 'true',
      CALENDAR_ENABLED: 'true',
      WEB_PUSH_ENABLED: 'true',
      CI: 'true',
      TEST_DATABASE_URL: VALID_LOCAL_URL,
      PG_DUMP_BIN: '/usr/lib/postgresql/17/bin/pg_dump',
    };
    const env = buildCanonicalTestEnv(base);
    for (const flag of NON_LEAKING_CAPABILITY_FLAGS) {
      expect(env[flag]).toBeUndefined();
    }
    expect(env.CI).toBe('true');
    expect(env.TEST_DATABASE_URL).toBe(VALID_LOCAL_URL);
    expect(env.PG_DUMP_BIN).toBe('/usr/lib/postgresql/17/bin/pg_dump');
  });
});

describe('TEST-ENV contract — entrypoint and scope invariants', () => {
  it('keeps run-tests.mjs as the single entrypoint and removes the DATABASE_URL fallback', async () => {
    const source = await readFile(path.join(scriptsDirectory, 'run-tests.mjs'), 'utf8');
    expect(source).toContain('test-env-preflight.ts');
    expect(source).toContain('test-env-runtime-env.mjs');
    // The dangerous silent rewrite must be gone.
    expect(source).not.toContain("testUrl.pathname = '/servora_med_test'");
    expect(source).not.toContain('resolveTestDatabaseUrl');
    // No entrypoint guard, so the preflight can never be skipped by a path mistake.
    expect(source).not.toContain('isDirectRun');
  });

  it('runs the preflight before Vitest', async () => {
    const source = await readFile(path.join(scriptsDirectory, 'run-tests.mjs'), 'utf8');
    expect(source.indexOf('test-env-preflight.ts')).toBeLessThan(source.indexOf('vitest.mjs'));
  });

  it('never mutates a database from the preflight', async () => {
    for (const file of ['test-env-contract.ts', 'test-env-preflight.ts', 'test-env-build-probe.ts']) {
      const source = await readFile(path.join(scriptsDirectory, file), 'utf8');
      for (const forbidden of ['DROP ', 'TRUNCATE', 'CREATE DATABASE', 'DELETE FROM', 'INSERT INTO', 'runMigrations']) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never reads a compatibility field the DIVERGED variant does not expose', async () => {
    // `MigrationCompatibility` DIVERGED exposes unexpected/missing/duplicate
    // versions plus a reason — but no `appliedHead`. Reading it produced a
    // silently degraded diagnostic (appliedHead=none) instead of the real
    // divergence detail, so the branch is pinned here.
    const source = await readFile(path.join(scriptsDirectory, 'test-env-preflight.ts'), 'utf8');
    const start = source.indexOf("status === 'DIVERGED'");
    expect(start, 'the DIVERGED branch must exist').toBeGreaterThan(-1);
    const branch = source.slice(start, source.indexOf('}', start));
    // Match the field *read*, not the word in a comment.
    expect(branch).not.toContain('compatibility.appliedHead');
    expect(branch).toContain('compatibility.duplicateVersions');
    expect(branch).toContain('compatibility.reason');
  });

  it('keeps the product source tree independent of test-env tooling', async () => {
    const entries = (await readdir(sourceDirectory, { recursive: true })) as string[];
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const content = await readFile(path.join(sourceDirectory, entry), 'utf8');
      if (content.includes('test-env-')) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it('reports production-recovery environment gaps as explicit skips, never silent passes', async () => {
    const source = await readFile(path.join(sourceDirectory, '..', 'tests', 'production-recovery.test.ts'), 'utf8');
    const skipCalls = source.match(/ctx\.skip\(/g) ?? [];
    expect(skipCalls).toHaveLength(2);
    expect(source).not.toContain('Skipping real DB restore');
    expect(source).not.toContain('Skipping real DB test due to lack of privilege');
    // The privilege branch must still re-throw genuine recovery defects.
    expect(source).toContain('throw e;');
  });

  it('marks a missing-tooling recovery acceptance test as SKIPPED rather than PASSED', async () => {
    const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
    const reportDirectory = await mkdtemp(path.join(tmpdir(), 'testenv-report-'));
    const reportPath = path.join(reportDirectory, 'report.json');

    // Tool availability must be DEFINED here, never assumed. An earlier version of
    // this test used `PATH=/usr/bin:/bin` and relied on `pg_dump` not living
    // there — which is false on the Ubuntu runner, where `/usr/bin/pg_dump`
    // exists. The proof therefore depended on the host's `/usr/bin` contents.
    //
    // Instead, build a fully controlled PATH holding exactly one executable: a
    // `which` shim that always fails. Tool discovery is then deterministically
    // unavailable on every host, and the proof tests behaviour rather than
    // machine configuration.
    const controlledBinDirectory = await mkdtemp(path.join(tmpdir(), 'testenv-nopath-'));
    const whichShim = path.join(controlledBinDirectory, 'which');
    await writeFile(whichShim, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(whichShim, 0o755);

    // A non-empty TEST_DATABASE_URL keeps
    // `describe.skipIf(!process.env.TEST_DATABASE_URL)` active, so the block is
    // not skipped for the wrong reason. It never has to be reachable: the
    // controlled PATH makes the target test skip before it ever connects.
    const testDatabaseUrl =
      process.env.TEST_DATABASE_URL ??
      'postgresql://test-user:test-password@127.0.0.1:5432/servora_med_test_nested';

    const nestedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: controlledBinDirectory,
      TEST_DATABASE_URL: testDatabaseUrl,
    };
    // An explicit binary override would also defeat "tooling absent".
    for (const key of ['PSQL_BIN', 'PG_DUMP_BIN', 'PG_RESTORE_BIN']) delete nestedEnv[key];

    try {
      // Node and Vitest are launched through absolute paths, so the nested runner
      // itself never depends on PATH.
      const result = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          'tests/production-recovery.test.ts',
          '-t',
          'restores real disposable DB',
          '--reporter=json',
          `--outputFile=${reportPath}`,
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: nestedEnv,
          encoding: 'utf8',
        },
      );
      expect(result.error).toBeUndefined();

      const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
        testResults: { assertionResults: { fullName: string; status: string }[] }[];
      };
      const matches = report.testResults
        .flatMap((suite) => suite.assertionResults)
        .filter((assertion) => assertion.fullName.includes('restores real disposable DB'));

      // The acceptance test must be present exactly once and reported as
      // SKIPPED. The old silent-skip bug (`console.warn(...); return;`) reported
      // it as PASSED, which is the regression this asserts against.
      expect(matches, 'the recovery acceptance test must be present in the report').toHaveLength(1);
      expect(matches[0]?.status).toBe('skipped');
      expect(
        matches.filter((assertion) => assertion.status === 'passed'),
        'an unexecuted acceptance test must never be reported as passed',
      ).toHaveLength(0);
    } finally {
      await rm(controlledBinDirectory, { recursive: true, force: true });
      await rm(reportDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('TEST-ENV contract — failure ordering', () => {
  it('reports the first violated invariant instead of cascading', async () => {
    // A bad URL must win over an unavailable database probe.
    const result = await runTestEnvPreflight(
      makeDeps({
        env: { TEST_DATABASE_URL: 'not-a-url' },
        probeServerMajor: async () => {
          throw new Error('should never be reached');
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TEST_ENV_TEST_DATABASE_URL_MALFORMED');
  });

  it('exposes a typed contract error code', () => {
    const error = new TestEnvContractError('TEST_ENV_BUILD_STALE', 'stale');
    expect(error.code).toBe('TEST_ENV_BUILD_STALE');
    expect(error.name).toBe('TestEnvContractError');
  });
});
