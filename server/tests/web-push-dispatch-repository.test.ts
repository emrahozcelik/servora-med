import { describe, expect, it, vi } from 'vitest';

import {
  PostgresWebPushRepository,
} from '../src/modules/web-push/repository.js';

describe('WebPush dispatch repository SQL patterns', () => {
  function mockPool() {
    const queries: string[] = [];
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn().mockResolvedValue(client),
    };
    return { pool, client, queries };
  }

  it('claimDueDeliveries uses FOR UPDATE SKIP LOCKED with deterministic ordering', async () => {
    const { pool, queries } = mockPool();
    const repo = new PostgresWebPushRepository(pool as never);

    await repo.claimDueDeliveries({ limit: 4, at: new Date('2026-07-22T10:00:00.000Z') });

    const sql = queries[0] ?? '';
    expect(sql).toMatch(/FOR UPDATE OF delivery SKIP LOCKED/i);
    expect(sql).toMatch(/ORDER BY delivery\.next_attempt_at ASC, delivery\.id ASC/i);
    expect(sql).toMatch(/LIMIT \$2/);
  });

  it('claimDueDeliveries filters eligible PENDING and expired CLAIMED states', async () => {
    const { pool, queries } = mockPool();
    const repo = new PostgresWebPushRepository(pool as never);

    await repo.claimDueDeliveries({ limit: 4, at: new Date('2026-07-22T10:00:00.000Z') });

    const sql = queries[0] ?? '';
    expect(sql).toMatch(/state IN \('PENDING', 'CLAIMED'\)/i);
    expect(sql).toMatch(/delivery\.state = 'PENDING'[\s\S]*delivery\.next_attempt_at/i);
    expect(sql).toMatch(/delivery\.state = 'CLAIMED'[\s\S]*delivery\.lease_until/i);
  });

  it('claimDueDeliveries enforces eligibility joins', async () => {
    const { pool, queries } = mockPool();
    const repo = new PostgresWebPushRepository(pool as never);

    await repo.claimDueDeliveries({ limit: 4, at: new Date('2026-07-22T10:00:00.000Z') });

    const sql = queries[0] ?? '';
    expect(sql).toMatch(/notification\.read_at IS NULL/i);
    expect(sql).toMatch(/subscription\.disabled_at IS NULL/i);
    expect(sql).toMatch(/recipient\.is_active = TRUE/i);
    expect(sql).toMatch(/session_record\.revoked_at IS NULL/i);
    expect(sql).toMatch(/session_record\.expires_at > \$1/i);
    expect(sql).toMatch(/delivery\.attempt_count < 6/i);
    expect(sql).toMatch(/delivery\.created_at > \$1 - INTERVAL '24 hours'/i);
  });

  it('claimDueDeliveries returns early for limit <= 0', async () => {
    const { pool, queries } = mockPool();
    const repo = new PostgresWebPushRepository(pool as never);

    const result = await repo.claimDueDeliveries({ limit: 0, at: new Date() });
    expect(result).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('recordDelivered updates state to DELIVERED with matching lease token', async () => {
    const { pool, queries } = mockPool();
    // Override the default mock to add rowCount
    pool.query.mockImplementation((sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 1 };
    });

    const repo = new PostgresWebPushRepository(pool as never);
    const result = await repo.recordDelivered({
      deliveryId: 'del-1',
      leaseToken: 'tok-1',
      subscriptionId: 'sub-1',
      at: new Date('2026-07-22T10:00:00.000Z'),
    });

    expect(result).toBe(true);
    const sql = queries[0] ?? '';
    expect(sql).toMatch(/state = 'DELIVERED'/i);
    expect(sql).toMatch(/lease_token = NULL/);
    expect(sql).toMatch(/WHERE id = \$1[\s\S]*AND state = 'CLAIMED'/i);
    expect(sql).toMatch(/AND lease_token = \$2/);
  });

  it('recordDelivered with stale token returns false', async () => {
    const { pool } = mockPool();
    pool.query.mockImplementation((sql: string) => {
      return { rows: [], rowCount: 0 };
    });

    const repo = new PostgresWebPushRepository(pool as never);
    const result = await repo.recordDelivered({
      deliveryId: 'del-1',
      leaseToken: 'wrong-token',
      subscriptionId: 'sub-1',
      at: new Date('2026-07-22T10:00:00.000Z'),
    });

    expect(result).toBe(false);
  });

  it('recordRetry updates to PENDING with nextAttemptAt', async () => {
    const { pool, queries } = mockPool();
    pool.query.mockImplementation((sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 1 };
    });

    const repo = new PostgresWebPushRepository(pool as never);
    const result = await repo.recordRetry({
      deliveryId: 'del-1',
      leaseToken: 'tok-1',
      subscriptionId: 'sub-1',
      at: new Date('2026-07-22T10:00:00.000Z'),
      nextAttemptAt: new Date('2026-07-22T10:00:30.000Z'),
      errorCode: 'TIMEOUT',
    });

    expect(result).toBe(true);
    const sql = queries[0] ?? '';
    expect(sql).toMatch(/state = 'PENDING'/i);
    expect(sql).toMatch(/next_attempt_at = \$4/);
    expect(sql).toMatch(/last_error_code = \$5/);
    expect(sql).toMatch(/AND lease_token = \$2/);
  });

  it('recordAbandoned updates to ABANDONED with matching token', async () => {
    const { pool, queries } = mockPool();
    pool.query.mockImplementation((sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 1 };
    });

    const repo = new PostgresWebPushRepository(pool as never);
    const result = await repo.recordAbandoned({
      deliveryId: 'del-1',
      leaseToken: 'tok-1',
      at: new Date('2026-07-22T10:00:00.000Z'),
      errorCode: 'MAX_ATTEMPTS',
    });

    expect(result).toBe(true);
    const sql = queries[0] ?? '';
    expect(sql).toMatch(/state = 'ABANDONED'/i);
    expect(sql).toMatch(/AND lease_token = \$2/);
  });
});
