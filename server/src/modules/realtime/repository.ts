import type { Pool, PoolClient } from 'pg';

import { acquireRealtimeOrderingLock } from './ordering.js';
import type {
  RealtimeEventInput,
  RealtimeEventRecord,
  RealtimeEventType,
  RealtimeViewer,
} from './types.js';

type EventRow = {
  id: string;
  organization_id: string;
  source_activity_id: string | null;
  messaging_activity_id: string | null;
  event_type: RealtimeEventType;
  entity_type: 'job-card' | 'calendar-event' | 'conversation' | 'confidential-note';
  entity_id: string;
  actor_user_id: string | null;
  audience_roles: ('ADMIN' | 'MANAGER')[];
  audience_user_ids: string[];
  resource_keys: string[];
  created_at: Date;
  sale_assignee_id?: string | null;
  sale_source_id?: string | null;
  source_assignee_id?: string | null;
  related_source_assignee_id?: string | null;
  related_sale_id?: string | null;
};

const COLUMNS_NO_MSG = `id, organization_id, source_activity_id, event_type,
  entity_type, entity_id, actor_user_id, audience_roles,
  audience_user_ids, resource_keys, created_at`;

const COLUMNS = `${COLUMNS_NO_MSG}, messaging_activity_id`;

// Sale and visit are authorized independently at replay, even after reassignment.
const SALE_SCOPE_JOIN = `LEFT JOIN LATERAL (
  SELECT sale.assigned_to AS sale_assignee_id, source.id AS sale_source_id,
    source.assigned_to AS source_assignee_id
  FROM job_cards sale LEFT JOIN job_cards source
    ON source.organization_id=sale.organization_id AND source.id=sale.sale_source_visit_id
  WHERE sale.organization_id=realtime_events.organization_id AND sale.id=realtime_events.entity_id
    AND sale.type='SALE' AND realtime_events.entity_type='job-card'
) sale_scope ON TRUE`;
const SALE_CURRENT_ACCESS = `AND ($2 <> 'STAFF' OR sale_scope.sale_assignee_id IS NULL
  OR sale_scope.sale_assignee_id=$3 OR sale_scope.source_assignee_id=$3
  OR (event_type='job.assignment_changed' AND $3=ANY(audience_user_ids)))`;

// One indexed history probe per source event, irrespective of the number of
// historical sales. The personal key invalidates all of this viewer's origins.
const SALE_ORIGIN_JOIN = `LEFT JOIN LATERAL (
  SELECT source.assigned_to AS related_source_assignee_id,
    (SELECT sale.id FROM job_cards sale
      WHERE sale.organization_id=source.organization_id AND sale.sale_source_visit_id=source.id
        AND sale.type='SALE' AND ($2 <> 'STAFF' OR sale.assigned_to=$3)
      ORDER BY sale.created_at DESC, sale.id DESC LIMIT 1) AS related_sale_id
  FROM job_cards source
  WHERE source.organization_id=realtime_events.organization_id AND source.id=realtime_events.entity_id
    AND source.type='SALES_MEETING' AND realtime_events.entity_type='job-card'
    AND 'sale-origin-context'=ANY(realtime_events.resource_keys)
) origin_scope ON TRUE`;
const SALE_ORIGIN_CURRENT_ACCESS = `AND ($2 <> 'STAFF' OR origin_scope.related_source_assignee_id IS NULL
  OR origin_scope.related_source_assignee_id=$3 OR origin_scope.related_sale_id IS NOT NULL
  OR (event_type='job.assignment_changed' AND $3=ANY(audience_user_ids)))`;
const VISIBLE_AUDIENCE = `($2 = ANY(audience_roles) OR $3 = ANY(audience_user_ids)
  OR origin_scope.related_sale_id IS NOT NULL)`;

function mapEvent(row: EventRow, viewer?: RealtimeViewer): RealtimeEventRecord {
  // Handover participants (persisted assignment audience) always see the
  // source assignment itself, even when they still own historical sales:
  // otherwise the origin-only rewrite would mask the workspace invalidation
  // and the former owner would keep a stale source card. The personal origin
  // key below still wakes their open Sale screens; no foreign identity leaks
  // because every key is either the already-known source or the viewer's own.
  const handoverParticipant = viewer?.role === 'STAFF' && row.event_type === 'job.assignment_changed'
    && viewer.userId != null && row.audience_user_ids.includes(viewer.userId);
  const saleOnlyOrigin = viewer?.role === 'STAFF' && row.related_sale_id != null
    && row.related_source_assignee_id !== viewer.userId && !handoverParticipant;
  const sourceOnly = viewer?.role === 'STAFF' && row.sale_assignee_id != null && row.sale_assignee_id !== viewer.userId;
  const revokedSale = sourceOnly && row.source_assignee_id !== viewer.userId;
  const restrictedSource = viewer?.role === 'STAFF' && row.sale_source_id != null && row.source_assignee_id !== viewer.userId;
  const keys = row.resource_keys.filter((key) => !viewer || (key !== 'sale-origin-context'
    && (viewer.role !== 'STAFF' || (row.sale_assignee_id == null && row.related_source_assignee_id == null)
      || !key.startsWith('staff-profile:') || key === 'staff-profile:' + viewer.userId)));
  if (viewer && row.related_sale_id) keys.push('sale-origin-context:' + viewer.userId);
  return {
    id: BigInt(row.id),
    organizationId: row.organization_id,
    sourceActivityId: row.source_activity_id,
    messagingActivityId: row.messaging_activity_id,
    type: sourceOnly || saleOnlyOrigin ? 'job.updated' : row.event_type,
    // A former owner may learn only that their personal workspace changed.
    // Use the existing private notification-center identity, never a revoked card ID.
    entityType: revokedSale ? 'notification-center' : row.entity_type,
    entityId: revokedSale ? viewer!.userId : saleOnlyOrigin ? row.related_sale_id! : sourceOnly ? row.sale_source_id! : row.entity_id,
    actorUserId: row.actor_user_id,
    audience: {
      roles: row.audience_roles,
      userIds: row.audience_user_ids,
    },
    resourceKeys: revokedSale
      ? ['sale-origin-context:' + viewer!.userId, 'job-list', 'job-board', 'reports', 'overview', 'staff-profile:' + viewer!.userId]
      : saleOnlyOrigin
      ? ['job-detail:' + row.related_sale_id, 'sale-origin-context:' + viewer!.userId]
      : sourceOnly
      ? ['job-detail:' + row.sale_source_id, 'sale-origin-context:' + viewer!.userId,
        'job-list', 'job-board', 'reports', 'overview', 'staff-profile:' + viewer!.userId]
      : restrictedSource ? keys.filter((key) => key !== 'job-detail:' + row.sale_source_id)
      : keys,
    occurredAt: row.created_at,
  };
}

export interface RealtimeEventTransaction {
  append(input: RealtimeEventInput): Promise<RealtimeEventRecord>;
}

export class PostgresRealtimeEventTransaction
implements RealtimeEventTransaction {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async append(input: RealtimeEventInput): Promise<RealtimeEventRecord> {
    await acquireRealtimeOrderingLock(this.client, input.organizationId);
    const hasMsg = input.messagingActivityId != null;
    const columns = hasMsg ? COLUMNS : COLUMNS_NO_MSG;
    const keysParam = '$' + (hasMsg ? '10' : '9');
    // Internal wake-up hint, never a second event. Avoid waking unrelated
    // subscribers for visits which have no sale history.
    const resourceKeys = input.resourceKeys.includes('sale-origin-context')
      ? `CASE WHEN EXISTS (SELECT 1 FROM job_cards sale WHERE sale.organization_id=$1
          AND sale.sale_source_visit_id=$${hasMsg ? '6' : '5'} AND sale.type='SALE')
          THEN ${keysParam}::text[] ELSE array_remove(${keysParam}::text[], 'sale-origin-context') END`
      : keysParam;
    const result = await this.client.query<EventRow>(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id${hasMsg ? ', messaging_activity_id' : ''}, event_type, entity_type,
         entity_id, actor_user_id, audience_roles, audience_user_ids,
         resource_keys, created_at)
       VALUES ($1,$2${hasMsg ? ',$3' : ''},$${hasMsg ? '4' : '3'},$${hasMsg ? '5' : '4'},$${hasMsg ? '6' : '5'},
               $${hasMsg ? '7' : '6'},$${hasMsg ? '8' : '7'},$${hasMsg ? '9' : '8'},
               ${resourceKeys},$${hasMsg ? '11' : '10'})
       RETURNING ${columns}`,
      [
        input.organizationId,
        input.sourceActivityId ?? null,
        ...(hasMsg ? [input.messagingActivityId] : []),
        input.type,
        input.entityType,
        input.entityId,
        input.actorUserId,
        input.audience.roles,
        input.audience.userIds,
        input.resourceKeys,
        input.occurredAt,
      ],
    );
    return mapEvent(result.rows[0]!);
  }
}

export interface RealtimeEventRepository {
  replayVisible(
    viewer: RealtimeViewer,
    afterId: bigint,
    limit: number,
  ): Promise<RealtimeEventRecord[]>;
  visibleHighWater(viewer: RealtimeViewer): Promise<bigint>;
}

export class PostgresRealtimeEventRepository
implements RealtimeEventRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async replayVisible(
    viewer: RealtimeViewer,
    afterId: bigint,
    limit: number,
  ): Promise<RealtimeEventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT ${COLUMNS}, sale_scope.sale_assignee_id, sale_scope.sale_source_id, sale_scope.source_assignee_id,
          origin_scope.related_source_assignee_id, origin_scope.related_sale_id
         FROM realtime_events
         ${SALE_SCOPE_JOIN}
         ${SALE_ORIGIN_JOIN}
        WHERE organization_id = $1
          AND ${VISIBLE_AUDIENCE}
          ${SALE_CURRENT_ACCESS}
          ${SALE_ORIGIN_CURRENT_ACCESS}
          AND id > $4
        ORDER BY id ASC
        LIMIT $5`,
      [
        viewer.organizationId,
        viewer.role,
        viewer.userId,
        afterId.toString(),
        limit,
      ],
    );
    return result.rows.map((row) => mapEvent(row, viewer));
  }

  async visibleHighWater(viewer: RealtimeViewer): Promise<bigint> {
    const result = await this.pool.query<{ id: string | null }>(
      `SELECT MAX(id)::text AS id
         FROM realtime_events
         ${SALE_SCOPE_JOIN}
         ${SALE_ORIGIN_JOIN}
        WHERE organization_id = $1
          AND ${VISIBLE_AUDIENCE}
          ${SALE_CURRENT_ACCESS}
          ${SALE_ORIGIN_CURRENT_ACCESS}`,
      [viewer.organizationId, viewer.role, viewer.userId],
    );
    return BigInt(result.rows[0]?.id ?? '0');
  }
}
