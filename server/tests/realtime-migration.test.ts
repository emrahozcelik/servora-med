import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/011_create_realtime_events.sql',
  import.meta.url,
);

describe('011 realtime event migration', () => {
  it('creates the durable audience-filtered event ledger', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain('CREATE TABLE realtime_events');
    expect(sql).toMatch(/id\s+BIGINT\s+GENERATED ALWAYS AS IDENTITY\s+PRIMARY KEY/i);
    expect(sql).toMatch(/source_activity_id\s+UUID\s+NOT NULL\s+UNIQUE/i);
    expect(sql).toContain('REFERENCES job_card_activity_logs(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES organizations(id) ON DELETE CASCADE');
    expect(sql).toContain("entity_type = 'job-card'");
    expect(sql).toContain("cardinality(resource_keys) > 0");
    expect(sql).toContain("audience_roles <@ ARRAY['ADMIN', 'MANAGER']");
    expect(sql).toContain(
      'cardinality(audience_roles) > 0 OR cardinality(audience_user_ids) > 0',
    );
    expect(sql).toContain(
      'CREATE INDEX realtime_events_organization_cursor_idx',
    );
    expect(sql).toContain(
      'CREATE INDEX realtime_events_audience_users_gin_idx',
    );
    expect(sql).toContain(
      'CREATE INDEX realtime_events_audience_roles_gin_idx',
    );
    expect(sql).not.toMatch(/\bpayload\b/i);
  });
});
