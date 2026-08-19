import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/029_messaging_conversation_archive.sql',
  import.meta.url,
);

describe('029 messaging conversation archive migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('creates tenant-scoped per-user conversation archive state', () => {
    expect(sql).toContain('CREATE TABLE conversation_user_states');
    expect(sql).toMatch(/archived_at\s+TIMESTAMPTZ/);
    expect(sql).toContain('FOREIGN KEY (organization_id, conversation_id)');
    expect(sql).toContain('FOREIGN KEY (organization_id, user_id)');
    expect(sql).toContain('conversation_user_states_user_archive_idx');
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|SCHEMA|DATABASE)|\bDELETE\s+FROM/i);
  });
});
