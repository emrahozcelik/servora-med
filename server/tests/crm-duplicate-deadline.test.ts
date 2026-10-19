import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';

it('READ deadline: a stalled BEGIN is discarded and settles at the total deadline', async () => {
  vi.useFakeTimers();
  const release = vi.fn(); const connection = { stream: { destroy: vi.fn() } };
  let rejectQuery!: (error: Error) => void;
  const client = { query: vi.fn(() => new Promise((_resolve, reject) => { rejectQuery = reject; })), release, connection };
  const pool = { connect: async () => client };
  try {
    const outcome = new PostgresDuplicateReadRepository(pool as unknown as Pool).snapshot(async () => 'unexpected').catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await Promise.race([outcome, Promise.resolve('STILL_PENDING')])).toMatchObject({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE', statusCode: 503 });
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(connection.stream.destroy).toHaveBeenCalledTimes(1);
    rejectQuery(new Error('Connection terminated'));
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(['SET LOCAL', 'SELECT', 'COMMIT'])('READ deadline: %s stalls discard exactly once with no late query', async (phase) => {
  vi.useFakeTimers();
  const release = vi.fn(); const connection = { stream: { destroy: vi.fn() } };
  let resolveQuery!: (value: { rows: unknown[] }) => void;
  const query = vi.fn((sql: string) => sql.startsWith(phase)
    ? new Promise(resolve => { resolveQuery = resolve; }) : Promise.resolve({ rows: [] }));
  const pool = { connect: async () => ({ query, release, connection }) };
  try {
    const result = new PostgresDuplicateReadRepository(pool as unknown as Pool).snapshot(snapshot => snapshot.source('org', null)).catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE' });
    const calls = query.mock.calls.length;
    resolveQuery({ rows: [] }); await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(calls);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(connection.stream.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('READ deadline: a late acquisition is discarded without starting a transaction', async () => {
  vi.useFakeTimers();
  const release = vi.fn(); const connection = { stream: { destroy: vi.fn() } }; const query = vi.fn();
  let acquire!: (client: PoolClient) => void;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { acquire = resolve; }) };
  try {
    const result = new PostgresDuplicateReadRepository(pool as unknown as Pool).snapshot(async () => null).catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ statusCode: 503 });
    acquire({ release, query, connection } as unknown as PoolClient); await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(connection.stream.destroy).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('READ deadline: clean COMMIT returns its result and clears the only deadline timer', async () => {
  vi.useFakeTimers();
  const release = vi.fn(); const connection = { stream: { destroy: vi.fn() } }; const query = vi.fn(async () => ({ rows: [] }));
  try {
    const result = await new PostgresDuplicateReadRepository({ connect: async () => ({ release, query, connection }) } as unknown as Pool).snapshot(async snapshot => { await snapshot.source('org', null); return 42; });
    expect(result).toBe(42);
    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SET LOCAL statement_timeout = 2000', expect.stringContaining('SELECT id,name,phone,status'), 'COMMIT',
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(connection.stream.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
