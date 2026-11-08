import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../src/db/migrations/062_backup_health_maintenance.sql', import.meta.url);

describe('062 backup health maintenance contract', () => {
  it('seeds PAUSED, has a monotonic CAS transition and audit ledger', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
    expect(sql).toContain('CREATE TABLE backup_health_maintenance_state');
    expect(sql).toContain('CREATE TABLE backup_health_maintenance_events');
    expect(sql).toContain("VALUES (TRUE, TRUE, 0, 'INITIAL_HOLD'");
    expect(sql).toContain('revision = p_expected_revision');
    expect(sql).toContain('paused IS DISTINCT FROM p_next_paused');
    expect(sql).toContain('CREATE TRIGGER backup_health_maintenance_audit');
    expect(sql).toContain('CREATE TRIGGER backup_health_maintenance_events_immutable');
    expect(sql).toContain('REVOKE ALL ON FUNCTION backup_health_maintenance_transition');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b|\bTRUNCATE\s+TABLE/i);
  });
});
