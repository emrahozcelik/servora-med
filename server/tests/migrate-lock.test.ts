import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MIGRATION_ADVISORY_LOCK_KEY } from '../src/db/index.js';

describe('migration lock contract', () => {
  it('defines a stable advisory lock key', () => {
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBe(872_014_011);
  });

  it('keeps process start free of runMigrations', () => {
    const indexPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const source = readFileSync(indexPath, 'utf8');
    expect(source).not.toMatch(/runMigrations\s*\(/);
    expect(source).toMatch(/migrate \/ migrate:prod/);
  });
});
