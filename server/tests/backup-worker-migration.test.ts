import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../src/db/migrations/033_backup_worker_runtime.sql', import.meta.url);

describe('033 backup worker runtime migration', () => {
  it('adds lease ownership, durable scheduler dedupe, liveness, and system audit support', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
    expect(sql).toContain('lease_token UUID');
    expect(sql).toContain('lease_until TIMESTAMPTZ');
    expect(sql).toContain('heartbeat_at TIMESTAMPTZ');
    expect(sql).toContain('CREATE TABLE backup_worker_state');
    expect(sql).toContain('last_scheduled_slot_key');
    expect(sql).toContain("'BACKUP_STARTED'");
    expect(sql).toContain("'BACKUP_VERIFIED'");
    expect(sql).toContain("'BACKUP_COMPLETED'");
    expect(sql).toContain("'BACKUP_FAILED'");
  });
});
