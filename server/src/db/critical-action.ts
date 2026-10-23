import type { Client, Pool, PoolClient } from 'pg';
import { performance } from 'node:perf_hooks';

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
  /** Opt-in whole-request deadline, including pool acquisition and commit. */
  requestTimeoutMs?: number;
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

async function withCriticalActionDeadline<T>(pool: Pool, claim: CriticalActionClaim,
  work: (client: PoolClient) => Promise<CriticalActionWorkResult<T>>, options: CriticalActionOptions, requestMs: number,
): Promise<CriticalActionResult<T>> {
  const deadline = performance.now() + requestMs;
  let expired = false; let owned: PoolClient | undefined;
  const unavailable = () => new AppError('CRITICAL_ACTION_TEMPORARILY_UNAVAILABLE', 503, 'İşlem sonucu doğrulanamıyor. Aynı istekle yeniden deneyin.');
  const release = (destroy: boolean) => {
    const client = owned; owned = undefined;
    if (!client) return;
    try { client.release(destroy); }
    finally { if (destroy) (client as PoolClient & Pick<Client, 'connection'>).connection.stream.destroy(); }
  };
  const expire = () => { expired = true; release(true); return unavailable(); };
  const checkpoint = () => { if (expired || performance.now() >= deadline) throw expire(); };
  const boundedPool = new Proxy(pool, { get(target, field) {
    if (field === 'connect') return async () => {
      let client: PoolClient;
      try { client = await target.connect(); } catch { throw unavailable(); }
      owned = client; checkpoint();
      const query = client.query.bind(client); let transaction = false;
      return new Proxy(client, { get(connection, key) {
        if (key === 'release') return (destroy = false) => release(destroy);
        if (key === 'query') return async (...args: unknown[]) => {
          checkpoint();
          const sql = typeof args[0] === 'string' ? args[0] : '';
          if (transaction && sql !== 'ROLLBACK' && !sql.startsWith('SET LOCAL')) {
            const remaining = Math.max(1, Math.floor(Math.min(options.statementTimeoutMs ?? requestMs, deadline - performance.now())));
            await query(`SET LOCAL statement_timeout = ${remaining}`); checkpoint();
          }
          const result = await Reflect.apply(query, connection, args); checkpoint();
          if (sql === 'BEGIN') transaction = true;
          return result;
        };
        const value = Reflect.get(connection, key);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, field);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expire()), requestMs); });
  // The race observes late acquisition/query rejection too. Every continuation
  // uses the guarded client; an expired request cannot issue another statement.
  const operation = runCriticalAction(boundedPool, claim, work, { ...options, requestTimeoutMs: undefined });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

/**
 * The `processed_actions` idempotency contract: claim
 * `(organization, user, clientActionId, operationKey)`, run the work in ONE
 * transaction, persist the response, and replay the stored response on an
 * exact re-submission. A changed intent is `CLIENT_ACTION_REUSED`.
 *
 * The neutral DB helper is shared by JobCard and CRM. The optional
 * transaction-local timeouts and request deadline are CRM's opt-in; existing callers omit them and
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
  const requestTimeoutMs = transactionTimeout(options.requestTimeoutMs, 'requestTimeoutMs');
  if (requestTimeoutMs !== null) return withCriticalActionDeadline(pool, claim, work, options, requestTimeoutMs);
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
