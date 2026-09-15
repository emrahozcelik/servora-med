import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/046_notification_state_realtime.sql',
  import.meta.url,
);
const previousEventCheckUrl = new URL(
  '../src/db/migrations/036_job_card_invalidated.sql',
  import.meta.url,
);
const previousSourceCheckUrl = new URL(
  '../src/db/migrations/023_staff_confidential_notes.sql',
  import.meta.url,
);

const PRESERVED_EVENT_TYPES = [
  'job.created',
  'job.assignment_changed',
  'job.accepted',
  'job.started',
  'job.submitted_for_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
  'job.invalidated',
  'job.updated',
  'calendar.created',
  'calendar.updated',
  'calendar.cancelled',
  'calendar.reminder_due',
  'message.sent',
  'conversation.created',
  'confidential-note.created',
  'conversation.participants_changed',
];

const PRESERVED_ENTITY_TYPES = [
  'job-card',
  'calendar-event',
  'conversation',
  'confidential-note',
];

const SOURCE_COLUMNS = [
  'source_activity_id',
  'calendar_activity_id',
  'calendar_reminder_id',
  'messaging_activity_id',
  'staff_note_id',
];

describe('046 notification state realtime migration', () => {
  it('documents why head 045 cannot persist a source-less notification event', async () => {
    const eventCheck = await readFile(fileURLToPath(previousEventCheckUrl), 'utf8');
    for (const type of PRESERVED_EVENT_TYPES) {
      expect(eventCheck).toContain(`'${type}'`);
    }
    expect(eventCheck).not.toContain('notification.state_changed');

    const sourceCheck = await readFile(fileURLToPath(previousSourceCheckUrl), 'utf8');
    expect(sourceCheck).toMatch(/=\s*1/);
    expect(sourceCheck).not.toContain('notification.state_changed');
  });

  it('adds exactly one generic state type and one semantic entity type', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain("'notification.state_changed'");
    expect(sql).toContain("'notification-center'");
    expect(sql).not.toMatch(/\bpayload\b/i);
    expect(sql).not.toContain('in_app_notifications');
  });

  it('preserves the full existing event and entity allowlists', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    for (const type of PRESERVED_EVENT_TYPES) {
      expect(sql).toContain(`'${type}'`);
    }
    for (const entity of PRESERVED_ENTITY_TYPES) {
      expect(sql).toContain(`'${entity}'`);
    }
  });

  it('creates a narrow source-less exception instead of weakening the invariant', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    // Exact-one-source branch preserved verbatim in structure.
    expect(sql).toMatch(/=\s*1/);
    for (const column of SOURCE_COLUMNS) {
      expect(sql).toContain(`(${column} IS NOT NULL)::INTEGER`);
    }
    // Exception branch: only notification.state_changed, every source NULL.
    expect(sql).toContain("event_type = 'notification.state_changed'");
    for (const column of SOURCE_COLUMNS) {
      expect(sql).toContain(`${column} IS NULL`);
    }
    // No foreign key or unique constraint on existing sources is touched.
    expect(sql).not.toMatch(/DROP CONSTRAINT realtime_events_\w+_(fk|unique)/i);
    expect(sql).not.toContain('ADD COLUMN');
  });
});
