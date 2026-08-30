import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { assertDemoDestructiveTestDatabaseSafe } from './support/demo-destructive-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) assertDemoDestructiveTestDatabaseSafe(databaseUrl);
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 8 }) : null;
const organizationIds: string[] = [];

type Role = 'ADMIN' | 'MANAGER' | 'STAFF';
type DataClass = 'BUSINESS' | 'DEMO';

type Fixture = {
  organizationId: string;
  datasetId: string;
  adminId: string;
  managerId: string;
  demoManagerId: string;
  staffId: string;
  businessStaffId: string;
  admin: SafeUser;
  manager: SafeUser;
  staff: SafeUser;
  service: DemoDatasetService;
};

type JobSpec = {
  type?: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';
  status?: 'NEW' | 'IN_PROGRESS';
  title: string;
  assignedTo: string;
  createdBy: string;
  customerId?: string | null;
  contactId?: string | null;
  sourceJobCardId?: string | null;
  followUpInstructions?: string | null;
  dataClass?: DataClass;
  datasetId?: string | null;
};

type Graph = {
  customerId: string;
  contactId: string;
  productId: string;
  parentJobId: string;
  childJobId: string;
  parentActivityId: string;
  childActivityId: string;
  locationId: string;
  meetingJobId: string;
  calendarEventId: string;
  calendarActivityId: string;
  reminderId: string;
  conversationId: string;
  messageId: string;
  participantPairs: Array<{ conversationId: string; userId: string }>;
  userStatePairs: Array<{ conversationId: string; userId: string }>;
  messagingActivityId: string;
  staffNoteId: string;
  realtimeIds: string[];
  notificationIds: string[];
  subscriptionId: string;
  deliveryId: string;
  sessionId: string;
  processedActionId: string;
  auditEventId: string;
};

async function first<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
  const result = await pool!.query<T>(sql, values as unknown[]);
  const row = result.rows[0];
  if (!row) throw new Error(`Expected one row for SQL: ${sql}`);
  return row;
}

async function cleanupOrganization(organizationId: string) {
  if (!pool) return;

  await pool.query('DROP TRIGGER IF EXISTS r2a_acceptance_rollback_trigger ON job_card_delivery_items');
  await pool.query('DROP FUNCTION IF EXISTS r2a_acceptance_rollback_failure()');
  await pool.query('DELETE FROM backup_runs WHERE created_by IN (SELECT id FROM users WHERE organization_id = $1)', [organizationId]);
  await pool.query('DELETE FROM web_push_deliveries WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM in_app_notifications WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM realtime_events WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM calendar_reminders WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM calendar_event_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM calendar_events WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM conversation_user_states WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM conversation_participants WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM messages WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM messaging_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM conversations WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_action_locations WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_notes WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_delivery_items WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_meeting_details WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM staff_confidential_notes WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_card_activity_logs WHERE organization_id = $1', [organizationId]);
  await pool.query('UPDATE job_cards SET source_job_card_id = NULL, follow_up_instructions = NULL WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM job_cards WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM contacts WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM customers WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM products WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM web_push_subscriptions WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)', [organizationId]);
  await pool.query('DELETE FROM processed_actions WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM audit_events WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM staff_profiles WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM demo_dataset_purge_operations WHERE organization_id = $1', [organizationId]);
  await pool.query("UPDATE users SET data_class = 'BUSINESS', demo_dataset_id = NULL WHERE organization_id = $1", [organizationId]);
  await pool.query('DELETE FROM demo_datasets WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM users WHERE organization_id = $1', [organizationId]);
  await pool.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
}

async function createFixture(): Promise<Fixture> {
  const organizationId = (await first<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [`R2A acceptance ${randomUUID()}`],
  )).id;
  organizationIds.push(organizationId);

  const ids = {
    adminId: randomUUID(),
    managerId: randomUUID(),
    demoManagerId: randomUUID(),
    staffId: randomUUID(),
    businessStaffId: randomUUID(),
  };
  const users: Array<[string, string, Role, string]> = [
    [ids.adminId, 'Acceptance Admin', 'ADMIN', `admin-${randomUUID()}@r2a.synthetic`],
    [ids.managerId, 'Acceptance Manager', 'MANAGER', `manager-${randomUUID()}@r2a.synthetic`],
    [ids.demoManagerId, 'Demo Manager', 'MANAGER', `demo-manager-${randomUUID()}@r2a.synthetic`],
    [ids.staffId, 'Demo Staff', 'STAFF', `staff-${randomUUID()}@r2a.synthetic`],
    [ids.businessStaffId, 'Business Staff', 'STAFF', `business-staff-${randomUUID()}@r2a.synthetic`],
  ];
  for (const [id, name, role, email] of users) {
    await pool!.query(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'synthetic-test-hash', $5)`,
      [id, organizationId, name, email, role],
    );
  }

  const datasetId = (await first<{ id: string }>(
    `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
     VALUES ($1, $2, 'r2a-acceptance', $3) RETURNING id`,
    [organizationId, `dataset-${randomUUID()}`, ids.staffId],
  )).id;
  await pool!.query(
    `UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2
     WHERE organization_id = $1 AND id = ANY($3::uuid[])`,
    [organizationId, datasetId, [ids.demoManagerId, ids.staffId]],
  );
  await pool!.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title, manager_user_id)
     VALUES ($1, $2, 'Demo Manager Profile', NULL),
            ($1, $3, 'Demo Staff Profile', $2),
            ($1, $4, 'Business Staff Profile', $5)`,
    [organizationId, ids.demoManagerId, ids.staffId, ids.businessStaffId, ids.managerId],
  );

  const service = new DemoDatasetService(new PostgresDemoDatasetRepository(pool!));
  const admin: SafeUser = {
    id: ids.adminId,
    organizationId,
    name: 'Acceptance Admin',
    email: users[0]![3],
    role: 'ADMIN',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  const manager: SafeUser = {
    id: ids.managerId,
    organizationId,
    name: 'Acceptance Manager',
    email: users[1]![3],
    role: 'MANAGER',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  const staff: SafeUser = {
    id: ids.staffId,
    organizationId,
    name: 'Demo Staff',
    email: users[3]![3],
    role: 'STAFF',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
  return {
    organizationId,
    datasetId,
    ...ids,
    admin,
    manager,
    staff,
    service,
  };
}

async function insertJob(fixture: Fixture, spec: JobSpec) {
  const dataClass = spec.dataClass ?? 'DEMO';
  const datasetId = spec.datasetId === undefined
    ? fixture.datasetId
    : spec.datasetId;
  const status = spec.status ?? 'NEW';
  const startedAt = status === 'IN_PROGRESS' ? new Date() : null;
  return (await first<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, contact_id,
        assigned_to, created_by, priority, started_at, source_job_card_id,
        follow_up_instructions, engagement_kind, data_class, demo_dataset_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'normal', $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [fixture.organizationId, spec.type ?? 'GENERAL_TASK', status, spec.title,
      spec.customerId ?? null, spec.contactId ?? null, spec.assignedTo, spec.createdBy,
      startedAt, spec.sourceJobCardId ?? null, spec.followUpInstructions ?? null,
      spec.type === 'SALES_MEETING' ? 'SALES_MEETING' : null, dataClass, datasetId],
  )).id;
}

async function insertJobActivity(fixture: Fixture, jobId: string, actorId: string, eventType: 'JOB_CREATED' | 'JOB_STARTED') {
  return (await first<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type, new_value, client_action_id)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5) RETURNING id`,
    [fixture.organizationId, jobId, actorId, eventType, randomUUID()],
  )).id;
}

async function insertRealtime(
  fixture: Fixture,
  source: 'source_activity_id' | 'calendar_activity_id' | 'calendar_reminder_id' | 'messaging_activity_id' | 'staff_note_id',
  sourceId: string,
  eventType: string,
  entityType: string,
  entityId: string,
) {
  return (await first<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, ${source}, event_type, entity_type, entity_id,
        actor_user_id, audience_user_ids, resource_keys)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::text[])
     RETURNING id::text AS id`,
    [fixture.organizationId, sourceId, eventType, entityType, entityId,
      fixture.demoManagerId, [fixture.staffId], [`${entityType}:${entityId}`]],
  )).id;
}

async function insertNotification(fixture: Fixture, realtimeId: string, kind: string, entityType: string, entityId: string) {
  return (await first<{ id: string }>(
    `INSERT INTO in_app_notifications
       (organization_id, recipient_user_id, source_realtime_event_id, kind, entity_type, entity_id)
     VALUES ($1, $2, $3::bigint, $4, $5, $6) RETURNING id`,
    [fixture.organizationId, fixture.staffId, realtimeId, kind, entityType, entityId],
  )).id;
}

async function createFullGraph(fixture: Fixture): Promise<Graph> {
  const customerId = (await first<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
     VALUES ($1, 'Demo Acceptance Clinic', 'clinic', $2, 'active', 'DEMO', $3) RETURNING id`,
    [fixture.organizationId, fixture.staffId, fixture.datasetId],
  )).id;
  const contactId = (await first<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, title, is_primary)
     VALUES ($1, $2, 'Demo Contact', 'Purchasing', TRUE) RETURNING id`,
    [fixture.organizationId, customerId],
  )).id;
  const productId = (await first<{ id: string }>(
    `INSERT INTO products
       (organization_id, sku, name, brand, category, model, unit, data_class, demo_dataset_id)
     VALUES ($1, $2, 'Demo Product', 'Synthetic', 'Dental', 'M-1', 'adet', 'DEMO', $3)
     RETURNING id`,
    [fixture.organizationId, `R2A-${randomUUID()}`, fixture.datasetId],
  )).id;
  const parentJobId = await insertJob(fixture, {
    type: 'SALES_MEETING',
    title: 'Demo parent meeting',
    assignedTo: fixture.staffId,
    createdBy: fixture.demoManagerId,
    customerId,
    contactId,
  });
  const childJobId = await insertJob(fixture, {
    type: 'PRODUCT_DELIVERY',
    status: 'IN_PROGRESS',
    title: 'Demo child delivery',
    assignedTo: fixture.staffId,
    createdBy: fixture.demoManagerId,
    customerId,
    contactId,
    sourceJobCardId: parentJobId,
    followUpInstructions: 'Synthetic follow-up delivery',
  });
  await pool!.query(
    `INSERT INTO job_card_delivery_items
       (organization_id, job_card_id, product_id, delivery_purpose, delivered_at,
        quantity, unit, product_name_snapshot, product_sku_snapshot, delivery_note)
     VALUES ($1, $2, $3, 'SALE', NOW(), 2, 'adet', 'Demo Product', 'R2A', 'Synthetic delivery')`,
    [fixture.organizationId, childJobId, productId],
  );
  const parentActivityId = await insertJobActivity(fixture, parentJobId, fixture.demoManagerId, 'JOB_CREATED');
  const childActivityId = await insertJobActivity(fixture, childJobId, fixture.staffId, 'JOB_STARTED');
  const locationId = (await first<{ id: string }>(
    `INSERT INTO job_action_locations
       (organization_id, job_card_id, activity_id, actor_user_id, action,
        capture_outcome, failure_reason, geocoding_status)
     VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'UNAVAILABLE', 'UNKNOWN', 'NOT_REQUESTED')
     RETURNING id`,
    [fixture.organizationId, childJobId, childActivityId, fixture.staffId],
  )).id;
  await pool!.query(
    `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note, record_version)
     VALUES ($1, $2, $3, 'Synthetic operational note', 0)`,
    [fixture.organizationId, childJobId, fixture.staffId],
  );
  await pool!.query(
    `INSERT INTO job_card_meeting_details
       (job_card_id, organization_id, meeting_at, outcome, meeting_summary, next_follow_up_at)
     VALUES ($1, $2, NOW(), 'FOLLOW_UP_REQUIRED', 'Synthetic meeting summary', NOW() + INTERVAL '1 day')`,
    [parentJobId, fixture.organizationId],
  );
  const calendarEventId = (await first<{ id: string }>(
    `INSERT INTO calendar_events
       (organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
        created_by, updated_by, data_class, demo_dataset_id)
     VALUES ($1, $2, 'Synthetic calendar event', NOW() + INTERVAL '1 hour',
        NOW() + INTERVAL '2 hours', 'Europe/Istanbul', $3, $3, 'DEMO', $4)
     RETURNING id`,
    [fixture.organizationId, fixture.staffId, fixture.demoManagerId, fixture.datasetId],
  )).id;
  const calendarActivityId = (await first<{ id: string }>(
    `INSERT INTO calendar_event_activity_logs
       (organization_id, calendar_event_id, actor_user_id, action, changed_fields, client_action_id)
     VALUES ($1, $2, $3, 'CREATED', ARRAY['title'], $4) RETURNING id`,
    [fixture.organizationId, calendarEventId, fixture.demoManagerId, randomUUID()],
  )).id;
  const reminderId = (await first<{ id: string }>(
    `INSERT INTO calendar_reminders
       (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
     VALUES ($1, $2, $3, NOW(), NOW(), $4) RETURNING id`,
    [fixture.organizationId, childJobId, fixture.staffId, `r2a-reminder-${randomUUID()}`],
  )).id;
  const conversationId = (await first<{ id: string }>(
    `INSERT INTO conversations
       (organization_id, direct_key, context_type, job_id, data_class, demo_dataset_id, title)
     VALUES ($1, $2, 'JOB', $3, 'DEMO', $4, 'Synthetic job conversation') RETURNING id`,
    [fixture.organizationId, `r2a-conversation-${randomUUID()}`, childJobId, fixture.datasetId],
  )).id;
  const messageId = (await first<{ id: string }>(
    `INSERT INTO messages
       (conversation_id, organization_id, sender_user_id, client_action_id, body)
     VALUES ($1, $2, $3, $4, 'Synthetic message') RETURNING id`,
    [conversationId, fixture.organizationId, fixture.staffId, randomUUID()],
  )).id;
  const participantPairs = [fixture.staffId, fixture.demoManagerId].map((userId) => ({ conversationId, userId }));
  for (const pair of participantPairs) {
    await pool!.query(
      `INSERT INTO conversation_participants
         (conversation_id, user_id, organization_id, last_read_message_id)
       VALUES ($1, $2, $3, $4)`,
      [pair.conversationId, pair.userId, fixture.organizationId, messageId],
    );
  }
  for (const userId of [fixture.staffId, fixture.demoManagerId]) {
    await pool!.query(
      `INSERT INTO conversation_user_states (organization_id, conversation_id, user_id)
       VALUES ($1, $2, $3)`,
      [fixture.organizationId, conversationId, userId],
    );
  }
  const messagingActivityId = (await first<{ id: string }>(
    `INSERT INTO messaging_activity_logs
       (organization_id, conversation_id, actor_user_id, action, client_action_id)
     VALUES ($1, $2, $3, 'MESSAGE_SENT', $4) RETURNING id`,
    [fixture.organizationId, conversationId, fixture.demoManagerId, randomUUID()],
  )).id;
  const staffNoteId = (await first<{ id: string }>(
    `INSERT INTO staff_confidential_notes
       (organization_id, staff_user_id, author_user_id, body)
     VALUES ($1, $2, $3, 'Synthetic confidential note') RETURNING id`,
    [fixture.organizationId, fixture.staffId, fixture.demoManagerId],
  )).id;
  const realtimeIds = [
    await insertRealtime(fixture, 'source_activity_id', parentActivityId, 'job.created', 'job-card', parentJobId),
    await insertRealtime(fixture, 'calendar_activity_id', calendarActivityId, 'calendar.created', 'calendar-event', calendarEventId),
    await insertRealtime(fixture, 'calendar_reminder_id', reminderId, 'calendar.reminder_due', 'job-card', childJobId),
    await insertRealtime(fixture, 'messaging_activity_id', messagingActivityId, 'message.sent', 'conversation', conversationId),
    await insertRealtime(fixture, 'staff_note_id', staffNoteId, 'confidential-note.created', 'confidential-note', staffNoteId),
  ];
  const notificationIds = [
    await insertNotification(fixture, realtimeIds[0]!, 'job.assigned', 'job-card', parentJobId),
    await insertNotification(fixture, realtimeIds[1]!, 'calendar.assigned', 'calendar-event', calendarEventId),
    await insertNotification(fixture, realtimeIds[3]!, 'message.received', 'conversation', conversationId),
  ];
  const sessionId = (await first<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 day') RETURNING id`,
    [fixture.staffId, 'a'.repeat(64)],
  )).id;
  const subscriptionId = (await first<{ id: string }>(
    `INSERT INTO web_push_subscriptions
       (organization_id, recipient_user_id, session_id, endpoint, endpoint_hash,
        p256dh, auth, vapid_public_key_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'p256dh', 'auth', $6) RETURNING id`,
    [fixture.organizationId, fixture.staffId, sessionId, `https://push.invalid/${randomUUID()}`,
      'b'.repeat(64), 'c'.repeat(64)],
  )).id;
  const deliveryId = (await first<{ id: string }>(
    `INSERT INTO web_push_deliveries (organization_id, notification_id, subscription_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [fixture.organizationId, notificationIds[0], subscriptionId],
  )).id;
  const processedActionId = (await first<{ id: string }>(
    `INSERT INTO processed_actions (organization_id, user_id, client_action_id, operation_key)
     VALUES ($1, $2, $3, 'r2a-acceptance') RETURNING id`,
    [fixture.organizationId, fixture.staffId, randomUUID()],
  )).id;
  const auditEventId = (await first<{ id: string }>(
    `INSERT INTO audit_events
       (organization_id, actor_user_id, subject_type, subject_id, event_type)
     VALUES ($1, $2, 'USER', $2, 'USER_CREATED') RETURNING id`,
    [fixture.organizationId, fixture.staffId],
  )).id;

  return {
    customerId,
    contactId,
    productId,
    parentJobId,
    childJobId,
    parentActivityId,
    childActivityId,
    locationId,
    meetingJobId: parentJobId,
    calendarEventId,
    calendarActivityId,
    reminderId,
    conversationId,
    messageId,
    participantPairs,
    userStatePairs: [fixture.staffId, fixture.demoManagerId].map((userId) => ({ conversationId, userId })),
    messagingActivityId,
    staffNoteId,
    realtimeIds,
    notificationIds,
    subscriptionId,
    deliveryId,
    sessionId,
    processedActionId,
    auditEventId,
  } satisfies Graph;
}

async function insertBusinessSentinels(fixture: Fixture) {
  const customerId = (await first<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, assigned_staff_user_id, status)
     VALUES ($1, 'BUSINESS SENTINEL CUSTOMER', 'clinic', $2, 'active') RETURNING id`,
    [fixture.organizationId, fixture.businessStaffId],
  )).id;
  const contactId = (await first<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, title, is_primary)
     VALUES ($1, $2, 'BUSINESS SENTINEL CONTACT', 'Owner', TRUE) RETURNING id`,
    [fixture.organizationId, customerId],
  )).id;
  const productId = (await first<{ id: string }>(
    `INSERT INTO products (organization_id, sku, name, unit)
     VALUES ($1, $2, 'BUSINESS SENTINEL PRODUCT', 'adet') RETURNING id`,
    [fixture.organizationId, `BUSINESS-${randomUUID()}`],
  )).id;
  const jobId = await insertJob(fixture, {
    type: 'GENERAL_TASK',
    title: 'BUSINESS SENTINEL JOB',
    assignedTo: fixture.businessStaffId,
    createdBy: fixture.adminId,
    customerId,
    contactId,
    dataClass: 'BUSINESS',
    datasetId: null,
  });
  return { customerId, contactId, productId, jobId };
}

async function addDataset(fixture: Fixture, createdBy: string = fixture.adminId) {
  return (await first<{ id: string }>(
    `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
     VALUES ($1, $2, 'r2a-secondary', $3) RETURNING id`,
    [fixture.organizationId, `secondary-${randomUUID()}`, createdBy],
  )).id;
}

async function insertCustomer(
  fixture: Fixture,
  dataClass: DataClass,
  datasetId: string | null,
  assignedStaffUserId: string | null,
) {
  return (await first<{ id: string }>(
    `INSERT INTO customers
       (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
     VALUES ($1, $2, 'clinic', $3, 'active', $4, $5) RETURNING id`,
    [fixture.organizationId, `${dataClass} customer ${randomUUID()}`, assignedStaffUserId, dataClass, datasetId],
  )).id;
}

async function datasetSnapshot(fixture: Fixture) {
  const result = await pool!.query(
    `SELECT d.status, d.created_by, d.created_by_user_id_snapshot,
        (SELECT COUNT(*)::int FROM users WHERE organization_id = d.organization_id AND data_class = 'DEMO' AND demo_dataset_id = d.id) AS demo_users,
        (SELECT COUNT(*)::int FROM customers WHERE organization_id = d.organization_id AND data_class = 'DEMO' AND demo_dataset_id = d.id) AS demo_customers,
        (SELECT COUNT(*)::int FROM job_cards WHERE organization_id = d.organization_id AND data_class = 'DEMO' AND demo_dataset_id = d.id) AS demo_jobs,
        (SELECT COUNT(*)::int FROM conversations WHERE organization_id = d.organization_id AND data_class = 'DEMO' AND demo_dataset_id = d.id) AS demo_conversations,
        (SELECT COUNT(*)::int FROM calendar_events WHERE organization_id = d.organization_id AND data_class = 'DEMO' AND demo_dataset_id = d.id) AS demo_events,
        (SELECT COUNT(*)::int FROM demo_dataset_purge_operations WHERE organization_id = d.organization_id AND dataset_id = d.id) AS operations
     FROM demo_datasets d WHERE d.organization_id = $1 AND d.id = $2`,
    [fixture.organizationId, fixture.datasetId],
  );
  return result.rows[0];
}

async function expectBlocked(
  fixture: Fixture,
  expectedCodes: readonly string[],
  actor: SafeUser = fixture.admin,
) {
  const preview = await fixture.service.preview(actor, fixture.datasetId);
  expect(preview.safeToPurge).toBe(false);
  expect(preview.blockers.map((blocker) => blocker.code)).toEqual(
    expect.arrayContaining(expectedCodes),
  );
  const before = await datasetSnapshot(fixture);
  await expect(fixture.service.purge(actor, fixture.datasetId, {
    clientActionId: randomUUID(),
    planHash: preview.planHash,
  })).rejects.toMatchObject({
    code: 'DEMO_DATASET_PURGE_BLOCKED',
    details: { blockerCodes: expect.arrayContaining(expectedCodes) },
  });
  expect(await datasetSnapshot(fixture)).toEqual(before);
  return preview;
}

describe.skipIf(!databaseUrl)('R2A destructive PostgreSQL acceptance', () => {
  afterAll(async () => { await pool?.end(); });

  afterEach(async () => {
    while (organizationIds.length > 0) {
      const organizationId = organizationIds.pop()!;
      await cleanupOrganization(organizationId);
    }
  });

  it('purges a full DEMO graph child-first and preserves exact BUSINESS sentinels', async () => {
    const fixture = await createFixture();
    const graph = await createFullGraph(fixture);
    const sentinels = await insertBusinessSentinels(fixture);
    const beforeSentinels = await pool!.query(
      `SELECT id::text, name, data_class FROM customers WHERE id = $1
       UNION ALL SELECT id::text, name, data_class FROM products WHERE id = $2
       UNION ALL SELECT id::text, title, data_class FROM job_cards WHERE id = $3`,
      [sentinels.customerId, sentinels.productId, sentinels.jobId],
    );

    const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
    expect(preview.safeToPurge).toBe(true);
    expect(preview.affectedCounts).toMatchObject({
      users: 2,
      staffProfiles: 2,
      customers: 1,
      contacts: 1,
      products: 1,
      jobCards: 2,
      deliveryItems: 1,
      notes: 1,
      calendarEvents: 1,
      conversations: 1,
      messages: 1,
      notifications: 3,
      reminders: 1,
      realtimeEvents: 5,
    });
    expect(preview.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.blockers).toEqual([]);

    const request = { clientActionId: randomUUID(), planHash: preview.planHash };
    const response = await fixture.service.purge(fixture.admin, fixture.datasetId, request);
    expect(response.status).toBe('COMPLETED');
    expect(response).toMatchObject({
      datasetId: fixture.datasetId,
      retained: { auditActorDetaches: 1 },
    });

    const remaining = await pool!.query<{ table_name: string; count: string }>(
      `WITH target_org AS (SELECT $1::uuid AS id)
       SELECT 'users' AS table_name, COUNT(*)::text AS count FROM users WHERE id = ANY($2::uuid[])
       UNION ALL SELECT 'staff_profiles', COUNT(*)::text FROM staff_profiles WHERE user_id = ANY($2::uuid[])
       UNION ALL SELECT 'customers', COUNT(*)::text FROM customers WHERE id = ANY($3::uuid[])
       UNION ALL SELECT 'contacts', COUNT(*)::text FROM contacts WHERE id = ANY($4::uuid[])
       UNION ALL SELECT 'products', COUNT(*)::text FROM products WHERE id = ANY($5::uuid[])
       UNION ALL SELECT 'job_cards', COUNT(*)::text FROM job_cards WHERE id = ANY($6::uuid[])
       UNION ALL SELECT 'job_card_delivery_items', COUNT(*)::text FROM job_card_delivery_items WHERE job_card_id = ANY($6::uuid[])
       UNION ALL SELECT 'job_card_notes', COUNT(*)::text FROM job_card_notes WHERE job_card_id = ANY($6::uuid[])
       UNION ALL SELECT 'job_card_meeting_details', COUNT(*)::text FROM job_card_meeting_details WHERE job_card_id = ANY($6::uuid[])
       UNION ALL SELECT 'job_card_activity_logs', COUNT(*)::text FROM job_card_activity_logs WHERE job_card_id = ANY($6::uuid[])
       UNION ALL SELECT 'job_action_locations', COUNT(*)::text FROM job_action_locations WHERE job_card_id = ANY($6::uuid[])
       UNION ALL SELECT 'calendar_events', COUNT(*)::text FROM calendar_events WHERE id = ANY($7::uuid[])
       UNION ALL SELECT 'calendar_event_activity_logs', COUNT(*)::text FROM calendar_event_activity_logs WHERE calendar_event_id = ANY($7::uuid[])
       UNION ALL SELECT 'calendar_reminders', COUNT(*)::text FROM calendar_reminders WHERE id = ANY($8::uuid[])
       UNION ALL SELECT 'conversations', COUNT(*)::text FROM conversations WHERE id = ANY($9::uuid[])
       UNION ALL SELECT 'messages', COUNT(*)::text FROM messages WHERE id = ANY($10::uuid[])
       UNION ALL SELECT 'messaging_activity_logs', COUNT(*)::text FROM messaging_activity_logs WHERE id = ANY($11::uuid[])
       UNION ALL SELECT 'staff_confidential_notes', COUNT(*)::text FROM staff_confidential_notes WHERE id = ANY($12::uuid[])
       UNION ALL SELECT 'realtime_events', COUNT(*)::text FROM realtime_events WHERE id = ANY($13::bigint[])
       UNION ALL SELECT 'in_app_notifications', COUNT(*)::text FROM in_app_notifications WHERE id = ANY($14::uuid[])
       UNION ALL SELECT 'web_push_subscriptions', COUNT(*)::text FROM web_push_subscriptions WHERE id = $15
       UNION ALL SELECT 'web_push_deliveries', COUNT(*)::text FROM web_push_deliveries WHERE id = $16
       UNION ALL SELECT 'sessions', COUNT(*)::text FROM sessions WHERE id = $17
       UNION ALL SELECT 'processed_actions', COUNT(*)::text FROM processed_actions WHERE id = $18`,
      [fixture.organizationId, [fixture.demoManagerId, fixture.staffId], [graph.customerId], [graph.contactId],
        [graph.productId], [graph.parentJobId, graph.childJobId], [graph.calendarEventId], [graph.reminderId],
        [graph.conversationId], [graph.messageId], [graph.messagingActivityId], [graph.staffNoteId], graph.realtimeIds,
        graph.notificationIds, graph.subscriptionId, graph.deliveryId, graph.sessionId, graph.processedActionId],
    );
    expect(remaining.rows.every((row) => row.count === '0')).toBe(true);

    const persisted = await pool!.query(
      `SELECT
          (SELECT status FROM demo_datasets WHERE id = $1) AS status,
          (SELECT created_by FROM demo_datasets WHERE id = $1) AS created_by,
          (SELECT created_by_user_id_snapshot FROM demo_datasets WHERE id = $1) AS created_by_user_id_snapshot,
          (SELECT COUNT(*) FROM demo_dataset_purge_operations WHERE dataset_id = $1) AS operation_count,
          (SELECT actor_user_id FROM audit_events WHERE id = $2) AS audit_actor,
          (SELECT actor_user_id_snapshot FROM audit_events WHERE id = $2) AS audit_snapshot,
          (SELECT COUNT(*) FROM audit_events WHERE subject_id = $1 AND event_type = 'DEMO_DATASET_PURGED') AS purge_audit_count`,
      [fixture.datasetId, graph.auditEventId],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: null,
      created_by: null,
      created_by_user_id_snapshot: null,
      operation_count: '1',
      audit_actor: null,
      audit_snapshot: fixture.staffId,
      purge_audit_count: '1',
    });
    const afterSentinels = await pool!.query(
      `SELECT id::text, name, data_class FROM customers WHERE id = $1
       UNION ALL SELECT id::text, name, data_class FROM products WHERE id = $2
       UNION ALL SELECT id::text, title, data_class FROM job_cards WHERE id = $3`,
      [sentinels.customerId, sentinels.productId, sentinels.jobId],
    );
    expect(afterSentinels.rows).toEqual(beforeSentinels.rows);

    await expect(pool!.query(
      'INSERT INTO calendar_reminders (organization_id, job_card_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key) VALUES ($1, $2, $3, NOW(), NOW(), $4)',
      [fixture.organizationId, graph.childJobId, fixture.staffId, `post-purge-${randomUUID()}`],
    )).rejects.toMatchObject({ code: '23503' });

    await expect(fixture.service.purge(fixture.admin, fixture.datasetId, request)).resolves.toEqual(response);
    await expect(fixture.service.purge(fixture.admin, fixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: preview.planHash,
    })).rejects.toMatchObject({ code: 'DEMO_DATASET_NOT_FOUND' });
  });

  it('verifies the D4 registry/receipt constraints and plan-hash stability on real PostgreSQL', async () => {
    const migration = await pool!.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    expect(migration.rows[0]?.version).toBe('040_demo_lifecycle_simplification');
    const constraints = await pool!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname = ANY($1::text[])
       ORDER BY conname`,
      [[
        'demo_datasets_active_creator_attribution_check',
        'demo_datasets_active_status_check',
        'audit_events_actor_attribution_check',
        'demo_dataset_purge_operations_client_action_unique',
      ]],
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      'audit_events_actor_attribution_check',
      'demo_dataset_purge_operations_client_action_unique',
      'demo_datasets_active_creator_attribution_check',
      'demo_datasets_active_status_check',
    ]);

    const fixture = await createFixture();
    const firstPreview = await fixture.service.preview(fixture.admin, fixture.datasetId);
    const secondPreview = await fixture.service.preview(fixture.admin, fixture.datasetId);
    expect(secondPreview.planHash).toBe(firstPreview.planHash);

    const originalCustomerId = await insertCustomer(fixture, 'DEMO', fixture.datasetId, null);
    const replacementCustomerId = await insertCustomer(fixture, 'BUSINESS', null, null);
    const beforeSwap = await fixture.service.preview(fixture.admin, fixture.datasetId);
    await pool!.query(
      "UPDATE customers SET data_class = 'BUSINESS', demo_dataset_id = NULL WHERE id = $1",
      [originalCustomerId],
    );
    await pool!.query(
      "UPDATE customers SET data_class = 'DEMO', demo_dataset_id = $2 WHERE id = $1",
      [replacementCustomerId, fixture.datasetId],
    );
    const afterSwap = await fixture.service.preview(fixture.admin, fixture.datasetId);
    expect(afterSwap.affectedCounts.customers).toBe(beforeSwap.affectedCounts.customers);
    expect(afterSwap.planHash).not.toBe(beforeSwap.planHash);
  });

  it('blocks BUSINESS, cross-dataset, follow-up-cycle and mixed messaging edges without mutation', async () => {
    const businessCustomerFixture = await createFixture();
    await insertCustomer(businessCustomerFixture, 'BUSINESS', null, businessCustomerFixture.staffId);
    await expectBlocked(businessCustomerFixture, ['DEMO_USER_TO_BUSINESS_CUSTOMER']);

    const reverseFixture = await createFixture();
    await insertCustomer(reverseFixture, 'DEMO', reverseFixture.datasetId, reverseFixture.businessStaffId);
    await expectBlocked(reverseFixture, ['BUSINESS_USER_TO_DEMO_CUSTOMER']);

    const crossDatasetFixture = await createFixture();
    const otherDatasetId = await addDataset(crossDatasetFixture);
    const parentJobId = await insertJob(crossDatasetFixture, {
      title: 'Dataset B parent',
      assignedTo: crossDatasetFixture.businessStaffId,
      createdBy: crossDatasetFixture.businessStaffId,
      dataClass: 'DEMO',
      datasetId: otherDatasetId,
    });
    await insertJob(crossDatasetFixture, {
      title: 'Dataset A child',
      assignedTo: crossDatasetFixture.staffId,
      createdBy: crossDatasetFixture.demoManagerId,
      sourceJobCardId: parentJobId,
      followUpInstructions: 'Cross-dataset follow-up',
    });
    await expectBlocked(crossDatasetFixture, ['CROSS_DATASET_EDGE']);

    const cycleFixture = await createFixture();
    const firstJobId = await insertJob(cycleFixture, {
      title: 'Cycle A',
      assignedTo: cycleFixture.staffId,
      createdBy: cycleFixture.demoManagerId,
    });
    const secondJobId = await insertJob(cycleFixture, {
      title: 'Cycle B',
      assignedTo: cycleFixture.staffId,
      createdBy: cycleFixture.demoManagerId,
    });
    await pool!.query(
      `UPDATE job_cards SET source_job_card_id = $2, follow_up_instructions = 'Cycle edge'
       WHERE id = $1`,
      [firstJobId, secondJobId],
    );
    await pool!.query(
      `UPDATE job_cards SET source_job_card_id = $2, follow_up_instructions = 'Cycle edge'
       WHERE id = $1`,
      [secondJobId, firstJobId],
    );
    await expectBlocked(cycleFixture, ['FOLLOW_UP_CYCLE']);

    const messagingFixture = await createFixture();
    const conversationId = (await first<{ id: string }>(
      `INSERT INTO conversations
         (organization_id, direct_key, context_type, data_class, demo_dataset_id, title)
       VALUES ($1, $2, 'GENERAL', 'DEMO', $3, 'Mixed messaging thread') RETURNING id`,
      [messagingFixture.organizationId, `mixed-${randomUUID()}`, messagingFixture.datasetId],
    )).id;
    await pool!.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, organization_id)
       VALUES ($1, $2, $3), ($1, $4, $3)`,
      [conversationId, messagingFixture.staffId, messagingFixture.organizationId, messagingFixture.adminId],
    );
    await expectBlocked(messagingFixture, ['BUSINESS_CONVERSATION_TO_DEMO_USER']);
  });

  it('blocks cross-organization realtime, worker claims and backup dependencies fail-closed', async () => {
    const realtimeFixture = await createFixture();
    const jobId = await insertJob(realtimeFixture, {
      title: 'Cross-org realtime job',
      assignedTo: realtimeFixture.staffId,
      createdBy: realtimeFixture.demoManagerId,
    });
    const activityId = await insertJobActivity(realtimeFixture, jobId, realtimeFixture.staffId, 'JOB_CREATED');
    const foreignOrganizationId = (await first<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [`Foreign realtime ${randomUUID()}`],
    )).id;
    organizationIds.push(foreignOrganizationId);
    await pool!.query(
      `INSERT INTO realtime_events
         (organization_id, source_activity_id, event_type, entity_type, entity_id,
          audience_user_ids, resource_keys)
       VALUES ($1, $2, 'job.created', 'job-card', $3, $4::uuid[], ARRAY['foreign'])`,
      [foreignOrganizationId, activityId, jobId, [realtimeFixture.staffId]],
    );
    await expectBlocked(realtimeFixture, ['CROSS_ORGANIZATION_DERIVED_EDGE']);

    const reminderFixture = await createFixture();
    const reminderJobId = await insertJob(reminderFixture, {
      title: 'Claimed reminder job',
      assignedTo: reminderFixture.staffId,
      createdBy: reminderFixture.demoManagerId,
    });
    await pool!.query(
      `INSERT INTO calendar_reminders
         (organization_id, job_card_id, recipient_user_id, remind_at, state,
          dedupe_key, next_attempt_at, lease_token, lease_until)
       VALUES ($1, $2, $3, NOW(), 'CLAIMED', $4, NOW(), $5, NOW() + INTERVAL '10 minutes')`,
      [reminderFixture.organizationId, reminderJobId, reminderFixture.staffId,
        `claimed-reminder-${randomUUID()}`, randomUUID()],
    );
    await expectBlocked(reminderFixture, ['WORKER_CLAIMED_REMINDER']);

    const expiredClaimFixture = await createFixture();
    const expiredJobId = await insertJob(expiredClaimFixture, {
      title: 'Expired claimed reminder job',
      assignedTo: expiredClaimFixture.staffId,
      createdBy: expiredClaimFixture.demoManagerId,
    });
    await pool!.query(
      `INSERT INTO calendar_reminders
         (organization_id, job_card_id, recipient_user_id, remind_at, state,
          dedupe_key, next_attempt_at, lease_token, lease_until)
       VALUES ($1, $2, $3, NOW(), 'CLAIMED', $4, NOW(), $5, NOW() - INTERVAL '1 minute')`,
      [expiredClaimFixture.organizationId, expiredJobId, expiredClaimFixture.staffId,
        `expired-claimed-reminder-${randomUUID()}`, randomUUID()],
    );
    await expectBlocked(expiredClaimFixture, ['WORKER_CLAIMED_REMINDER']);

    const abandonedFixture = await createFixture();
    const abandonedJobId = await insertJob(abandonedFixture, {
      title: 'Abandoned reminder job',
      assignedTo: abandonedFixture.staffId,
      createdBy: abandonedFixture.demoManagerId,
    });
    await pool!.query(
      `INSERT INTO calendar_reminders
         (organization_id, job_card_id, recipient_user_id, remind_at, state,
          dedupe_key, next_attempt_at, abandoned_at)
       VALUES ($1, $2, $3, NOW(), 'ABANDONED', $4, NOW(), NOW())`,
      [abandonedFixture.organizationId, abandonedJobId, abandonedFixture.staffId,
        `abandoned-reminder-${randomUUID()}`],
    );
    const abandonedPreview = await abandonedFixture.service.preview(
      abandonedFixture.admin,
      abandonedFixture.datasetId,
    );
    expect(abandonedPreview.safeToPurge).toBe(true);
    await expect(abandonedFixture.service.purge(abandonedFixture.admin, abandonedFixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: abandonedPreview.planHash,
    })).resolves.toMatchObject({ status: 'COMPLETED' });

    const pushFixture = await createFixture();
    const pushGraph = await createFullGraph(pushFixture);
    await pool!.query(
      `UPDATE web_push_deliveries
       SET state = 'CLAIMED', lease_token = $2, lease_until = NOW() + INTERVAL '10 minutes'
       WHERE id = $1`,
      [pushGraph.deliveryId, randomUUID()],
    );
    await expectBlocked(pushFixture, ['WORKER_CLAIMED_WEB_PUSH']);

    const backupFixture = await createFixture();
    await pool!.query(
      `INSERT INTO backup_runs (status, origin, scope, retention_class, created_by)
       VALUES ('QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', $1)`,
      [backupFixture.staffId],
    );
    await expectBlocked(backupFixture, ['BACKUP_DEPENDENCY']);
  });

  it('rejects stale plans with zero mutation for identity replacement and new dependencies', async () => {
    const identityFixture = await createFixture();
    const originalCustomerId = await insertCustomer(identityFixture, 'DEMO', identityFixture.datasetId, null);
    const replacementCustomerId = await insertCustomer(identityFixture, 'BUSINESS', null, null);
    const firstPreview = await identityFixture.service.preview(identityFixture.admin, identityFixture.datasetId);
    const before = await datasetSnapshot(identityFixture);
    await pool!.query(
      "UPDATE customers SET data_class = 'BUSINESS', demo_dataset_id = NULL WHERE id = $1",
      [originalCustomerId],
    );
    await pool!.query(
      "UPDATE customers SET data_class = 'DEMO', demo_dataset_id = $2 WHERE id = $1",
      [replacementCustomerId, identityFixture.datasetId],
    );
    await expect(identityFixture.service.purge(identityFixture.admin, identityFixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: firstPreview.planHash,
    })).rejects.toMatchObject({ code: 'DEMO_DATASET_PLAN_STALE' });
    const after = await datasetSnapshot(identityFixture);
    expect(after).toMatchObject({ status: 'ACTIVE', operations: 0 });
    expect(after?.demo_customers).toBe(before?.demo_customers);
    const linkState = await pool!.query(
      'SELECT id, data_class, demo_dataset_id FROM customers WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[originalCustomerId, replacementCustomerId]],
    );
    expect(linkState.rows).toEqual(expect.arrayContaining([
      { id: originalCustomerId, data_class: 'BUSINESS', demo_dataset_id: null },
      { id: replacementCustomerId, data_class: 'DEMO', demo_dataset_id: identityFixture.datasetId },
    ]));

    const dependencyFixture = await createFixture();
    const dependencyPreview = await dependencyFixture.service.preview(
      dependencyFixture.admin,
      dependencyFixture.datasetId,
    );
    await insertCustomer(dependencyFixture, 'BUSINESS', null, dependencyFixture.staffId);
    const dependencyBefore = await datasetSnapshot(dependencyFixture);
    await expect(dependencyFixture.service.purge(dependencyFixture.admin, dependencyFixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: dependencyPreview.planHash,
    })).rejects.toMatchObject({
      code: 'DEMO_DATASET_PURGE_BLOCKED',
      details: { blockerCodes: expect.arrayContaining(['DEMO_USER_TO_BUSINESS_CUSTOMER']) },
    });
    expect(await datasetSnapshot(dependencyFixture)).toEqual(dependencyBefore);
  });

  it('rolls back a controlled mid-delete PostgreSQL failure atomically', async () => {
    const fixture = await createFixture();
    const graph = await createFullGraph(fixture);
    const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
    expect(preview.safeToPurge).toBe(true);
    const before = await datasetSnapshot(fixture);
    const auditBefore = await pool!.query(
      'SELECT actor_user_id, actor_user_id_snapshot FROM audit_events WHERE id = $1',
      [graph.auditEventId],
    );
    const creatorBefore = await pool!.query(
      'SELECT created_by, created_by_user_id_snapshot, status FROM demo_datasets WHERE id = $1',
      [fixture.datasetId],
    );

    await pool!.query(`
      CREATE OR REPLACE FUNCTION r2a_acceptance_rollback_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'r2a controlled rollback failure';
      END;
      $$`);
    await pool!.query(`
      CREATE TRIGGER r2a_acceptance_rollback_trigger
      BEFORE DELETE ON job_card_delivery_items
      FOR EACH ROW EXECUTE FUNCTION r2a_acceptance_rollback_failure()`);
    try {
      await expect(fixture.service.purge(fixture.admin, fixture.datasetId, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      })).rejects.toThrow('r2a controlled rollback failure');
    } finally {
      await pool!.query('DROP TRIGGER IF EXISTS r2a_acceptance_rollback_trigger ON job_card_delivery_items');
      await pool!.query('DROP FUNCTION IF EXISTS r2a_acceptance_rollback_failure()');
    }

    expect(await datasetSnapshot(fixture)).toEqual(before);
    expect((await pool!.query(
      'SELECT actor_user_id, actor_user_id_snapshot FROM audit_events WHERE id = $1',
      [graph.auditEventId],
    )).rows).toEqual(auditBefore.rows);
    expect((await pool!.query(
      'SELECT created_by, created_by_user_id_snapshot, status FROM demo_datasets WHERE id = $1',
      [fixture.datasetId],
    )).rows).toEqual(creatorBefore.rows);
    expect((await pool!.query(
      'SELECT COUNT(*)::int AS count FROM demo_dataset_purge_operations WHERE dataset_id = $1',
      [fixture.datasetId],
    )).rows[0]?.count).toBe(0);
  });

  it('serializes concurrent purge requests and enforces semantic key reuse', async () => {
    const fixture = await createFixture();
    const sentinel = await insertBusinessSentinels(fixture);
    const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
    const request = { clientActionId: randomUUID(), planHash: preview.planHash };
    const results = await Promise.allSettled([
      fixture.service.purge(fixture.admin, fixture.datasetId, request),
      fixture.service.purge(fixture.admin, fixture.datasetId, request),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).toBeOneOf([
          'DEMO_DATASET_PURGE_IN_PROGRESS',
          'DEMO_DATASET_PLAN_STALE',
          'DEMO_DATASET_NOT_FOUND',
        ]);
      }
    }
    const operationCount = await pool!.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM demo_dataset_purge_operations WHERE organization_id = $1 AND dataset_id = $2',
      [fixture.organizationId, fixture.datasetId],
    );
    expect(operationCount.rows[0]?.count).toBe(1);
    const sentinelAfter = await pool!.query(
      'SELECT id::text, name, data_class FROM customers WHERE id = $1',
      [sentinel.customerId],
    );
    expect(sentinelAfter.rows[0]).toMatchObject({ id: sentinel.customerId, name: 'BUSINESS SENTINEL CUSTOMER', data_class: 'BUSINESS' });

    await expect(fixture.service.purge(fixture.admin, fixture.datasetId, {
      clientActionId: request.clientActionId,
      planHash: `${preview.planHash[0] === 'f' ? 'e' : 'f'}${preview.planHash.slice(1)}`,
    })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED' });
    const secondDatasetId = await addDataset(fixture);
    await expect(fixture.service.purge(fixture.admin, secondDatasetId, request)).rejects.toMatchObject({
      code: 'CLIENT_ACTION_REUSED',
    });
    await expect(fixture.service.purge(fixture.admin, fixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: preview.planHash,
    })).rejects.toMatchObject({ code: 'DEMO_DATASET_NOT_FOUND' });
  });

  it('returns in-progress for a durable PROCESSING receipt without mutating the graph', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview(fixture.admin, fixture.datasetId);
    const clientActionId = randomUUID();
    await pool!.query(
      `INSERT INTO demo_dataset_purge_operations
         (organization_id, dataset_id, client_action_id, plan_hash,
          requested_by_user_id_snapshot, dataset_key, seed_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [fixture.organizationId, fixture.datasetId, clientActionId, preview.planHash,
        fixture.adminId, preview.dataset.datasetKey, preview.dataset.seedVersion],
    );
    const before = await datasetSnapshot(fixture);
    await expect(fixture.service.purge(fixture.admin, fixture.datasetId, {
      clientActionId,
      planHash: preview.planHash,
    })).rejects.toMatchObject({ code: 'DEMO_DATASET_PURGE_IN_PROGRESS' });
    expect(await datasetSnapshot(fixture)).toEqual(before);
  });

  it('enforces ADMIN-only scope, opaque cross-org access, and self-purge blocking', async () => {
    const fixture = await createFixture();
    const before = await datasetSnapshot(fixture);
    await expect(fixture.service.preview(fixture.manager, fixture.datasetId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fixture.service.preview(fixture.staff, fixture.datasetId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fixture.service.purge(fixture.manager, fixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: 'a'.repeat(64),
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await datasetSnapshot(fixture)).toEqual(before);

    const foreignFixture = await createFixture();
    await expect(fixture.service.preview(fixture.admin, foreignFixture.datasetId)).rejects.toMatchObject({
      code: 'DEMO_DATASET_NOT_FOUND',
    });

    const selfFixture = await createFixture();
    await pool!.query(
      "UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2 WHERE id = $1",
      [selfFixture.adminId, selfFixture.datasetId],
    );
    const selfPreview = await selfFixture.service.preview(selfFixture.admin, selfFixture.datasetId);
    expect(selfPreview.safeToPurge).toBe(true);
    const selfBefore = await datasetSnapshot(selfFixture);
    await expect(selfFixture.service.purge(selfFixture.admin, selfFixture.datasetId, {
      clientActionId: randomUUID(),
      planHash: selfPreview.planHash,
    })).rejects.toMatchObject({
      code: 'DEMO_DATASET_PURGE_BLOCKED',
      details: { blockerCodes: expect.arrayContaining(['PURGE_ACTOR_IN_DATASET']) },
    });
    expect(await datasetSnapshot(selfFixture)).toEqual(selfBefore);
  });
});
