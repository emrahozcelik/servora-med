/**
 * Canonical server-test runtime environment.
 *
 * Kept as a separate module so it can be unit-tested without executing the test
 * runner. `run-tests.mjs` imports this unconditionally; there is no
 * "am I the entrypoint?" guard anywhere in the runner, so a path-resolution
 * mistake can never silently skip the preflight and run Vitest anyway.
 */

/**
 * Fail-closed capability gates. A developer's `.env` must not be able to switch
 * product capabilities on inside the canonical test run.
 */
export const NON_LEAKING_CAPABILITY_FLAGS = [
  'ACTION_SCOPED_GEOLOCATION_ENABLED',
  'CALENDAR_ENABLED',
  'WEB_PUSH_ENABLED',
];

/**
 * Canonical spawned test environment.
 *
 * `NODE_ENV` is forced to `test` rather than inherited, and capability gates
 * cannot leak from a developer's `.env`. Every other variable (PATH, `PG*_BIN`,
 * CI, `TEST_DATABASE_URL`, ...) is preserved so explicit overrides keep working.
 */
export function buildCanonicalTestEnv(base) {
  const env = { ...base, NODE_ENV: 'test' };
  for (const flag of NON_LEAKING_CAPABILITY_FLAGS) delete env[flag];
  return env;
}
