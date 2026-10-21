import type { Pool, PoolClient } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { runCriticalAction } from '../src/db/critical-action.js';
const claim = { organizationId: 'org', userId: 'actor', clientActionId: 'original', operationKey: 'TEST' };
afterEach(() => vi.useRealTimers());

it('TX-12: late pool acquisition is destroyed once without beginning work after the opted-in deadline', async () => {
  vi.useFakeTimers();
  let acquired!: (client: PoolClient) => void;
  const query = vi.fn(); const release = vi.fn(); const destroy = vi.fn(); const work = vi.fn();
  const pool = { connect: () => new Promise<PoolClient>((resolve) => { acquired = resolve; }) } as Pool;
  const result = runCriticalAction(pool, claim, work, { requestTimeoutMs: 50 }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ code: 'CRITICAL_ACTION_TEMPORARILY_UNAVAILABLE', statusCode: 503 });
  acquired({ query, release, connection: { stream: { destroy } } } as unknown as PoolClient);
  await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledExactlyOnceWith(true); expect(destroy).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
});

it('F14/TX-12: legacy claim 55P03 and callback 55P03 retain their original errors', async () => {
  for (const phase of ['legacy claim', 'opt-in callback']) {
    const original = Object.assign(new Error('synthetic lock conflict'), { code: '55P03' });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT INTO') && phase === 'legacy claim') throw original;
      return { rowCount: 1, rows: [{ id: 'receipt' }] };
    });
    const release = vi.fn(); const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    await expect(runCriticalAction(pool, claim, async () => { throw original; }, phase === 'legacy claim' ? {} : { lockTimeoutMs: 250 })).rejects.toBe(original);
    expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  }
});
