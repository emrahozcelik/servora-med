/**
 * TEST-ENV preflight contract — pure helpers and orchestration.
 *
 * This module is deliberately side-effect free: it never touches a database, a
 * filesystem, a child process or `process.env`. Every external observation is
 * injected through `PreflightDeps`, which keeps the whole contract unit-testable
 * without a PostgreSQL instance and without the developer's real `.env`.
 *
 * Frozen canonical full server-test environment:
 *
 *   NODE_ENV                     = test
 *   TEST_DATABASE_URL            explicitly supplied, password-bearing,
 *                                loopback, explicitly isolated database name
 *   PostgreSQL server major      = 17
 *   psql / pg_dump / pg_restore  = 17 when present
 *   database schema              = exact repository migration head
 *   build artifacts              present and fresh
 *   silent environment skip      forbidden
 *
 * A wrong test environment must never produce a misleading product-test result.
 * Every violation below is a hard failure that happens BEFORE Vitest starts.
 */

export const REQUIRED_POSTGRES_MAJOR = 17;

/**
 * Production/demo identities that a canonical test run must never target.
 * Mirrors the repository's existing destructive-test guard and extends it with
 * the staging identity.
 */
export const PROTECTED_TEST_DATABASE_NAMES: readonly string[] = [
  'servora_med',
  'servora_med_staging',
];

/**
 * Long-lived shared local database name. CI owns and destroys its own ephemeral
 * `servora_med_test` service, but a developer machine must not silently default
 * two worktrees onto the same persistent database.
 */
export const SHARED_LOCAL_TEST_DATABASE_NAME = 'servora_med_test';

/** Local canonical runs must use an explicitly isolated name. */
export const ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX = 'servora_med_test_';

export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/** Build artifacts proven necessary by the current test suite. */
export const REQUIRED_BUILD_ARTIFACTS: readonly string[] = [
  'dist/db/migrate.js',
  'dist/db/schema-check.js',
  'dist/db/migrations',
];

/** Binary-resolution environment overrides, matching repository conventions. */
export const TOOL_BINARY_ENV_KEYS = {
  psql: 'PSQL_BIN',
  pg_dump: 'PG_DUMP_BIN',
  pg_restore: 'PG_RESTORE_BIN',
} as const;

export type ToolName = keyof typeof TOOL_BINARY_ENV_KEYS;

export type TestEnvFailureCode =
  | 'TEST_ENV_TEST_DATABASE_URL_REQUIRED'
  | 'TEST_ENV_TEST_DATABASE_URL_MALFORMED'
  | 'TEST_ENV_TEST_DATABASE_URL_USERNAME_REQUIRED'
  | 'TEST_ENV_TEST_DATABASE_URL_PASSWORD_REQUIRED'
  | 'TEST_ENV_TEST_DATABASE_NAME_REQUIRED'
  | 'TEST_ENV_PROTECTED_DATABASE_NAME'
  | 'TEST_ENV_SHARED_TEST_DATABASE_NAME'
  | 'TEST_ENV_NON_LOOPBACK_HOST'
  | 'TEST_ENV_POSTGRES_MAJOR_MISMATCH'
  | 'TEST_ENV_TOOL_MAJOR_MISMATCH'
  | 'TEST_ENV_SCHEMA_NOT_COMPATIBLE'
  | 'TEST_ENV_SCHEMA_HISTORY_MISSING'
  | 'TEST_ENV_DATABASE_UNAVAILABLE'
  | 'TEST_ENV_MIGRATION_CATALOG_INVALID'
  | 'TEST_ENV_BUILD_MISSING'
  | 'TEST_ENV_BUILD_STALE';

export class TestEnvContractError extends Error {
  readonly code: TestEnvFailureCode;

  constructor(code: TestEnvFailureCode, message: string) {
    super(message);
    this.name = 'TestEnvContractError';
    this.code = code;
  }
}

export type ParsedTestDatabaseUrl = {
  raw: string;
  databaseName: string;
  username: string;
  password: string;
  host: string;
  port: string;
};

/** Redact a connection string for diagnostics. Never returns the password. */
export function redactTestDatabaseUrl(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) return '<unset>';
  try {
    const url = new URL(raw.trim());
    const username = url.username ? decodeURIComponent(url.username) : '';
    const userinfo = username ? `${username}@` : '';
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${userinfo}${url.hostname}${port}${url.pathname}`;
  } catch {
    return '<unparseable-test-database-url>';
  }
}

/**
 * Parse `TEST_DATABASE_URL` structurally. Never substring-matches the name.
 * Throws `TEST_ENV_TEST_DATABASE_URL_REQUIRED` when absent — there is
 * deliberately no `DATABASE_URL` fallback.
 */
export function parseTestDatabaseUrl(raw: string | undefined): ParsedTestDatabaseUrl {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new TestEnvContractError(
      'TEST_ENV_TEST_DATABASE_URL_REQUIRED',
      'TEST_DATABASE_URL is required to run server tests. ' +
        'There is no DATABASE_URL fallback: the canonical test database must be chosen explicitly.',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) {
    throw new TestEnvContractError(
      'TEST_ENV_TEST_DATABASE_URL_MALFORMED',
      'TEST_DATABASE_URL must be a postgresql:// or postgres:// URL.',
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TestEnvContractError(
      'TEST_ENV_TEST_DATABASE_URL_MALFORMED',
      'TEST_DATABASE_URL could not be parsed as a URL.',
    );
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, '')).split('?')[0] ?? '';
  if (!databaseName) {
    throw new TestEnvContractError(
      'TEST_ENV_TEST_DATABASE_NAME_REQUIRED',
      'TEST_DATABASE_URL must name an explicit database.',
    );
  }

  return {
    raw: trimmed,
    databaseName,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port || '5432',
  };
}

export function isProtectedTestDatabaseName(name: string): boolean {
  return PROTECTED_TEST_DATABASE_NAMES.includes(name);
}

export function isSharedLocalTestDatabaseName(name: string): boolean {
  return name === SHARED_LOCAL_TEST_DATABASE_NAME;
}

export function isIsolatedLocalTestDatabaseName(name: string): boolean {
  if (!name.startsWith(ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX)) return false;
  return name.slice(ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX.length).length > 0;
}

/** `URL.hostname` wraps IPv6 literals in brackets; normalise before comparing. */
export function normalizeHostname(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(normalizeHostname(host));
}

/**
 * Canonical credentials mirror the enforced CI authentication contract:
 * a non-empty username AND a non-empty password.
 */
export function validateTestDatabaseCredentials(parsed: ParsedTestDatabaseUrl): void {
  if (!parsed.username) {
    throw new TestEnvContractError(
      'TEST_ENV_TEST_DATABASE_URL_USERNAME_REQUIRED',
      `TEST_DATABASE_URL must include a non-empty username (${redactTestDatabaseUrl(parsed.raw)}). ` +
        'A userinfo-less URL reaches libpq with an empty user name.',
    );
  }
  if (!parsed.password) {
    throw new TestEnvContractError(
      'TEST_ENV_TEST_DATABASE_URL_PASSWORD_REQUIRED',
      `TEST_DATABASE_URL must include a non-empty password (${redactTestDatabaseUrl(parsed.raw)}).`,
    );
  }
}

/**
 * Database identity. CI may use the ephemeral service-owned `servora_med_test`;
 * a local canonical run must use an explicitly isolated name so that two
 * worktrees cannot silently share one persistent database.
 */
export function validateTestDatabaseIdentity(
  parsed: ParsedTestDatabaseUrl,
  options: { ci: boolean },
): void {
  if (isProtectedTestDatabaseName(parsed.databaseName)) {
    throw new TestEnvContractError(
      'TEST_ENV_PROTECTED_DATABASE_NAME',
      `TEST_DATABASE_URL targets the protected database "${parsed.databaseName}". Refusing to run tests.`,
    );
  }
  if (options.ci) return;
  if (isSharedLocalTestDatabaseName(parsed.databaseName)) {
    throw new TestEnvContractError(
      'TEST_ENV_SHARED_TEST_DATABASE_NAME',
      `TEST_DATABASE_URL targets the shared persistent test database "${SHARED_LOCAL_TEST_DATABASE_NAME}". ` +
        `Local runs must use an explicitly isolated name such as "${ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX}<suffix>" ` +
        'so concurrent worktrees cannot collide.',
    );
  }
  if (!isIsolatedLocalTestDatabaseName(parsed.databaseName)) {
    throw new TestEnvContractError(
      'TEST_ENV_SHARED_TEST_DATABASE_NAME',
      `TEST_DATABASE_URL must target an explicitly isolated database name such as ` +
        `"${ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX}<suffix>" (received "${parsed.databaseName}").`,
    );
  }
}

/** Canonical local test tooling must target loopback only. */
export function validateTestDatabaseHost(
  parsed: ParsedTestDatabaseUrl,
  options: { ci: boolean },
): void {
  if (!options.ci && !isLoopbackHost(parsed.host)) {
    throw new TestEnvContractError(
      'TEST_ENV_NON_LOOPBACK_HOST',
      `TEST_DATABASE_URL must target a loopback host (${LOOPBACK_HOSTS.join(', ')}); received "${parsed.host}".`,
    );
  }
}

export function validateServerMajor(observedMajor: number): void {
  if (observedMajor !== REQUIRED_POSTGRES_MAJOR) {
    throw new TestEnvContractError(
      'TEST_ENV_POSTGRES_MAJOR_MISMATCH',
      `PostgreSQL server major must be ${REQUIRED_POSTGRES_MAJOR} for canonical parity; observed ${observedMajor}.`,
    );
  }
}

/**
 * Tools are enforced only when resolvable. An absent tool is reported
 * explicitly and its environment-dependent tests skip — it is never silently
 * substituted with a different major.
 */
export function validateToolMajor(tool: ToolName, observedMajor: number): void {
  if (observedMajor !== REQUIRED_POSTGRES_MAJOR) {
    throw new TestEnvContractError(
      'TEST_ENV_TOOL_MAJOR_MISMATCH',
      `${tool} major must be ${REQUIRED_POSTGRES_MAJOR} for canonical parity; observed ${observedMajor}.`,
    );
  }
}

export type BuildFreshnessStatus = 'ok' | 'missing' | 'stale';

export type BuildFreshnessInput = {
  missingArtifacts: readonly string[];
  oldestArtifactMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
};

/**
 * Timestamps, not hashing: a stale `dist/` must not be able to produce a false
 * green, and `npm run build` is the documented remedy.
 */
export function classifyBuildFreshness(input: BuildFreshnessInput): {
  status: BuildFreshnessStatus;
  missing: string[];
} {
  if (input.missingArtifacts.length > 0) {
    return { status: 'missing', missing: [...input.missingArtifacts] };
  }
  const { oldestArtifactMtimeMs, newestSourceMtimeMs } = input;
  if (
    oldestArtifactMtimeMs !== null &&
    newestSourceMtimeMs !== null &&
    oldestArtifactMtimeMs < newestSourceMtimeMs
  ) {
    return { status: 'stale', missing: [] };
  }
  return { status: 'ok', missing: [] };
}

export type SchemaProbeResult =
  | { kind: 'compatible'; summary: Record<string, unknown> }
  | { kind: 'incompatible'; status: string; summary: Record<string, unknown> }
  | { kind: 'history-missing'; summary: Record<string, unknown> }
  | { kind: 'catalog-invalid'; message: string }
  | { kind: 'unavailable'; message: string };

export type ToolProbeResult = {
  tool: ToolName;
  /** Resolved binary path, or null when the tool is not resolvable. */
  binary: string | null;
  /** Reported major, or null when the tool is absent / unparseable. */
  major: number | null;
  detail?: string;
};

export type PreflightDeps = {
  env: Record<string, string | undefined>;
  ci: boolean;
  cwd: string;
  probeServerMajor: () => Promise<number>;
  probeSchema: () => Promise<SchemaProbeResult>;
  probeTools: () => Promise<ToolProbeResult[]>;
  probeBuild: () => Promise<BuildFreshnessInput>;
};

export type PreflightResult = {
  ok: boolean;
  code?: TestEnvFailureCode;
  reason?: string;
  databaseName?: string;
  redactedUrl?: string;
  serverMajor?: number;
  tools: ToolProbeResult[];
  notes: string[];
};

function summarizeSchema(summary: Record<string, unknown>): string {
  const head = summary.catalogHead ?? 'unknown';
  const applied = summary.appliedHead ?? 'none';
  const pending = Array.isArray(summary.pendingVersions) ? summary.pendingVersions.join(',') : '';
  const unexpected = Array.isArray(summary.unexpectedVersions)
    ? summary.unexpectedVersions.join(',')
    : '';
  const duplicate = Array.isArray(summary.duplicateVersions)
    ? summary.duplicateVersions.join(',')
    : '';
  const reason = typeof summary.reason === 'string' ? ` reason=${summary.reason}` : '';
  return (
    `catalogHead=${String(head)} appliedHead=${String(applied)}` +
    (pending ? ` pending=${pending}` : '') +
    (unexpected ? ` unexpected=${unexpected}` : '') +
    (duplicate ? ` duplicate=${duplicate}` : '') +
    reason
  );
}

/**
 * The single fail-closed contract. Order matters: the first violated invariant
 * wins, so diagnostics stay actionable instead of cascading.
 */
export async function runTestEnvPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const notes: string[] = [];
  const tools: ToolProbeResult[] = [];

  const fail = (code: TestEnvFailureCode, reason: string): PreflightResult => ({
    ok: false,
    code,
    reason,
    tools,
    notes,
  });

  let parsed: ParsedTestDatabaseUrl;
  try {
    parsed = parseTestDatabaseUrl(deps.env.TEST_DATABASE_URL);
    validateTestDatabaseCredentials(parsed);
    validateTestDatabaseIdentity(parsed, { ci: deps.ci });
    validateTestDatabaseHost(parsed, { ci: deps.ci });
  } catch (error) {
    if (error instanceof TestEnvContractError) return fail(error.code, error.message);
    throw error;
  }

  const base = {
    databaseName: parsed.databaseName,
    redactedUrl: redactTestDatabaseUrl(parsed.raw),
  };

  // --- PostgreSQL server major (read-only) --------------------------------
  let serverMajor: number;
  try {
    serverMajor = await deps.probeServerMajor();
  } catch (error) {
    return {
      ...fail(
        'TEST_ENV_DATABASE_UNAVAILABLE',
        `Could not read the PostgreSQL server version for ${base.redactedUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  try {
    validateServerMajor(serverMajor);
  } catch (error) {
    if (error instanceof TestEnvContractError) {
      return { ...fail(error.code, error.message), ...base, serverMajor };
    }
    throw error;
  }

  // --- client tool parity (enforced only when resolvable) -----------------
  try {
    const probed = await deps.probeTools();
    tools.push(...probed);
    for (const tool of probed) {
      if (tool.binary === null || tool.major === null) {
        notes.push(`tool ${tool.tool} not resolvable — dependent tests will be skipped`);
        continue;
      }
      validateToolMajor(tool.tool, tool.major);
    }
  } catch (error) {
    if (error instanceof TestEnvContractError) {
      return { ...fail(error.code, error.message), ...base, serverMajor };
    }
    throw error;
  }

  // --- schema head --------------------------------------------------------
  let schema: SchemaProbeResult;
  try {
    schema = await deps.probeSchema();
  } catch (error) {
    return {
      ...fail(
        'TEST_ENV_DATABASE_UNAVAILABLE',
        `Could not read the migration history for ${base.redactedUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
      ...base,
      serverMajor,
    };
  }
  if (schema.kind === 'catalog-invalid') {
    return {
      ...fail('TEST_ENV_MIGRATION_CATALOG_INVALID', `Migration catalog invalid: ${schema.message}`),
      ...base,
      serverMajor,
    };
  }
  if (schema.kind === 'unavailable') {
    return {
      ...fail('TEST_ENV_DATABASE_UNAVAILABLE', schema.message),
      ...base,
      serverMajor,
    };
  }
  if (schema.kind === 'history-missing') {
    return {
      ...fail(
        'TEST_ENV_SCHEMA_HISTORY_MISSING',
        `Database ${base.databaseName} has no migration history (missing schema_migrations). ` +
          'The preflight is read-only and does not migrate.',
      ),
      ...base,
      serverMajor,
    };
  }
  if (schema.kind === 'incompatible') {
    return {
      ...fail(
        'TEST_ENV_SCHEMA_NOT_COMPATIBLE',
        `Database ${base.databaseName} schema is ${schema.status}; the exact repository ` +
          `migration head is required (${summarizeSchema(schema.summary)}). ` +
          'The preflight is read-only and does not migrate.',
      ),
      ...base,
      serverMajor,
    };
  }
  notes.push(`schema COMPATIBLE (${summarizeSchema(schema.summary)})`);

  // --- build freshness ----------------------------------------------------
  const build = await deps.probeBuild();
  const freshness = classifyBuildFreshness(build);
  if (freshness.status === 'missing') {
    return {
      ...fail(
        'TEST_ENV_BUILD_MISSING',
        `Required build artifacts are missing: ${freshness.missing.join(', ')}. Run "npm run build".`,
      ),
      ...base,
      serverMajor,
    };
  }
  if (freshness.status === 'stale') {
    return {
      ...fail(
        'TEST_ENV_BUILD_STALE',
        'Build artifacts are older than their source inputs and cannot represent the current release. ' +
          'Run "npm run build".',
      ),
      ...base,
      serverMajor,
    };
  }
  notes.push('build artifacts present and fresh');

  return { ok: true, ...base, serverMajor, tools, notes };
}
