import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../src/db/migrations/003_people.sql', import.meta.url),
);

let sql = '';

beforeAll(async () => {
  sql = await readFile(migrationPath, 'utf8');
});

describe('003_people migration contract', () => {
  it('adds the organization timezone required by Staff counters', () => {
    expect(sql).toMatch(
      /ALTER TABLE organizations\s+ADD COLUMN timezone VARCHAR\(64\) NOT NULL DEFAULT 'Europe\/Istanbul'/i,
    );
  });

  it('adds positive optimistic versions to users and Staff profiles', () => {
    expect(sql).toMatch(
      /ALTER TABLE users\s+ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i,
    );
    expect(sql).toMatch(
      /CREATE TABLE staff_profiles[\s\S]*version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i,
    );
  });

  it('creates one profile per user without duplicate lifecycle fields', () => {
    const profileTable = sql.match(/CREATE TABLE staff_profiles \(([\s\S]*?)\n\);/i)?.[1] ?? '';

    expect(profileTable).toMatch(/user_id UUID NOT NULL UNIQUE/i);
    expect(profileTable).toMatch(
      /FOREIGN KEY \(organization_id, user_id\)\s+REFERENCES users \(organization_id, id\)/i,
    );
    expect(profileTable).toMatch(
      /FOREIGN KEY \(organization_id, manager_user_id\)\s+REFERENCES users \(organization_id, id\)/i,
    );
    expect(profileTable).not.toMatch(/\b(is_active|notes|monthly_target)\b/i);
  });

  it('creates generic audit storage without credential columns', () => {
    const auditTable = sql.match(/CREATE TABLE audit_events \(([\s\S]*?)\n\);/i)?.[1] ?? '';

    expect(auditTable).toContain('old_value JSONB');
    expect(auditTable).toContain('new_value JSONB');
    expect(auditTable).toContain("metadata JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(auditTable).not.toMatch(/^\s*(password|password_hash|token|cookie|session_id)\s/im);
  });
});
