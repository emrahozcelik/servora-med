import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/025_messaging_context_ready.sql',
  import.meta.url,
);

describe('025 messaging context-ready migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('widens context_type to JOB | CUSTOMER | GENERAL', () => {
    expect(sql).toMatch(
      /context_type IN \('GENERAL', 'JOB', 'CUSTOMER'\)/,
    );
    expect(sql).not.toMatch(/context_type IN \('GENERAL', 'JOB'\)/);
  });

  it('adds customer_id and title columns', () => {
    expect(sql).toMatch(/ADD COLUMN customer_id UUID/);
    expect(sql).toMatch(/ADD COLUMN title VARCHAR\(255\)/);
  });

  it('enforces a three-way context scope check', () => {
    expect(sql).toMatch(/context_type = 'GENERAL' AND job_id IS NULL AND customer_id IS NULL/);
    expect(sql).toMatch(/context_type = 'JOB' AND job_id IS NOT NULL AND customer_id IS NULL/);
    expect(sql).toMatch(/context_type = 'CUSTOMER' AND customer_id IS NOT NULL AND job_id IS NULL/);
  });

  it('links customer context with an organization-scoped FK', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, customer_id\)\s*REFERENCES customers \(organization_id, id\) ON DELETE RESTRICT/,
    );
  });

  it('fixes the latent JOB FK defect: SET NULL becomes RESTRICT', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, job_id\)\s*REFERENCES job_cards \(organization_id, id\) ON DELETE RESTRICT/,
    );
    expect(sql).not.toMatch(/REFERENCES job_cards \(organization_id, id\) ON DELETE SET NULL/);
  });

  it('requires a meaningful title for CUSTOMER threads', () => {
    expect(sql).toMatch(
      /context_type <> 'CUSTOMER'\s+OR\s+\(title IS NOT NULL AND length\(trim\(title\)\) > 0\)/,
    );
  });

  it('rejects blank titles whenever a title is present', () => {
    expect(sql).toMatch(
      /title IS NULL OR length\(trim\(title\)\) > 0/,
    );
  });

  it('freezes the canonical JOB thread invariant with a partial unique index', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX conversations_job_context_unique\s*ON conversations \(organization_id, job_id\)\s*WHERE context_type = 'JOB'/,
    );
  });

  it('fails clearly before creating the JOB uniqueness index on duplicate legacy rows', () => {
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/HAVING COUNT\(\*\) > 1/);
  });

  it('keeps legacy GENERAL direct conversations (no title) valid', () => {
    expect(sql).toMatch(/ADD COLUMN title VARCHAR\(255\)/);
    expect(sql).not.toMatch(/context_type = 'GENERAL' AND title IS NOT NULL/);
  });
});
