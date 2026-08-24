import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../src/db/migrations/034_demo_data_foundation.sql', import.meta.url),
);

describe('034 demo data foundation migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(migrationPath, 'utf8');
  });

  it('creates explicit BUSINESS/DEMO lineage with protective dataset ownership and no destructive SQL', () => {
    expect(sql).toContain('CREATE TABLE demo_datasets');
    expect(sql).toMatch(/data_class[^\n]*DEFAULT 'BUSINESS'/i);
    expect(sql).toMatch(/data_class\s*=\s*'BUSINESS'/i);
    expect(sql).toMatch(/data_class\s*=\s*'DEMO'/i);
    expect(sql).toContain('demo_dataset_id');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b|\bDELETE\s+FROM|\bTRUNCATE\b/i);
  });

  it('enforces tenant-consistent dataset lineage on every root aggregate', () => {
    const rootTables = ['users', 'customers', 'products', 'job_cards', 'conversations', 'calendar_events'];

    for (const table of rootTables) {
      const block = sql.match(new RegExp(`ALTER TABLE ${table}[\\s\\S]*?(?=\\nALTER TABLE|\\nCREATE INDEX|$)`))?.[0];
      expect(block, `${table} migration block`).toBeTruthy();
      expect(block).toMatch(/ADD COLUMN data_class VARCHAR\(20\) NOT NULL DEFAULT 'BUSINESS'/i);
      expect(block).toMatch(new RegExp(`${table}_data_class_check`));
      expect(block).toMatch(/data_class\s*=\s*'BUSINESS'\s+AND\s+demo_dataset_id\s+IS\s+NULL/i);
      expect(block).toMatch(/data_class\s*=\s*'DEMO'\s+AND\s+demo_dataset_id\s+IS\s+NOT\s+NULL/i);
      expect(block).toContain('FOREIGN KEY (organization_id, demo_dataset_id)');
      expect(block).toContain('REFERENCES demo_datasets (organization_id, id) ON DELETE RESTRICT');
    }
  });

  it('documents that legacy rows are explicit BUSINESS defaults, not inferred demo data', () => {
    expect(sql).toMatch(/Existing rows receive BUSINESS as an explicit schema default/i);
    expect(sql).not.toMatch(/\bUPDATE\s+(users|customers|products|job_cards|conversations|calendar_events)\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+(users|customers|products|job_cards|conversations|calendar_events)\b/i);
  });
});
