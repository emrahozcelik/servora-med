import type { Pool, PoolClient } from 'pg';

import { DemoDatasetImpactAnalyzer } from './analyzer.js';
import { demoDatasetPlanHash } from './plan.js';
import type {
  DemoDatasetBlocker,
  DemoDatasetPurgePlan,
  DemoDatasetPurgeRequest,
  DemoDatasetPurgeResponse,
  DemoDatasetPreviewData,
  DemoDatasetRecord,
  DemoDatasetRepository,
} from './types.js';

import { AppError } from '../../errors/index.js';

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
}
