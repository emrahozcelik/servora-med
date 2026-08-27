import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function resolveTestDatabaseUrl() {
  const configuredTestUrl = process.env.TEST_DATABASE_URL?.trim();
  if (configuredTestUrl) return configuredTestUrl;

  // CI must execute the real PostgreSQL acceptance suite. The Vitest files
  // retain a local convenience skip when no database is configured, but the
  // npm test entrypoint is fail-closed in CI rather than silently skipping it.
  if (process.env.CI === 'true') {
    throw new Error('CI requires TEST_DATABASE_URL; refusing to skip PostgreSQL acceptance tests.');
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL or DATABASE_URL is required to run server tests.');
  }
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = '/servora_med_test';
  return testUrl.toString();
}

const vitest = fileURLToPath(
  new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [vitest, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: resolveTestDatabaseUrl() },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
