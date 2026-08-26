import { afterEach, describe, expect, it } from 'vitest';

import {
  PROTECTED_DEMO_DATABASE_NAME,
  assertDemoDestructiveTestDatabaseSafe,
  isProtectedDemoDatabase,
  parseDatabaseName,
  requireDemoDestructiveTestDatabaseUrl,
} from './support/demo-destructive-guard.js';

describe('demo destructive guard — database identity', () => {
  it('rejects exact protected name servora_med regardless of host representation', () => {
    expect(isProtectedDemoDatabase('postgresql://localhost:5432/servora_med')).toBe(true);
    expect(isProtectedDemoDatabase('postgresql://127.0.0.1:5432/servora_med')).toBe(true);
    expect(isProtectedDemoDatabase('postgresql://[::1]:5432/servora_med')).toBe(true);
    expect(isProtectedDemoDatabase('postgresql://localhost/servora_med?sslmode=require')).toBe(true);
    expect(isProtectedDemoDatabase('postgres://servora:secret@127.0.0.1:5432/servora_med')).toBe(true);
    expect(() => assertDemoDestructiveTestDatabaseSafe('postgresql://localhost:5432/servora_med')).toThrow(
      'REFUSING_TO_WRITE_TO_PROTECTED_DATABASE',
    );
  });

  it('does not reject disposable test database servora_med_test via substring', () => {
    expect(isProtectedDemoDatabase('postgresql://localhost:5432/servora_med_test')).toBe(false);
    expect(isProtectedDemoDatabase('postgresql://localhost:5432/servora_med_demo_test')).toBe(false);
    expect(() => assertDemoDestructiveTestDatabaseSafe('postgresql://localhost:5432/servora_med_test')).not.toThrow();
  });

  it('parses database name structurally, not via substring', () => {
    expect(parseDatabaseName('postgresql://localhost:5432/servora_med')).toBe('servora_med');
    expect(parseDatabaseName('postgresql://localhost:5432/servora_med_test')).toBe('servora_med_test');
    expect(parseDatabaseName('postgresql://localhost:5432/servora_med?sslmode=require')).toBe('servora_med');
    expect(parseDatabaseName('postgresql://user:pass@127.0.0.1:5432/servora_med')).toBe('servora_med');
    expect(parseDatabaseName('postgres://localhost/servora_med')).toBe('servora_med');
    // protected name rejected even when host varies; disposable not rejected when name contains substring
    expect(parseDatabaseName('postgresql://[::1]:5432/servora_med')).toBe('servora_med');
  });

  it('throws diagnostic without leaking password', () => {
    const urlWithSecret = 'postgresql://servora:s3cr3t@localhost:5432/servora_med';
    try {
      assertDemoDestructiveTestDatabaseSafe(urlWithSecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain('REFUSING_TO_WRITE_TO_PROTECTED_DATABASE');
      expect(message).toContain('servora_med');
      expect(message).not.toContain('s3cr3t');
    }
  });
});

describe('demo destructive guard — TEST_DATABASE_URL requirement', () => {
  const original = process.env.TEST_DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = original;
  });

  it('requires TEST_DATABASE_URL and never falls back to DATABASE_URL', () => {
    delete process.env.TEST_DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://localhost:5432/servora_med';
    expect(() => requireDemoDestructiveTestDatabaseUrl()).toThrow('TEST_DATABASE_URL is required');
  });

  it('rejects protected servora_med even when TEST_DATABASE_URL is explicitly set', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://localhost:5432/servora_med';
    expect(() => requireDemoDestructiveTestDatabaseUrl()).toThrow('REFUSING_TO_WRITE_TO_PROTECTED_DATABASE');
  });

  it('accepts disposable servora_med_test', () => {
    process.env.TEST_DATABASE_URL = 'postgresql://localhost:5432/servora_med_test';
    expect(requireDemoDestructiveTestDatabaseUrl()).toBe('postgresql://localhost:5432/servora_med_test');
  });

  it('protected guard helper uses exact match, not substring', () => {
    expect(PROTECTED_DEMO_DATABASE_NAME).toBe('servora_med');
    expect(isProtectedDemoDatabase('postgresql://localhost/servora_med_test')).toBe(false);
  });
});
