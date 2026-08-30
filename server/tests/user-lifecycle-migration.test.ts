import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe('041 User lifecycle reconciliation migration contract', () => {
  it('only extends the audit vocabulary and cannot perform user or business cleanup', async () => {
    const migration = await readFile(path.join(migrationsDirectory, '041_user_lifecycle_reconciliation.sql'), 'utf8');
    expect(migration).toContain("'USER_DELETED'");
    expect(migration).toContain('audit_events_event_type_check');
    expect(migration).not.toMatch(/^\s*DELETE\s+FROM\s+(users|customers|job_cards|messages|calendar_events)/im);
    expect(migration).not.toMatch(/DROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)/i);
  });
});
