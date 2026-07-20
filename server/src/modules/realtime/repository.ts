import type { Pool, PoolClient } from 'pg';

import type {
  RealtimeEventInput,
  RealtimeEventRecord,
  RealtimeEventType,
  RealtimeViewer,
} from './types.js';

type EventRow = {
  id: string;
  organization_id: string;
  source_activity_id: string;
  event_type: RealtimeEventType;
  entity_type: 'job-card';
  entity_id: string;
  actor_user_id: string | null;
  audience_roles: ('ADMIN' | 'MANAGER')[];
  audience_user_ids: string[];
  resource_keys: string[];
  created_at: Date;
};

const COLUMNS = `id, organization_id, source_activity_id, event_type,
  entity_type, entity_id, actor_user_id, audience_roles,
  audience_user_ids, resource_keys, created_at`;

function mapEvent(row: EventRow): RealtimeEventRecord {
  return {
    id: BigInt(row.id),
    organizationId: row.organization_id,
    sourceActivityId: row.source_activity_id,
    type: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    audience: {
      roles: row.audience_roles,
      userIds: row.audience_user_ids,
    },
    resourceKeys: row.resource_keys,
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
    await this.client.query(
      'SELECT pg_advisory_xact_lock(1, hashtext($1::text))',
      [input.organizationId],
    );
    const result = await this.client.query<EventRow>(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id, event_type, entity_type,
         entity_id, actor_user_id, audience_roles, audience_user_ids,
         resource_keys, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${COLUMNS}`,
      [
        input.organizationId,
        input.sourceActivityId,
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
      `SELECT ${COLUMNS}
         FROM realtime_events
        WHERE organization_id = $1
          AND ($2 = ANY(audience_roles) OR $3 = ANY(audience_user_ids))
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
    return result.rows.map(mapEvent);
  }

  async visibleHighWater(viewer: RealtimeViewer): Promise<bigint> {
    const result = await this.pool.query<{ id: string | null }>(
      `SELECT MAX(id)::text AS id
         FROM realtime_events
        WHERE organization_id = $1
          AND ($2 = ANY(audience_roles) OR $3 = ANY(audience_user_ids))`,
      [viewer.organizationId, viewer.role, viewer.userId],
    );
    return BigInt(result.rows[0]?.id ?? '0');
  }
}
