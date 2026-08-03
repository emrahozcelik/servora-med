import type { Pool, PoolClient } from 'pg';

import type { UserRole } from '../auth/types.js';
import type { RealtimeEventInput, RealtimeEventRecord } from '../realtime/types.js';
import type {
  StaffConfidentialNoteAuditInput,
  StaffConfidentialNoteCriticalActionClaim,
  StaffConfidentialNoteCriticalActionResult,
  StaffConfidentialNoteCriticalActionWorkResult,
  StaffConfidentialNoteDto,
  StaffConfidentialNotePage,
  StaffConfidentialNotePageQuery,
  StaffConfidentialNoteRecord,
} from './types.js';

export type StaffUserSnapshot = {
  id: string;
  organizationId: string;
  role: UserRole;
  isActive: boolean;
};

export type CreateStaffConfidentialNoteRecord = {
  id: string;
  organizationId: string;
  staffUserId: string;
  authorUserId: string;
  body: string;
};

type NoteRow = {
  id: string;
  organization_id: string;
  staff_user_id: string;
  author_user_id: string;
  body: string;
  created_at: Date;
};

type RealtimeEventRow = {
  id: string;
  organization_id: string;
  event_type: RealtimeEventRecord['type'];
  entity_type: RealtimeEventRecord['entityType'];
  entity_id: string;
  actor_user_id: string | null;
  audience_roles: ('ADMIN' | 'MANAGER')[];
  audience_user_ids: string[];
  resource_keys: string[];
  created_at: Date;
};

const NOTE_COLUMNS = 'id, organization_id, staff_user_id, author_user_id, body, created_at';

function mapNote(row: NoteRow): StaffConfidentialNoteRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    staffUserId: row.staff_user_id,
    authorUserId: row.author_user_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export function presentNote(
  note: StaffConfidentialNoteRecord,
  authorName: string,
): StaffConfidentialNoteDto {
  return {
    id: note.id,
    organizationId: note.organizationId,
    staffUserId: note.staffUserId,
    authorUserId: note.authorUserId,
    authorName,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}

function mapRealtimeEvent(row: RealtimeEventRow): RealtimeEventRecord {
  return {
    id: BigInt(row.id),
    organizationId: row.organization_id,
    sourceActivityId: null,
    messagingActivityId: null,
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

export interface StaffConfidentialNotesTransaction {
  lockActor(organizationId: string, userId: string): Promise<StaffUserSnapshot | null>;
  findSubject(organizationId: string, userId: string): Promise<StaffUserSnapshot | null>;
  createNote(input: CreateStaffConfidentialNoteRecord): Promise<StaffConfidentialNoteRecord>;
  appendAudit(input: StaffConfidentialNoteAuditInput): Promise<void>;
  appendRealtimeEvent(input: RealtimeEventInput): Promise<RealtimeEventRecord>;
}

export interface StaffConfidentialNotesRepository {
  execute<T>(work: (tx: StaffConfidentialNotesTransaction) => Promise<T>): Promise<T>;
  executeCriticalAction<T>(
    claim: StaffConfidentialNoteCriticalActionClaim,
    work: (
      tx: StaffConfidentialNotesTransaction,
    ) => Promise<StaffConfidentialNoteCriticalActionWorkResult<T>>,
  ): Promise<StaffConfidentialNoteCriticalActionResult<T>>;
  findCompletedCriticalAction<T>(claim: StaffConfidentialNoteCriticalActionClaim): Promise<T | null>;
  findSubject(organizationId: string, userId: string): Promise<StaffUserSnapshot | null>;
  listNotes(
    organizationId: string,
    staffUserId: string,
    page: StaffConfidentialNotePageQuery,
  ): Promise<StaffConfidentialNotePage>;
}

const USER_SNAPSHOT_COLUMNS = 'id, organization_id, role, is_active';

function mapUserSnapshot(row: {
  id: string;
  organization_id: string;
  role: UserRole;
  is_active: boolean;
}): StaffUserSnapshot {
  return {
    id: row.id,
    organizationId: row.organization_id,
    role: row.role,
    isActive: row.is_active,
  };
}

class PostgresStaffConfidentialNotesTransaction
implements StaffConfidentialNotesTransaction {
  constructor(private readonly client: PoolClient) {}

  async lockActor(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string;
      organization_id: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `SELECT ${USER_SNAPSHOT_COLUMNS} FROM users
        WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapUserSnapshot(result.rows[0]) : null;
  }

  async findSubject(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string;
      organization_id: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `SELECT ${USER_SNAPSHOT_COLUMNS} FROM users
        WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapUserSnapshot(result.rows[0]) : null;
  }

  async createNote(input: CreateStaffConfidentialNoteRecord) {
    const result = await this.client.query<NoteRow>(
      `INSERT INTO staff_confidential_notes
         (id, organization_id, staff_user_id, author_user_id, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${NOTE_COLUMNS}`,
      [input.id, input.organizationId, input.staffUserId, input.authorUserId, input.body],
    );
    return mapNote(result.rows[0]!);
  }

  async appendAudit(input: StaffConfidentialNoteAuditInput) {
    await this.client.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.organizationId,
        input.actorUserId,
        input.subjectType,
        input.subjectId,
        input.eventType,
        input.oldValue,
        input.newValue,
        input.metadata,
      ],
    );
  }

  async appendRealtimeEvent(input: RealtimeEventInput) {
    const result = await this.client.query<RealtimeEventRow>(
      `INSERT INTO realtime_events
         (organization_id, staff_note_id, event_type, entity_type,
          entity_id, actor_user_id, audience_roles, audience_user_ids,
          resource_keys, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, organization_id, event_type, entity_type, entity_id,
                 actor_user_id, audience_roles, audience_user_ids,
                 resource_keys, created_at`,
      [
        input.organizationId,
        input.entityId,
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
    return mapRealtimeEvent(result.rows[0]!);
  }
}

export class PostgresStaffConfidentialNotesRepository
implements StaffConfidentialNotesRepository {
  constructor(private readonly pool: Pool) {}

  async execute<T>(work: (tx: StaffConfidentialNotesTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresStaffConfidentialNotesTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findCompletedCriticalAction<T>(
    claim: StaffConfidentialNoteCriticalActionClaim,
  ): Promise<T | null> {
    const result = await this.pool.query<{ response_body: T }>(
      `SELECT response_body
         FROM processed_actions
        WHERE organization_id = $1 AND user_id = $2
          AND client_action_id = $3 AND operation_key = $4
          AND status = 'completed' AND response_body IS NOT NULL`,
      [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
    );
    return result.rows[0]?.response_body ?? null;
  }

  async findSubject(organizationId: string, userId: string) {
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      role: UserRole;
      is_active: boolean;
    }>(
      `SELECT ${USER_SNAPSHOT_COLUMNS} FROM users
        WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapUserSnapshot(result.rows[0]) : null;
  }

  async executeCriticalAction<T>(
    claim: StaffConfidentialNoteCriticalActionClaim,
    work: (
      tx: StaffConfidentialNotesTransaction,
    ) => Promise<StaffConfidentialNoteCriticalActionWorkResult<T>>,
  ): Promise<StaffConfidentialNoteCriticalActionResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, status)
         VALUES ($1, $2, $3, $4, 'processing')
         ON CONFLICT (organization_id, user_id, client_action_id, operation_key) DO NOTHING
         RETURNING id`,
        [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
      );

      if (claimed.rowCount === 0) {
        const existing = await client.query<{ status: string; response_body: T | null }>(
          `SELECT status, response_body FROM processed_actions
            WHERE organization_id = $1 AND user_id = $2
              AND client_action_id = $3 AND operation_key = $4`,
          [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
        );
        await client.query('COMMIT');
        const action = existing.rows[0];
        if (action?.status === 'completed' && action.response_body !== null) {
          return { kind: 'replay', response: action.response_body, realtimeEvents: [] };
        }
        return { kind: 'processing' };
      }

      const workResult = await work(new PostgresStaffConfidentialNotesTransaction(client));
      await client.query(
        `UPDATE processed_actions
          SET status = 'completed', status_code = 200, response_body = $2, completed_at = NOW()
          WHERE id = $1`,
        [claimed.rows[0]!.id, workResult.response],
      );
      await client.query('COMMIT');
      return {
        kind: 'completed',
        response: workResult.response,
        realtimeEvents: workResult.realtimeEvents,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listNotes(
    organizationId: string,
    staffUserId: string,
    page: StaffConfidentialNotePageQuery,
  ) {
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM staff_confidential_notes
        WHERE organization_id = $1 AND staff_user_id = $2`,
      [organizationId, staffUserId],
    );
    const items = await this.pool.query<NoteRow & { author_name: string }>(
      `SELECT n.id, n.organization_id, n.staff_user_id, n.author_user_id, n.body, n.created_at,
              u.name AS author_name
         FROM staff_confidential_notes n
         JOIN users u
           ON u.organization_id = n.organization_id AND u.id = n.author_user_id
        WHERE n.organization_id = $1 AND n.staff_user_id = $2
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $3 OFFSET $4`,
      [organizationId, staffUserId, page.limit, page.offset],
    );
    return {
      items: items.rows.map((row) => presentNote(mapNote(row), row.author_name)),
      total: count.rows[0]!.total,
      limit: page.limit,
      offset: page.offset,
    };
  }
}
