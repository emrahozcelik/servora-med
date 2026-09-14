/**
 * Canonical server-test entrypoint.
 *
 * Contract:
 *   1. `TEST_DATABASE_URL` is required. There is no `DATABASE_URL` fallback and
 *      no silent database-name manufacture: the canonical test database must be
 *      chosen explicitly so two worktrees cannot silently share one database.
 *   2. A fail-closed preflight (`./test-env-preflight.ts`) validates database
 *      identity, credential shape, loopback host, PostgreSQL 17 server and
 *      client tools, exact migration head and build freshness BEFORE Vitest
 *      starts.
 *   3. The spawned environment forces `NODE_ENV=test` and cannot inherit a
 *      developer's fail-closed capability gates.
 *
 * If the environment is wrong this script exits non-zero and Vitest never runs.
 * CI already supplies a conforming environment, so no workflow change is needed.
 *
 * There is deliberately no "am I the entrypoint?" guard: this file always runs,
 * so a path-resolution mistake cannot silently skip the preflight.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildCanonicalTestEnv } from './test-env-runtime-env.mjs';

const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const preflightScript = fileURLToPath(new URL('./test-env-preflight.ts', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

const canonicalEnv = buildCanonicalTestEnv(process.env);

const preflight = spawnSync(process.execPath, [tsxCli, preflightScript], {
  stdio: 'inherit',
  env: canonicalEnv,
});
if (preflight.error) throw preflight.error;
if ((preflight.status ?? 1) !== 0) {
  process.exit(preflight.status ?? 1);
}

const result = spawnSync(process.execPath, [vitest, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: canonicalEnv,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
