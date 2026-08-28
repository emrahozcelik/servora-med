import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { hashPassword } from '../auth/crypto.js';
import { DemoDatasetImpactAnalyzer } from './analyzer.js';
import { demoDatasetPlanHash } from './plan.js';
import type {
  DemoDatasetBlocker,
  DemoDatasetCreateRequest,
  DemoDatasetCreateResponse,
  DemoDatasetPurgePlan,
  DemoDatasetPurgeRequest,
  DemoDatasetPurgeResponse,
  DemoDatasetPreviewData,
  DemoDatasetRecord,
  DemoDatasetRepository,
} from './types.js';
import { DEMO_DATASET_AUDIT_EVENT_TYPE, DEMO_DATASET_AUDIT_SUBJECT_TYPE } from './types.js';

import { AppError } from '../../errors/index.js';

const DEMO_SEED_VERSION = 'demo-standard-v1' as const;
const DATASET_KEY_PREFIX = 'standard-v1-' as const;

function demoDatasetKeyForAction(clientActionId: string): string {
  return `${DATASET_KEY_PREFIX}${clientActionId.toLowerCase()}`;
}

function createSyntheticPassword(): string {
  // 20 url-safe chars, always within 12..128 and passes validatePassword
  return randomBytes(15).toString('base64url');
}

type DemoDatasetRow = {
  id: string;
  organization_id: string;
  dataset_key: string;
  seed_version: string;
  status: 'ACTIVE' | 'PURGED';
  created_at: Date;
  created_by: string | null;
  created_by_user_id_snapshot: string | null;
  purged_at: Date | null;
  organization_name: string;
};

function mapDataset(row: DemoDatasetRow): DemoDatasetRecord {
  const createdBy = row.created_by ?? row.created_by_user_id_snapshot;
  if (!createdBy) throw new Error('demo dataset creator attribution is missing');
  return {
    id: row.id,
    organizationId: row.organization_id,
    datasetKey: row.dataset_key,
    seedVersion: row.seed_version,
    status: row.status,
    createdAt: row.created_at,
    createdBy,
    purgedAt: row.purged_at,
  };
}

const DATASET_COLUMNS = `d.id, d.organization_id, d.dataset_key, d.seed_version,
  d.status, d.created_at, d.created_by, d.created_by_user_id_snapshot,
  d.purged_at, o.name AS organization_name`;

const DATASET_FROM = `
  FROM demo_datasets d
  JOIN organizations o ON o.id = d.organization_id`;

function databaseCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function notFound() {
  return new AppError('DEMO_DATASET_NOT_FOUND', 404, 'Demo veri kümesi bulunamadı.');
}

function assertExactIds(table: string, planned: readonly string[], returned: readonly string[]) {
  const expected = [...new Set(planned)].sort();
  const actual = [...new Set(returned)].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
      'Demo veri kümesi beklenmeyen bir bağımlılık nedeniyle değiştirilemedi.',
      { table });
  }
}

async function lockUuidRows(
  client: PoolClient,
  table: string,
  organizationId: string,
  ids: readonly string[],
  idColumn = 'id',
) {
  if (ids.length === 0) return;
  await client.query(
    `SELECT ${idColumn} FROM ${table}
     WHERE organization_id = $1 AND ${idColumn} = ANY($2::uuid[])
     ORDER BY ${idColumn}
     FOR UPDATE`,
    [organizationId, ids],
  );
}

async function lockBigintRows(
  client: PoolClient,
  table: string,
  organizationId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return;
  await client.query(
    `SELECT id FROM ${table}
     WHERE organization_id = $1 AND id = ANY($2::bigint[])
     ORDER BY id
     FOR UPDATE`,
    [organizationId, ids],
  );
}

async function deleteUuidRows(
  client: PoolClient,
  table: string,
  organizationId: string,
  ids: readonly string[],
  idColumn = 'id',
) {
  if (ids.length === 0) return;
  const result = await client.query<{ id: string }>(
    `DELETE FROM ${table}
     WHERE organization_id = $1 AND ${idColumn} = ANY($2::uuid[])
     RETURNING ${idColumn}::text AS id`,
    [organizationId, ids],
  );
  assertExactIds(table, ids, result.rows.map((row) => row.id));
}

async function deleteRootRows(
  client: PoolClient,
  table: string,
  organizationId: string,
  datasetId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return;
  const result = await client.query<{ id: string }>(
    `DELETE FROM ${table}
     WHERE organization_id = $1
       AND id = ANY($2::uuid[])
       AND data_class = 'DEMO'
       AND demo_dataset_id = $3
     RETURNING id::text AS id`,
    [organizationId, ids, datasetId],
  );
  assertExactIds(table, ids, result.rows.map((row) => row.id));
}

async function deleteBigintRows(
  client: PoolClient,
  table: string,
  organizationId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return;
  const result = await client.query<{ id: string }>(
    `DELETE FROM ${table}
     WHERE organization_id = $1 AND id = ANY($2::bigint[])
     RETURNING id::text AS id`,
    [organizationId, ids],
  );
  assertExactIds(table, ids, result.rows.map((row) => row.id));
}

async function deleteSessions(client: PoolClient, plan: DemoDatasetPurgePlan) {
  if (plan.sessions.length === 0) return;
  const result = await client.query<{ id: string }>(
    `DELETE FROM sessions
     WHERE id = ANY($1::uuid[]) AND user_id = ANY($2::uuid[])
     RETURNING id::text AS id`,
    [plan.sessions, plan.users],
  );
  assertExactIds('sessions', plan.sessions, result.rows.map((row) => row.id));
}

async function deleteConversationPairs(
  client: PoolClient,
  table: 'conversation_participants' | 'conversation_user_states',
  organizationId: string,
  pairs: readonly Readonly<{ conversationId: string; userId: string }>[],
) {
  if (pairs.length === 0) return;
  const result = await client.query<{ conversation_id: string; user_id: string }>(
    `DELETE FROM ${table} AS target
     USING unnest($2::uuid[], $3::uuid[]) AS planned(conversation_id, user_id)
     WHERE target.organization_id = $1
       AND target.conversation_id = planned.conversation_id
       AND target.user_id = planned.user_id
     RETURNING target.conversation_id, target.user_id`,
    [organizationId, pairs.map((pair) => pair.conversationId), pairs.map((pair) => pair.userId)],
  );
  const expected = pairs.map((pair) => `${pair.conversationId}:${pair.userId}`).sort();
  const actual = result.rows.map((row) => `${row.conversation_id}:${row.user_id}`).sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
      'Demo konuşma durumu beklenmeyen bir bağımlılık nedeniyle değiştirilemedi.', { table });
  }
}

async function lockConversationPairs(
  client: PoolClient,
  table: 'conversation_participants' | 'conversation_user_states',
  organizationId: string,
  pairs: readonly Readonly<{ conversationId: string; userId: string }>[],
) {
  if (pairs.length === 0) return;
  await client.query(
    `SELECT target.conversation_id, target.user_id
     FROM ${table} AS target
     JOIN unnest($2::uuid[], $3::uuid[]) AS planned(conversation_id, user_id)
       ON target.conversation_id = planned.conversation_id
      AND target.user_id = planned.user_id
     WHERE target.organization_id = $1
     ORDER BY target.conversation_id, target.user_id
     FOR UPDATE`,
    [organizationId, pairs.map((pair) => pair.conversationId), pairs.map((pair) => pair.userId)],
  );
}

async function detachAuditActors(
  client: PoolClient,
  organizationId: string,
  links: readonly Readonly<{ auditEventId: string; actorUserId: string }>[],
) {
  if (links.length === 0) return 0;
  const result = await client.query<{ id: string }>(
    `UPDATE audit_events AS event
     SET actor_user_id = NULL,
         actor_user_id_snapshot = planned.actor_user_id
     FROM unnest($2::uuid[], $3::uuid[]) AS planned(audit_event_id, actor_user_id)
     WHERE event.organization_id = $1
       AND event.id = planned.audit_event_id
       AND event.actor_user_id = planned.actor_user_id
     RETURNING event.id`,
    [organizationId, links.map((link) => link.auditEventId), links.map((link) => link.actorUserId)],
  );
  assertExactIds('audit_events', links.map((link) => link.auditEventId), result.rows.map((row) => row.id));
  return result.rows.length;
}

async function claimOperation(
  client: PoolClient,
  organizationId: string,
  datasetId: string,
  actorUserId: string,
  request: DemoDatasetPurgeRequest,
  dataset: DemoDatasetRecord,
) {
  const insertResult = await client.query<{ id: string }>(
    `INSERT INTO demo_dataset_purge_operations
       (organization_id, dataset_id, client_action_id, plan_hash,
        requested_by_user_id_snapshot, dataset_key, seed_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id, client_action_id) DO NOTHING
     RETURNING id`,
    [organizationId, datasetId, request.clientActionId, request.planHash, actorUserId,
      dataset.datasetKey, dataset.seedVersion],
  );
  const result = await client.query<{
    id: string;
    dataset_id: string;
    plan_hash: string;
    status: 'PROCESSING' | 'COMPLETED';
    response_body: unknown;
  }>(
    `SELECT id, dataset_id, plan_hash, status, response_body
     FROM demo_dataset_purge_operations
     WHERE organization_id = $1 AND client_action_id = $2
     FOR UPDATE`,
    [organizationId, request.clientActionId],
  );
  const operation = result.rows[0];
  if (!operation) throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409, 'Purge işlemi kaydedilemedi.');
  if (operation.dataset_id !== datasetId || operation.plan_hash.trim() !== request.planHash) {
    throw new AppError('CLIENT_ACTION_REUSED', 409, 'İstemci işlem anahtarı farklı bir purge işlemi için kullanıldı.');
  }
  if (operation.status === 'COMPLETED') {
    return { operationId: operation.id, replay: operation.response_body as DemoDatasetPurgeResponse, created: false };
  }
  return { operationId: operation.id, replay: null, created: insertResult.rows.length === 1 };
}

async function lockPlan(client: PoolClient, organizationId: string, plan: DemoDatasetPurgePlan) {
  await lockUuidRows(client, 'users', organizationId, plan.users);
  await lockUuidRows(client, 'staff_profiles', organizationId, plan.staffProfiles);
  await lockUuidRows(client, 'customers', organizationId, plan.customers);
  await lockUuidRows(client, 'contacts', organizationId, plan.contacts);
  await lockUuidRows(client, 'products', organizationId, plan.products);
  await lockUuidRows(client, 'job_cards', organizationId, plan.jobCards);
  await lockUuidRows(client, 'job_card_delivery_items', organizationId, plan.deliveryItems);
  await lockUuidRows(client, 'job_card_notes', organizationId, plan.jobNotes);
  await lockUuidRows(client, 'job_card_meeting_details', organizationId, plan.meetingDetails, 'job_card_id');
  await lockUuidRows(client, 'job_card_activity_logs', organizationId, plan.jobActivities);
  await lockUuidRows(client, 'job_action_locations', organizationId, plan.jobActionLocations);
  await lockUuidRows(client, 'staff_confidential_notes', organizationId, plan.confidentialNotes);
  await lockUuidRows(client, 'calendar_events', organizationId, plan.calendarEvents);
  await lockUuidRows(client, 'calendar_event_activity_logs', organizationId, plan.calendarActivities);
  await lockUuidRows(client, 'calendar_reminders', organizationId, plan.reminders);
  await lockUuidRows(client, 'conversations', organizationId, plan.conversations);
  await lockConversationPairs(client, 'conversation_user_states', organizationId, plan.conversationUserStates);
  await lockConversationPairs(client, 'conversation_participants', organizationId, plan.conversationParticipants);
  await lockUuidRows(client, 'messages', organizationId, plan.messages);
  await lockUuidRows(client, 'messaging_activity_logs', organizationId, plan.messagingActivities);
  await lockBigintRows(client, 'realtime_events', organizationId, plan.realtimeEvents);
  await lockUuidRows(client, 'in_app_notifications', organizationId, plan.notifications);
  await lockUuidRows(client, 'web_push_subscriptions', organizationId, plan.webPushSubscriptions);
  await lockUuidRows(client, 'web_push_deliveries', organizationId, plan.webPushDeliveries);
  await lockUuidRows(client, 'processed_actions', organizationId, plan.processedActions);
  await lockUuidRows(client, 'audit_events', organizationId, plan.retainedAuditActorLinks.map((link) => link.auditEventId));
}

async function executePlan(client: PoolClient, organizationId: string, plan: DemoDatasetPurgePlan) {
  await deleteUuidRows(client, 'web_push_deliveries', organizationId, plan.webPushDeliveries);
  await deleteUuidRows(client, 'in_app_notifications', organizationId, plan.notifications);
  await deleteBigintRows(client, 'realtime_events', organizationId, plan.realtimeEvents);
  await deleteUuidRows(client, 'web_push_subscriptions', organizationId, plan.webPushSubscriptions);
  await deleteConversationPairs(client, 'conversation_user_states', organizationId, plan.conversationUserStates);
  await deleteConversationPairs(client, 'conversation_participants', organizationId, plan.conversationParticipants);
  await deleteUuidRows(client, 'messages', organizationId, plan.messages);
  await deleteUuidRows(client, 'messaging_activity_logs', organizationId, plan.messagingActivities);
  await deleteUuidRows(client, 'conversations', organizationId, plan.conversations);
  await deleteUuidRows(client, 'job_action_locations', organizationId, plan.jobActionLocations);
  await deleteUuidRows(client, 'job_card_notes', organizationId, plan.jobNotes);
  await deleteUuidRows(client, 'job_card_delivery_items', organizationId, plan.deliveryItems);
  await deleteUuidRows(client, 'job_card_meeting_details', organizationId, plan.meetingDetails, 'job_card_id');
  await deleteUuidRows(client, 'calendar_event_activity_logs', organizationId, plan.calendarActivities);
  await deleteUuidRows(client, 'calendar_reminders', organizationId, plan.reminders);
  await deleteUuidRows(client, 'staff_confidential_notes', organizationId, plan.confidentialNotes);
  await deleteUuidRows(client, 'job_card_activity_logs', organizationId, plan.jobActivities);
  await deleteRootRows(client, 'calendar_events', organizationId, plan.datasetId, plan.calendarEvents);
  for (const jobCardId of plan.jobCardDeleteOrder) {
    await deleteRootRows(client, 'job_cards', organizationId, plan.datasetId, [jobCardId]);
  }
  await deleteUuidRows(client, 'contacts', organizationId, plan.contacts);
  await deleteRootRows(client, 'customers', organizationId, plan.datasetId, plan.customers);
  await deleteRootRows(client, 'products', organizationId, plan.datasetId, plan.products);
  await deleteSessions(client, plan);
  await deleteUuidRows(client, 'processed_actions', organizationId, plan.processedActions);
  await deleteUuidRows(client, 'staff_profiles', organizationId, plan.staffProfiles);
}

function datasetDto(dataset: DemoDatasetRecord) {
  return {
    id: dataset.id,
    organizationId: dataset.organizationId,
    datasetKey: dataset.datasetKey,
    seedVersion: dataset.seedVersion,
    status: dataset.status,
    createdAt: dataset.createdAt.toISOString(),
    createdBy: dataset.createdBy,
    purgedAt: dataset.purgedAt?.toISOString() ?? null,
  } as const;
}

function purgeBlocked(blockers: readonly DemoDatasetBlocker[]) {
  return new AppError('DEMO_DATASET_PURGE_BLOCKED', 409,
    'Demo veri kümesi güvenli biçimde silinemiyor.', {
      blockerCodes: [...new Set(blockers.map((blocker) => blocker.code))].sort(),
      blockerCount: blockers.length,
    });
}

async function lockDataset(client: PoolClient, organizationId: string, datasetId: string) {
  try {
    await client.query(
      `SELECT id FROM demo_datasets
       WHERE organization_id = $1 AND id = $2
       FOR UPDATE NOWAIT`,
      [organizationId, datasetId],
    );
  } catch (error) {
    if (databaseCode(error) === '55P03') {
      throw new AppError('DEMO_DATASET_PURGE_IN_PROGRESS', 409,
        'Bu demo veri kümesi üzerinde başka bir işlem devam ediyor.');
    }
    throw error;
  }
}

async function updateDatasetToPurged(
  client: PoolClient,
  organizationId: string,
  datasetId: string,
  creatorUserId: string | null,
) {
  const result = creatorUserId
    ? await client.query(
      `UPDATE demo_datasets
       SET created_by_user_id_snapshot = created_by,
           created_by = NULL,
           status = 'PURGED',
           purged_at = NOW()
       WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
         AND created_by = $3
       RETURNING id`,
      [organizationId, datasetId, creatorUserId],
    )
    : await client.query(
      `UPDATE demo_datasets
       SET status = 'PURGED', purged_at = NOW()
       WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
       RETURNING id`,
      [organizationId, datasetId],
    );
  if (result.rows.length !== 1) {
    throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
      'Demo veri kümesi tombstone durumu güvenli biçimde güncellenemedi.');
  }
  return Boolean(creatorUserId);
}

async function assertNoTargetUserReferences(
  client: PoolClient,
  organizationId: string,
  userIds: readonly string[],
) {
  if (userIds.length === 0) return;
  const result = await client.query<{ source: string }>(
    `SELECT 'customers' AS source
       WHERE EXISTS (SELECT 1 FROM customers WHERE organization_id = $1 AND assigned_staff_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'staff_profiles'
       WHERE EXISTS (SELECT 1 FROM staff_profiles WHERE organization_id = $1 AND (user_id = ANY($2::uuid[]) OR manager_user_id = ANY($2::uuid[])))
     UNION ALL
     SELECT 'job_cards'
       WHERE EXISTS (SELECT 1 FROM job_cards WHERE organization_id = $1 AND (
         assigned_to = ANY($2::uuid[]) OR created_by = ANY($2::uuid[]) OR accepted_by = ANY($2::uuid[])
         OR staff_completed_by = ANY($2::uuid[]) OR manager_approved_by = ANY($2::uuid[])
         OR revision_requested_by = ANY($2::uuid[]) OR cancelled_by = ANY($2::uuid[])
         OR follow_up_proposed_assignee = ANY($2::uuid[]) OR follow_up_proposed_by = ANY($2::uuid[])
       ))
     UNION ALL
     SELECT 'job_card_activity_logs'
       WHERE EXISTS (SELECT 1 FROM job_card_activity_logs WHERE organization_id = $1 AND actor_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'job_card_notes'
       WHERE EXISTS (SELECT 1 FROM job_card_notes WHERE organization_id = $1 AND author_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'job_action_locations'
       WHERE EXISTS (SELECT 1 FROM job_action_locations WHERE organization_id = $1 AND actor_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'staff_confidential_notes'
       WHERE EXISTS (SELECT 1 FROM staff_confidential_notes WHERE organization_id = $1 AND (staff_user_id = ANY($2::uuid[]) OR author_user_id = ANY($2::uuid[])))
     UNION ALL
     SELECT 'calendar_events'
       WHERE EXISTS (SELECT 1 FROM calendar_events WHERE organization_id = $1 AND (
         assigned_user_id = ANY($2::uuid[]) OR created_by = ANY($2::uuid[]) OR updated_by = ANY($2::uuid[]) OR cancelled_by = ANY($2::uuid[])
       ))
     UNION ALL
     SELECT 'calendar_event_activity_logs'
       WHERE EXISTS (SELECT 1 FROM calendar_event_activity_logs WHERE organization_id = $1 AND actor_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'calendar_reminders'
       WHERE EXISTS (SELECT 1 FROM calendar_reminders WHERE organization_id = $1 AND recipient_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'conversation_participants'
       WHERE EXISTS (SELECT 1 FROM conversation_participants WHERE organization_id = $1 AND user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'conversation_user_states'
       WHERE EXISTS (SELECT 1 FROM conversation_user_states WHERE organization_id = $1 AND user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'messages'
       WHERE EXISTS (SELECT 1 FROM messages WHERE organization_id = $1 AND sender_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'messaging_activity_logs'
       WHERE EXISTS (SELECT 1 FROM messaging_activity_logs WHERE organization_id = $1 AND actor_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'in_app_notifications'
       WHERE EXISTS (SELECT 1 FROM in_app_notifications WHERE organization_id = $1 AND recipient_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'web_push_subscriptions'
       WHERE EXISTS (SELECT 1 FROM web_push_subscriptions WHERE organization_id = $1 AND recipient_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'sessions'
       WHERE EXISTS (SELECT 1 FROM sessions WHERE user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'processed_actions'
       WHERE EXISTS (SELECT 1 FROM processed_actions WHERE organization_id = $1 AND user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'realtime_events'
       WHERE EXISTS (
         SELECT 1 FROM realtime_events
         WHERE actor_user_id = ANY($2::uuid[])
            OR audience_user_ids && $2::uuid[]
       )
     UNION ALL
     SELECT 'backup_runs'
       WHERE EXISTS (SELECT 1 FROM backup_runs WHERE created_by = ANY($2::uuid[]))
     UNION ALL
     SELECT 'backup_policy'
       WHERE EXISTS (SELECT 1 FROM backup_policy WHERE updated_by = ANY($2::uuid[]))
     UNION ALL
     SELECT 'audit_events'
       WHERE EXISTS (SELECT 1 FROM audit_events WHERE organization_id = $1 AND actor_user_id = ANY($2::uuid[]))
     UNION ALL
     SELECT 'demo_datasets'
       WHERE EXISTS (SELECT 1 FROM demo_datasets WHERE organization_id = $1 AND created_by = ANY($2::uuid[]))`,
    [organizationId, userIds],
  );
  if (result.rows.length > 0) {
    throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
      'Demo kullanıcılar silinmeden önce tüm canlı FK ilişkileri ayrıştırılamadı.', {
        sources: result.rows.map((row) => row.source),
      });
  }
}

async function assertRootPostconditions(client: PoolClient, organizationId: string, datasetId: string) {
  const result = await client.query<{ table_name: string; count: string }>(
    `SELECT 'users' AS table_name, COUNT(*)::text AS count
       FROM users WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
     UNION ALL
     SELECT 'customers', COUNT(*)::text
       FROM customers WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
     UNION ALL
     SELECT 'products', COUNT(*)::text
       FROM products WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
     UNION ALL
     SELECT 'job_cards', COUNT(*)::text
       FROM job_cards WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
     UNION ALL
     SELECT 'conversations', COUNT(*)::text
       FROM conversations WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
     UNION ALL
     SELECT 'calendar_events', COUNT(*)::text
       FROM calendar_events WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2`,
    [organizationId, datasetId],
  );
  const leftovers = result.rows.filter((row) => Number(row.count) !== 0);
  if (leftovers.length > 0) {
    throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
      'Demo veri kümesi silme sonrası beklenmeyen kayıt bıraktı.', {
        tables: leftovers.map((row) => row.table_name),
      });
  }
}

export class PostgresDemoDatasetRepository implements DemoDatasetRepository {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async listDatasets(organizationId: string): Promise<readonly DemoDatasetRecord[]> {
    const result = await this.pool.query<DemoDatasetRow>(
      `SELECT ${DATASET_COLUMNS}
       ${DATASET_FROM}
       WHERE d.organization_id = $1
       ORDER BY d.created_at ASC, d.id ASC`,
      [organizationId],
    );
    return result.rows.map(mapDataset);
  }

  async findDataset(organizationId: string, datasetId: string): Promise<DemoDatasetRecord | null> {
    const result = await this.pool.query<DemoDatasetRow>(
      `SELECT ${DATASET_COLUMNS}
       ${DATASET_FROM}
       WHERE d.organization_id = $1 AND d.id = $2`,
      [organizationId, datasetId],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : null;
  }

  async getPreviewData(organizationId: string, datasetId: string): Promise<DemoDatasetPreviewData | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const analysis = await new DemoDatasetImpactAnalyzer(client).analyze(organizationId, datasetId);
      await client.query('COMMIT');
      return analysis;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async purge(
    organizationId: string,
    datasetId: string,
    actorUserId: string,
    request: DemoDatasetPurgeRequest,
  ): Promise<DemoDatasetPurgeResponse> {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      inTransaction = true;

      const initialDatasetResult = await client.query<DemoDatasetRow>(
        `SELECT ${DATASET_COLUMNS}
         ${DATASET_FROM}
         WHERE d.organization_id = $1 AND d.id = $2`,
        [organizationId, datasetId],
      );
      const initialDatasetRow = initialDatasetResult.rows[0];
      if (!initialDatasetRow) throw notFound();
      let dataset = mapDataset(initialDatasetRow);

      const existingOperationResult = await client.query<{
        id: string;
        dataset_id: string;
        plan_hash: string;
        status: 'PROCESSING' | 'COMPLETED';
        response_body: unknown;
      }>(
        `SELECT id, dataset_id, plan_hash, status, response_body
         FROM demo_dataset_purge_operations
         WHERE organization_id = $1 AND client_action_id = $2`,
        [organizationId, request.clientActionId],
      );
      const existingOperation = existingOperationResult.rows[0];
      if (existingOperation) {
        if (existingOperation.dataset_id !== datasetId
          || existingOperation.plan_hash.trim() !== request.planHash) {
          throw new AppError('CLIENT_ACTION_REUSED', 409,
            'İstemci işlem anahtarı farklı bir purge işlemi için kullanıldı.');
        }
        if (existingOperation.status === 'COMPLETED' && existingOperation.response_body) {
          await client.query('COMMIT');
          inTransaction = false;
          return existingOperation.response_body as DemoDatasetPurgeResponse;
        }
        throw new AppError('DEMO_DATASET_PURGE_IN_PROGRESS', 409,
          'Bu demo veri kümesi üzerinde başka bir işlem devam ediyor.');
      }

      if (dataset.status !== 'ACTIVE') {
        throw new AppError('DEMO_DATASET_ALREADY_PURGED', 409,
          'Demo veri kümesi daha önce purge edildi.');
      }

      await lockDataset(client, organizationId, datasetId);
      const lockedDatasetResult = await client.query<DemoDatasetRow>(
        `SELECT ${DATASET_COLUMNS}
         ${DATASET_FROM}
         WHERE d.organization_id = $1 AND d.id = $2`,
        [organizationId, datasetId],
      );
      const lockedDatasetRow = lockedDatasetResult.rows[0];
      if (!lockedDatasetRow) throw notFound();
      dataset = mapDataset(lockedDatasetRow);
      if (dataset.status !== 'ACTIVE') {
        throw new AppError('DEMO_DATASET_ALREADY_PURGED', 409,
          'Demo veri kümesi daha önce purge edildi.');
      }

      const firstAnalysis = await new DemoDatasetImpactAnalyzer(client).analyze(organizationId, datasetId);
      if (!firstAnalysis) throw notFound();
      const firstBlockers = [...firstAnalysis.blockers];
      if (firstAnalysis.purgePlan.users.includes(actorUserId)) {
        firstBlockers.push({
          code: 'PURGE_ACTOR_IN_DATASET',
          message: 'Purge işlemini başlatan kullanıcı hedef demo veri kümesine ait olamaz.',
          sourceType: 'USER',
          sourceId: actorUserId,
          relatedType: 'DEMO_DATASET',
          relatedId: datasetId,
        });
      }
      if (firstBlockers.length > 0) throw purgeBlocked(firstBlockers);

      await lockPlan(client, organizationId, firstAnalysis.purgePlan);
      const secondAnalysis = await new DemoDatasetImpactAnalyzer(client).analyze(organizationId, datasetId);
      if (!secondAnalysis) throw notFound();
      const secondBlockers = [...secondAnalysis.blockers];
      if (secondAnalysis.purgePlan.users.includes(actorUserId)) {
        secondBlockers.push({
          code: 'PURGE_ACTOR_IN_DATASET',
          message: 'Purge işlemini başlatan kullanıcı hedef demo veri kümesine ait olamaz.',
          sourceType: 'USER',
          sourceId: actorUserId,
          relatedType: 'DEMO_DATASET',
          relatedId: datasetId,
        });
      }
      if (secondBlockers.length > 0) throw purgeBlocked(secondBlockers);

      const currentPlanHash = demoDatasetPlanHash(secondAnalysis, secondBlockers);
      if (currentPlanHash !== request.planHash) {
        throw new AppError('DEMO_DATASET_PLAN_STALE', 409,
          'Demo veri kümesi önizleme planı artık güncel değil.');
      }

      const operation = await claimOperation(
        client, organizationId, datasetId, actorUserId, request, dataset,
      );
      if (operation.replay) {
        await client.query('COMMIT');
        inTransaction = false;
        return operation.replay;
      }
      if (!operation.created) {
        throw new AppError('DEMO_DATASET_PURGE_IN_PROGRESS', 409,
          'Bu demo veri kümesi üzerinde başka bir işlem devam ediyor.');
      }

      await executePlan(client, organizationId, secondAnalysis.purgePlan);
      const detachedAuditActors = await detachAuditActors(
        client, organizationId, secondAnalysis.purgePlan.retainedAuditActorLinks,
      );
      const detachedDatasetCreator = await updateDatasetToPurged(
        client, organizationId, datasetId, secondAnalysis.purgePlan.datasetCreatorUserId,
      );
      await assertNoTargetUserReferences(client, organizationId, secondAnalysis.purgePlan.users);
      await deleteRootRows(
        client,
        'users',
        organizationId,
        datasetId,
        secondAnalysis.purgePlan.users,
      );
      await assertRootPostconditions(client, organizationId, datasetId);

      const finalDatasetResult = await client.query<DemoDatasetRow>(
        `SELECT ${DATASET_COLUMNS}
         ${DATASET_FROM}
         WHERE d.organization_id = $1 AND d.id = $2`,
        [organizationId, datasetId],
      );
      const finalDatasetRow = finalDatasetResult.rows[0];
      if (!finalDatasetRow) throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
        'Purge sonrası demo veri kümesi tombstone kaydı bulunamadı.');
      const finalDataset = mapDataset(finalDatasetRow);
      const completedAt = new Date();
      const response: DemoDatasetPurgeResponse = {
        operationId: operation.operationId,
        status: 'COMPLETED',
        dataset: datasetDto(finalDataset),
        datasetKey: finalDataset.datasetKey,
        seedVersion: finalDataset.seedVersion,
        planHash: request.planHash,
        affectedCounts: secondAnalysis.affectedCounts,
        retained: {
          auditActorDetaches: detachedAuditActors,
          datasetCreatorDetached: detachedDatasetCreator,
        },
        completedAt: completedAt.toISOString(),
      };
      const completedOperation = await client.query(
        `UPDATE demo_dataset_purge_operations
         SET status = 'COMPLETED', response_body = $2::jsonb, completed_at = $3
         WHERE id = $1 AND status = 'PROCESSING'
         RETURNING id`,
        [operation.operationId, JSON.stringify(response), completedAt],
      );
      if (completedOperation.rows.length !== 1) {
        throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
          'Purge işlemi tamamlanma kaydını yazamadı.');
      }
      await client.query('COMMIT');
      inTransaction = false;
      return response;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      const code = databaseCode(error);
      if (error instanceof AppError) throw error;
      if (code === '55P03') {
        throw new AppError('DEMO_DATASET_PURGE_IN_PROGRESS', 409,
          'Bu demo veri kümesi üzerinde başka bir işlem devam ediyor.');
      }
      if (code === '40001') {
        throw new AppError('DEMO_DATASET_PLAN_STALE', 409,
          'Demo veri kümesi planı eşzamanlı bir değişiklik nedeniyle güncel değil.');
      }
      if (code === '23503') {
        throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409,
          'Demo veri kümesi beklenmeyen bir bağımlılık nedeniyle değiştirilemedi.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    organizationId: string,
    actorUserId: string,
    request: DemoDatasetCreateRequest,
  ): Promise<DemoDatasetCreateResponse> {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      const rawClientActionId = request.clientActionId?.trim() ?? '';
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(rawClientActionId)) {
        throw new AppError('VALIDATION_ERROR', 400, 'clientActionId UUID olmalıdır.');
      }
      const datasetKey = demoDatasetKeyForAction(rawClientActionId);
      if (datasetKey.length < 1 || datasetKey.length > 120) {
        throw new AppError('VALIDATION_ERROR', 400, 'datasetKey uzunluğu geçersiz.');
      }

      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      inTransaction = true;

      // Serialize per-organization: lock organization row
      const orgLock = await client.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [organizationId],
      );
      if (orgLock.rows.length === 0) {
        throw new AppError('DEMO_DATASET_NOT_FOUND', 404, 'Organizasyon bulunamadı.');
      }

      // Idempotency: deterministic key lookup first (before cardinality check)
      const existingByKey = await client.query<DemoDatasetRow>(
        `SELECT ${DATASET_COLUMNS}
          ${DATASET_FROM}
          WHERE d.organization_id = $1 AND d.dataset_key = $2`,
        [organizationId, datasetKey],
      );
      if (existingByKey.rows[0]) {
        const existing = mapDataset(existingByKey.rows[0]!);
        const counts = await this.fetchCreateCounts(client, organizationId, existing.id);
        await client.query('COMMIT');
        inTransaction = false;
        return {
          dataset: datasetDto(existing),
          counts,
          replayed: true,
        };
      }

      // Cardinality: at most one ACTIVE
      const activeResult = await client.query<{ id: string }>(
        `SELECT id FROM demo_datasets
          WHERE organization_id = $1 AND status = 'ACTIVE'
          FOR UPDATE`,
        [organizationId],
      );
      if (activeResult.rows.length > 0) {
        throw new AppError('DEMO_DATASET_ALREADY_EXISTS', 409,
          'Bu organizasyon için zaten aktif bir demo veri kümesi var.');
      }

      // Create dataset row
      const datasetInsert = await client.query<DemoDatasetRow>(
        `INSERT INTO demo_datasets
            (organization_id, dataset_key, seed_version, status, created_by)
          VALUES ($1, $2, $3, 'ACTIVE', $4)
          RETURNING id`,
        [organizationId, datasetKey, DEMO_SEED_VERSION, actorUserId],
      );
      // enrich with org name via join
      const insertedRow = datasetInsert.rows[0]!;
      // Need organization_name for mapDataset? Our DATASET_COLUMNS expects join; but insert returns without org name.
      // Re-fetch with join to get complete row.
      const insertedFetch = await client.query<DemoDatasetRow>(
        `SELECT ${DATASET_COLUMNS}
          ${DATASET_FROM}
          WHERE d.id = $1`,
        [insertedRow.id],
      );
      const datasetRecord = mapDataset(insertedFetch.rows[0]!);
      const datasetId = datasetRecord.id;

      // --- fixture generation ---
      // Users: 1 MANAGER, 2 STAFF
      const syntheticDomain = 'demo.synthetic';
      const demoUsers: Array<{ id: string; name: string; email: string; role: 'MANAGER' | 'STAFF'; passwordHash: string }> = [];
      const roles: Array<'MANAGER' | 'STAFF'> = ['MANAGER', 'STAFF', 'STAFF'];
      const names = ['Demo Yönetici', 'Demo Satış 1', 'Demo Satış 2'];
      for (let i = 0; i < 3; i++) {
        const role = roles[i]!;
        const name = names[i]!;
        const email = `demo-${role.toLowerCase()}-${rawClientActionId.slice(0, 8)}-${i + 1}-${randomBytes(2).toString('hex')}@${syntheticDomain}`;
        const passwordHash = await hashPassword(createSyntheticPassword());
        const userRow = await client.query<{ id: string }>(
          `INSERT INTO users
              (organization_id, name, email, password_hash, role, must_change_password, is_active, data_class, demo_dataset_id)
            VALUES ($1, $2, $3, $4, $5, FALSE, TRUE, 'DEMO', $6)
            RETURNING id`,
          [organizationId, name, email.toLowerCase(), passwordHash, role, datasetId],
        );
        demoUsers.push({ id: userRow.rows[0]!.id, name, email, role, passwordHash });
      }
      const demoManager = demoUsers.find((u) => u.role === 'MANAGER')!;
      const demoStaff = demoUsers.filter((u) => u.role === 'STAFF');

      // Staff profiles: all demo users get profile; STAFF manager is demoManager
      for (const user of demoUsers) {
        const managerUserId = user.role === 'STAFF' ? demoManager.id : null;
        await client.query(
          `INSERT INTO staff_profiles
              (organization_id, user_id, title, phone, region, manager_user_id)
            VALUES ($1, $2, $3, $4, $5, $6)`,
          [organizationId, user.id, user.role === 'MANAGER' ? 'Demo Bölge Müdürü' : 'Demo Satış Temsilcisi',
            `+90 5${String(300 + demoUsers.indexOf(user)).padStart(3, '0')} 000 00 0${demoUsers.indexOf(user) + 1}`,
            user.role === 'MANAGER' ? 'Marmara' : 'Ege',
            managerUserId],
        );
      }

      // Customers: 5 DEMO customers
      const demoCustomers: string[] = [];
      const customerNames = [
        'Demo Klinik A', 'Demo Hastane B', 'Demo Bayi C', 'Demo Klinik D', 'Demo Laboratuvar E',
      ];
      const customerTypes: Array<'clinic' | 'hospital' | 'dealer' | 'company' | 'other'> = ['clinic', 'hospital', 'dealer', 'clinic', 'company'];
      for (let i = 0; i < 5; i++) {
        const assigned = i < 2 ? demoStaff[0]!.id : i === 2 ? demoStaff[1]!.id : null;
        const row = await client.query<{ id: string }>(
          `INSERT INTO customers
              (organization_id, name, customer_type, assigned_staff_user_id, status, data_class, demo_dataset_id)
            VALUES ($1, $2, $3, $4, 'active', 'DEMO', $5)
            RETURNING id`,
          [organizationId, customerNames[i], customerTypes[i], assigned, datasetId],
        );
        demoCustomers.push(row.rows[0]!.id);
      }

      // Products: 5 DEMO products
      const demoProducts: Array<{ id: string; name: string; sku: string }> = [];
      const productNames = ['Demo Implant A', 'Demo Abutment B', 'Demo Ölçü C', 'Demo Kompozit D', 'Demo Frez E'];
      for (let i = 0; i < 5; i++) {
        const sku = `DEMO-${rawClientActionId.slice(0, 4).toUpperCase()}-${String(i + 1).padStart(2, '0')}-${randomBytes(2).toString('hex').toUpperCase()}`;
        const row = await client.query<{ id: string }>(
          `INSERT INTO products
              (organization_id, sku, name, brand, category, model, unit, default_price, is_active, data_class, demo_dataset_id)
            VALUES ($1, $2, $3, $4, $5, $6, 'adet', $7, TRUE, 'DEMO', $8)
            RETURNING id`,
          [organizationId, sku, productNames[i], 'DemoBrand', 'Dental', `M-${i + 1}`, (100 + i * 50).toFixed(2), datasetId],
        );
        demoProducts.push({ id: row.rows[0]!.id, name: productNames[i]!, sku });
      }

      // Jobs: 8 DEMO jobs, distribution NEW 2, ACCEPTED 1, IN_PROGRESS 1, WAITING_APPROVAL 1, COMPLETED 2, CANCELLED 1
      const jobDefinitions: Array<{
        title: string;
        status: 'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'COMPLETED' | 'CANCELLED';
        type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';
        customerIdx: number;
        assignedIdx: number;
      }> = [
        { title: 'Demo Görev — Yeni 1', status: 'NEW', type: 'GENERAL_TASK', customerIdx: 0, assignedIdx: 0 },
        { title: 'Demo Teslimat — Yeni 2', status: 'NEW', type: 'PRODUCT_DELIVERY', customerIdx: 1, assignedIdx: 1 },
        { title: 'Demo Kabul Edildi', status: 'ACCEPTED', type: 'GENERAL_TASK', customerIdx: 2, assignedIdx: 0 },
        { title: 'Demo Devam Ediyor', status: 'IN_PROGRESS', type: 'SALES_MEETING', customerIdx: 3, assignedIdx: 1 },
        { title: 'Demo Onay Bekliyor', status: 'WAITING_APPROVAL', type: 'PRODUCT_DELIVERY', customerIdx: 0, assignedIdx: 0 },
        { title: 'Demo Tamamlandı 1', status: 'COMPLETED', type: 'PRODUCT_DELIVERY', customerIdx: 1, assignedIdx: 0 },
        { title: 'Demo Tamamlandı 2', status: 'COMPLETED', type: 'SALES_MEETING', customerIdx: 4, assignedIdx: 1 },
        { title: 'Demo İptal Edildi', status: 'CANCELLED', type: 'GENERAL_TASK', customerIdx: 2, assignedIdx: 1 },
      ];

      const demoJobIds: string[] = [];
      const now = new Date();
      for (const def of jobDefinitions) {
        const customerId = demoCustomers[def.customerIdx]!;
        const assignedTo = demoStaff[def.assignedIdx]!.id;
        const createdBy = demoManager.id;
        let acceptedAt: Date | null = null;
        let acceptedBy: string | null = null;
        let startedAt: Date | null = null;
        let staffCompletedAt: Date | null = null;
        let staffCompletedBy: string | null = null;
        let managerApprovedAt: Date | null = null;
        let managerApprovedBy: string | null = null;
        let revisionRequestedAt: Date | null = null;
        let revisionRequestedBy: string | null = null;
        let revisionReason: string | null = null;
        let cancelledAt: Date | null = null;
        let cancelledBy: string | null = null;
        let cancelReason: string | null = null;

        if (def.status === 'ACCEPTED') {
          acceptedAt = now;
          acceptedBy = assignedTo;
        } else if (def.status === 'IN_PROGRESS') {
          startedAt = now;
          acceptedAt = new Date(now.getTime() - 60_000);
          acceptedBy = assignedTo;
        } else if (def.status === 'WAITING_APPROVAL') {
          startedAt = new Date(now.getTime() - 120_000);
          staffCompletedAt = now;
          staffCompletedBy = assignedTo;
          acceptedAt = new Date(now.getTime() - 180_000);
          acceptedBy = assignedTo;
        } else if (def.status === 'COMPLETED') {
          startedAt = new Date(now.getTime() - 240_000);
          staffCompletedAt = new Date(now.getTime() - 120_000);
          staffCompletedBy = assignedTo;
          managerApprovedAt = now;
          managerApprovedBy = demoManager.id;
          acceptedAt = new Date(now.getTime() - 300_000);
          acceptedBy = assignedTo;
        } else if (def.status === 'CANCELLED') {
          cancelledAt = now;
          cancelledBy = demoManager.id;
          cancelReason = 'Demo iptal senaryosu';
        }

        const row = await client.query<{ id: string }>(
          `INSERT INTO job_cards
              (organization_id, type, status, title, description, customer_id, assigned_to, created_by,
               priority, due_date, version, planned_at, started_at,
               engagement_kind,
               accepted_at, accepted_by,
               staff_completed_at, staff_completed_by,
               manager_approved_at, manager_approved_by,
               revision_requested_at, revision_requested_by, revision_reason,
               cancelled_at, cancelled_by, cancel_reason,
               data_class, demo_dataset_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                    'normal', NULL, 1, NULL, $9,
                    $10,
                    $11, $12,
                    $13, $14,
                    $15, $16,
                    $17, $18, $19,
                    $20, $21, $22,
                    'DEMO', $23)
            RETURNING id`,
          [organizationId, def.type, def.status, def.title, `${def.title} açıklaması`, customerId, assignedTo, createdBy,
            startedAt,
            def.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
            acceptedAt, acceptedBy,
            staffCompletedAt, staffCompletedBy,
            managerApprovedAt, managerApprovedBy,
            revisionRequestedAt, revisionRequestedBy, revisionReason,
            cancelledAt, cancelledBy, cancelReason,
            datasetId],
        );
        const jobId = row.rows[0]!.id;
        demoJobIds.push(jobId);

        // Create minimal activity log for coherence (JOB_CREATED)
        await client.query(
          `INSERT INTO job_card_activity_logs
              (organization_id, job_card_id, actor_id, event_type, new_value, client_action_id)
            VALUES ($1, $2, $3, 'JOB_CREATED', '{}'::jsonb, $4)`,
          [organizationId, jobId, createdBy, rawClientActionId],
        );
      }

      // Delivery items: small number, e.g. 2 jobs (WAITING_APPROVAL and first COMPLETED)
      const deliveryTargets = [demoJobIds[4]!, demoJobIds[5]!]; // indices for WAITING_APPROVAL and COMPLETED 1
      for (let idx = 0; idx < deliveryTargets.length; idx++) {
        const jobId = deliveryTargets[idx]!;
        const product = demoProducts[idx]!;
        await client.query(
          `INSERT INTO job_card_delivery_items
              (organization_id, job_card_id, product_id, delivery_purpose, delivered_at,
               quantity, unit, product_name_snapshot, product_sku_snapshot, product_model_snapshot, delivery_note, sort_order)
            VALUES ($1, $2, $3, 'SALE', NOW(), 2, 'adet', $4, $5, $6, 'Demo teslimat notu', $7)`,
          [organizationId, jobId, product.id, product.name, product.sku, `M-${idx + 1}`, idx],
        );
        await client.query(
          `INSERT INTO job_card_activity_logs
              (organization_id, job_card_id, actor_id, event_type, new_value, client_action_id)
            VALUES ($1, $2, $3, 'DELIVERY_ITEM_ADDED', $4::jsonb, $5)`,
          [organizationId, jobId, demoStaff[0]!.id, JSON.stringify({ productId: product.id, quantity: 2 }), rawClientActionId],
        );
      }

      // Notes: small number, e.g. 4 jobs (first 4)
      for (let i = 0; i < 4; i++) {
        const jobId = demoJobIds[i]!;
        const authorId = demoStaff[i % 2]!.id;
        await client.query(
          `INSERT INTO job_card_notes
              (organization_id, job_card_id, author_id, note, record_version)
            VALUES ($1, $2, $3, $4, 0)`,
          [organizationId, jobId, authorId, `Demo not ${i + 1} — operasyonel takip`],
        );
      }

      // Creation audit: one meaningful audit row (actor is BUSINESS ADMIN, remains after purge)
      try {
        await client.query(
          `INSERT INTO audit_events
              (organization_id, actor_user_id, subject_type, subject_id, event_type, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)`,
          [organizationId, actorUserId, DEMO_DATASET_AUDIT_SUBJECT_TYPE, datasetId,
            DEMO_DATASET_AUDIT_EVENT_TYPE, JSON.stringify({
              datasetKey,
              seedVersion: DEMO_SEED_VERSION,
              counts: { users: 3, customers: 5, products: 5, jobCards: 8 },
            })],
        );
      } catch {
        // audit best-effort: do not fail creation if audit insert violates constraint; rollback would hide dataset
        // but spec requires atomicity: audit should be within same tx. If audit fails, we should still fail creation
        // to keep requirement visible. Re-throw as unexpected.
        throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 500, 'Demo veri kümesi audit kaydı oluşturulamadı.');
      }

      const counts = await this.fetchCreateCounts(client, organizationId, datasetId);

      await client.query('COMMIT');
      inTransaction = false;
      return {
        dataset: datasetDto(datasetRecord),
        counts,
        replayed: false,
      };
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      const code = databaseCode(error);
      if (error instanceof AppError) throw error;
      if (code === '23505') {
        // Unique violation: likely dataset_key race; treat as idempotent replay
        // Re-fetch by key if possible
        try {
          const retryKey = demoDatasetKeyForAction(request.clientActionId);
          const retryResult = await this.pool.query<DemoDatasetRow>(
            `SELECT ${DATASET_COLUMNS} ${DATASET_FROM} WHERE d.organization_id = $1 AND d.dataset_key = $2`,
            [organizationId, retryKey],
          );
          if (retryResult.rows[0]) {
            const existing = mapDataset(retryResult.rows[0]!);
            // Need a client to fetch counts; use pool
            const tempClient = await this.pool.connect();
            try {
              const c = await this.fetchCreateCounts(tempClient, organizationId, existing.id);
              return { dataset: datasetDto(existing), counts: c, replayed: true };
            } finally { tempClient.release(); }
          }
        } catch { /* fallthrough */ }
        throw new AppError('DEMO_DATASET_ALREADY_EXISTS', 409, 'Bu organizasyon için zaten aktif bir demo veri kümesi var.');
      }
      if (code === '55P03') {
        throw new AppError('DEMO_DATASET_PURGE_IN_PROGRESS', 409, 'Bu demo veri kümesi üzerinde başka bir işlem devam ediyor.');
      }
      if (code === '40001') {
        throw new AppError('DEMO_DATASET_PLAN_STALE', 409, 'Demo veri kümesi planı eşzamanlı bir değişiklik nedeniyle güncel değil.');
      }
      if (code === '23503' || code === '23514') {
        throw new AppError('DEMO_DATASET_UNEXPECTED_DEPENDENCY', 409, 'Demo veri kümesi beklenmeyen bir bağımlılık nedeniyle oluşturulamadı.', { code });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async fetchCreateCounts(
    client: Pick<PoolClient, 'query'>,
    organizationId: string,
    datasetId: string,
  ): Promise<{ users: number; customers: number; products: number; jobCards: number }> {
    const users = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2`,
      [organizationId, datasetId],
    );
    const customers = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customers WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2`,
      [organizationId, datasetId],
    );
    const products = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM products WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2`,
      [organizationId, datasetId],
    );
    const jobCards = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM job_cards WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2`,
      [organizationId, datasetId],
    );
    return {
      users: Number(users.rows[0]?.count ?? 0),
      customers: Number(customers.rows[0]?.count ?? 0),
      products: Number(products.rows[0]?.count ?? 0),
      jobCards: Number(jobCards.rows[0]?.count ?? 0),
    };
  }
}
