import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function resolveTestDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL?.trim()) return process.env.TEST_DATABASE_URL;

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
