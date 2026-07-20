import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/012_create_in_app_notifications.sql',
  import.meta.url,
);

describe('012 in-app notifications migration', () => {
  it('creates a tenant-safe recipient notification read model', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain('CREATE TABLE in_app_notifications');
    expect(sql).toMatch(
      /ALTER TABLE realtime_events[\s\S]*UNIQUE \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, recipient_user_id\)[\s\S]*REFERENCES users \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \(organization_id, source_realtime_event_id\)[\s\S]*REFERENCES realtime_events \(organization_id, id\)/i,
    );
    expect(sql).toMatch(
      /UNIQUE \(recipient_user_id, source_realtime_event_id\)/i,
    );
    expect(sql).toMatch(
      /CHECK \(kind IN \([\s\S]*'job\.assigned'[\s\S]*'job\.reassigned'[\s\S]*'job\.awaiting_approval'[\s\S]*'job\.approved'[\s\S]*'job\.revision_requested'[\s\S]*'job\.cancelled'[\s\S]*\)\)/i,
    );
  });
});
