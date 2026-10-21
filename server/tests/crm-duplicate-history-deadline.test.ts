import type { Pool, QueryResultRow } from 'pg';
import { expect, it, vi } from 'vitest';
import { PostgresDuplicateReviewRepository } from '../src/modules/crm/duplicate-review-repository.js';

const actor = { organizationId: 'org', id: 'actor', role: 'MANAGER' as const };
const head = { rows: [{ id: 'review', version: 1 }] };

it.each(['acquire', 'BEGIN', 'SET LOCAL', 'head', 'events', 'COMMIT'])(
  'history deadline: stalled %s settles, discards once and cannot continue late', async phase => {
    vi.useFakeTimers();
    let resume!: (value: unknown) => void;
    const stalled = new Promise(resolve => { resume = resolve; });
    const query = vi.fn((sql: string) => {
      const current = sql.startsWith('SELECT id,version') ? 'head'
        : sql.startsWith('SELECT id,seq') ? 'events'
          : sql.startsWith('SET LOCAL') ? 'SET LOCAL' : sql.split(' ')[0];
      return current === phase ? stalled : Promise.resolve(current === 'head' ? head : { rows: [] });
    });
    const client = { query, release: vi.fn(), connection: { stream: { destroy: vi.fn() } } };
    const pool = { connect: () => phase === 'acquire' ? stalled : Promise.resolve(client) };
    const result = new PostgresDuplicateReviewRepository(pool as unknown as Pool, {} as never)
      .history(actor, 'review', null, 20).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await Promise.race([result, Promise.resolve('STILL_PENDING')]))
        .toMatchObject({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE', statusCode: 503 });
      const callsAtDeadline = query.mock.calls.length;
      resume(phase === 'acquire' ? client : { rows: [] });
      await vi.advanceTimersByTimeAsync(1);
      expect(query).toHaveBeenCalledTimes(callsAtDeadline);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { resume(phase === 'acquire' ? client : { rows: [] }); await result; vi.useRealTimers(); }
  },
);

it('history snapshot bounds both SELECTs and commits a clean read without destroying the client', async () => {
  const query = vi.fn(async (sql: string): Promise<{ rows: QueryResultRow[] }> => sql.startsWith('SELECT id,version') ? head : { rows: [] });
  const client = { query, release: vi.fn(), connection: { stream: { destroy: vi.fn() } } };
  const result = await new PostgresDuplicateReviewRepository({ connect: async () => client } as unknown as Pool, {} as never).history(actor, 'review', null, 20);
  expect(result).toEqual({ reviewId: 'review', upperSeq: 1, items: [], nextCursor: null });
  const statements = query.mock.calls.map(call => call[0]);
  expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(statements.at(-1)).toBe('COMMIT');
  for (const index of [2, 4]) {
    expect(statements[index]).toMatch(/^SELECT/);
    const timeout = Number(statements[index - 1]!.match(/statement_timeout = (\d+)$/)?.[1]);
    expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(2_000);
  }
  expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  expect(client.connection.stream.destroy).not.toHaveBeenCalled();
});

it('history cursor failure does not wait for rollback on an unresponsive transport', async () => {
  const query = vi.fn(async (sql: string) => sql.startsWith('SELECT id,version') ? head : { rows: [] });
  const client = { query, release: vi.fn(), connection: { stream: { destroy: vi.fn() } } };
  const result = new PostgresDuplicateReviewRepository({ connect: async () => client } as unknown as Pool, {} as never).history(actor, 'review', 'invalid', 20);
  await expect(result).rejects.toMatchObject({ code: 'CURSOR_RESTART_REQUIRED', statusCode: 409 });
  expect(query.mock.calls.some(call => call[0] === 'ROLLBACK')).toBe(false);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(client.connection.stream.destroy).toHaveBeenCalledTimes(1);
});
