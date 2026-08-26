export const PROTECTED_DEMO_DATABASE_NAME = 'servora_med' as const;

export function parseDatabaseName(connectionString: string): string {
  const trimmed = connectionString.trim();
  if (!trimmed) throw new Error('Database connection string must not be empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Database connection string must be a valid URL');
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    throw new Error('Database URL must be postgresql:// or postgres://');
  }
  // pathname is "/dbname" possibly with trailing slash or encoded
  const rawPath = url.pathname;
  if (!rawPath || rawPath === '/') return '';
  const withoutLeading = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  const withoutTrailing = withoutLeading.endsWith('/') ? withoutLeading.slice(0, -1) : withoutLeading;
  // database name is first segment before '?' or '/' (query already stripped by URL)
  const firstSegment = withoutTrailing.split('/')[0] ?? '';
  return decodeURIComponent(firstSegment);
}

export function isProtectedDemoDatabase(connectionString: string): boolean {
  return parseDatabaseName(connectionString) === PROTECTED_DEMO_DATABASE_NAME;
}

export function assertDemoDestructiveTestDatabaseSafe(connectionString: string): void {
  if (isProtectedDemoDatabase(connectionString)) {
    throw new Error(
      'REFUSING_TO_WRITE_TO_PROTECTED_DATABASE: destructive Demo tests must not target database "servora_med". Use TEST_DATABASE_URL pointing to a disposable database (e.g. servora_med_test).',
    );
  }
}

export function requireDemoDestructiveTestDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is required for destructive Demo lifecycle tests. Refusing to fall back to DATABASE_URL which may target protected "servora_med".',
    );
  }
  assertDemoDestructiveTestDatabaseSafe(testUrl);
  return testUrl;
}
