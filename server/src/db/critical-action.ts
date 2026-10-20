import type { Pool, PoolClient } from 'pg';

import { AppError } from '../errors/index.js';
import type { RealtimeEventRecord } from '../modules/realtime/types.js';

export type CriticalActionClaim = {
  organizationId: string;
  userId: string;
  clientActionId: string;
  operationKey: string;
  requestHash?: string;
};

export type CriticalActionWorkResult<T> = Readonly<{
  response: T;
  realtimeEvents: readonly RealtimeEventRecord[];
}>;

export type CriticalActionResult<T> =
  | {
      kind: 'completed';
      response: T;
      realtimeEvents: readonly RealtimeEventRecord[];
    }
  | {
      kind: 'replay';
      response: T;
      realtimeEvents: readonly [];
    }
  | { kind: 'processing' };

export type CriticalActionOptions = {
  /** Opt-in transaction-local timeout before the receipt claim. */
  statementTimeoutMs?: number;
  /** Opt-in transaction-local lock timeout before the receipt claim. */
  lockTimeoutMs?: number;
};

export function assertCriticalActionRequestHash(
  expected: string | undefined,
  stored: string | null | undefined,
) {
  if (expected !== undefined && stored !== expected) {
    throw new AppError(
      'CLIENT_ACTION_REUSED',
      409,
      'clientActionId farklı bir işlem içeriğiyle yeniden kullanılamaz.',
    );
  }
}

function transactionTimeout(value: number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError('INTERNAL_ERROR', 500, `${name} must be a positive integer.`);
  }
  return value;
}

/**
 * The `processed_actions` idempotency contract: claim
 * `(organization, user, clientActionId, operationKey)`, run the work in ONE
 * transaction, persist the response, and replay the stored response on an
 * exact re-submission. A changed intent is `CLIENT_ACTION_REUSED`.
 *
 * The neutral DB helper is shared by JobCard/recurrence and CRM. The optional
 * transaction-local timeouts are CRM's opt-in; existing callers omit them and
 * keep their previous behavior. Receipt completion must affect exactly one
 * row or the whole transaction rolls back.
 */
export async function runCriticalAction<T>(
  pool: Pool,
  claim: CriticalActionClaim,
  work: (client: PoolClient) => Promise<CriticalActionWorkResult<T>>,
  options: CriticalActionOptions = {},
): Promise<CriticalActionResult<T>> {
  const statementTimeoutMs = transactionTimeout(options.statementTimeoutMs, 'statementTimeoutMs');
  const lockTimeoutMs = transactionTimeout(options.lockTimeoutMs, 'lockTimeoutMs');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (statementTimeoutMs !== null) await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    if (lockTimeoutMs !== null) await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
    const claimed = await client.query<{ id: string }>(
      `INSERT INTO processed_actions
         (organization_id, user_id, client_action_id, operation_key, request_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')
       ON CONFLICT (organization_id, user_id, client_action_id, operation_key) DO NOTHING
       RETURNING id`,
      [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey, claim.requestHash ?? null],
    ).catch((error: unknown) => {
      if (lockTimeoutMs !== null && (error as { code?: string } | null)?.code === '55P03') {
        throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem isteği işleniyor. Aynı istekle yeniden deneyin.');
      }
      throw error;
    });

    if (claimed.rowCount === 0) {
      const existing = await client.query<{
        status: string;
        response_body: T | null;
        request_hash: string | null;
      }>(
        `SELECT status, response_body, request_hash FROM processed_actions
         WHERE organization_id = $1 AND user_id = $2
           AND client_action_id = $3 AND operation_key = $4`,
        [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
      );
      const action = existing.rows[0];
      assertCriticalActionRequestHash(claim.requestHash, action?.request_hash);
      await client.query('COMMIT');
      if (action?.status === 'completed' && action.response_body !== null) {
        return { kind: 'replay', response: action.response_body, realtimeEvents: [] };
      }
      return { kind: 'processing' };
    }

    const workResult = await work(client);
    const completed = await client.query<{ id: string }>(
      `UPDATE processed_actions
       SET status = 'completed', status_code = 200, response_body = $2, completed_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [claimed.rows[0]!.id, workResult.response],
    );
    if (completed.rowCount !== 1 || !completed.rows[0]) {
      throw new AppError('CRITICAL_ACTION_RECEIPT_INCOMPLETE', 500, 'İşlem makbuzu tamamlanamadı.');
    }
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
