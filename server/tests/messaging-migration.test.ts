import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/018_messaging.sql',
  import.meta.url,
);

describe('018 messaging migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('creates conversations, messages, participants, and activity ledger', () => {
    expect(sql).toContain('CREATE TABLE conversations');
    expect(sql).toContain('CREATE TABLE messages');
    expect(sql).toContain('CREATE TABLE conversation_participants');
    expect(sql).toContain('CREATE TABLE messaging_activity_logs');

    expect(sql).toMatch(/direct_key\s+VARCHAR/);
    expect(sql).toContain('UNIQUE (organization_id, direct_key)');
    expect(sql).toContain("context_type IN ('GENERAL', 'JOB')");
    expect(sql).toContain('REFERENCES job_cards');
  });

  it('enforces organization isolation on every table', () => {
    expect(sql).toContain('FOREIGN KEY (organization_id, conversation_id)');
    expect(sql).toContain('REFERENCES organizations(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES users (organization_id, id)');
  });

  it('protects message body length and does not restrict literal text', () => {
    expect(sql).toContain('length(body) BETWEEN 1 AND 4000');
    expect(sql).not.toContain("body !~ '<[a-zA-Z/]'");
    expect(sql).toContain('CONSTRAINT messages_body_check');
  });

  it('ensures idempotent send via client_action_id uniqueness', () => {
    expect(sql).toContain(
      'UNIQUE (conversation_id, sender_user_id, client_action_id)',
    );
  });

  it('uses composite PK with conversation_id for message clustering', () => {
    expect(sql).toContain('PRIMARY KEY (conversation_id, id)');
  });

  it('supports pagination with organization-scoped cursor index', () => {
    expect(sql).toContain(
      'CREATE INDEX messages_organization_cursor_idx',
    );
  });

  it('extends notifications with message.received kind', () => {
    expect(sql).toContain("'conversation'");
    expect(sql).toContain("'message.received'");
  });

  it('extends realtime events with conversation and message types', () => {
    expect(sql).toContain('messaging_activity_id');
    expect(sql).toContain("'conversation.created'");
    expect(sql).toContain("'message.sent'");
    expect(sql).toContain("'conversation'");
  });

  it('creates de-duplicated messaging activity logs', () => {
    expect(sql).toContain(
      "CONSTRAINT messaging_activity_action_check",
    );
    expect(sql).toContain(
      "action IN ('CONVERSATION_CREATED', 'MESSAGE_SENT', 'READ_CURSOR_UPDATED')",
    );
    expect(sql).toContain(
      'UNIQUE (organization_id, actor_user_id, client_action_id, action)',
    );
  });

  it('does not carry message body in any notification column', () => {
    expect(sql).not.toMatch(/\bpayload\b/i);
    expect(sql).not.toMatch(/\bpreview\b/i);
    expect(sql).not.toContain('message_body');
  });
});
