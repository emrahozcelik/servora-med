import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../src/db/migrations/035_demo_data_purge_foundation.sql', import.meta.url),
);

describe('035 demo data purge foundation migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(migrationPath, 'utf8');
  });

  it('retains purge receipts and tombstone attribution without destructive migration SQL', () => {
    expect(sql).toContain('CREATE TABLE demo_dataset_purge_operations');
    expect(sql).toContain('created_by_user_id_snapshot');
    expect(sql).toContain('actor_user_id_snapshot');
    expect(sql).toContain('status IN (\'PROCESSING\', \'COMPLETED\')');
    expect(sql).toContain('UNIQUE (organization_id, client_action_id)');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE)\b|\bDELETE\s+FROM|\bTRUNCATE\b/i);
  });

  it('protects live-versus-snapshot actor attribution with checks', () => {
    expect(sql).toContain('audit_events_actor_attribution_check');
    expect(sql).toContain('demo_datasets_creator_attribution_check');
    expect(sql).toMatch(/actor_user_id IS NOT NULL[\s\S]*actor_user_id_snapshot IS NULL/i);
    expect(sql).toMatch(/actor_user_id IS NULL[\s\S]*actor_user_id_snapshot IS NOT NULL/i);
  });
});
