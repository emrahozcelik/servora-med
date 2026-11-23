import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const original = new Error('original failure');

function repositoryDouble(rollback: () => Promise<unknown>) {
  const query = vi.fn(async (text: string) => (
    text === 'ROLLBACK' ? rollback() : { rowCount: 0, rows: [] }
  ));
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) };
  return {
    repository: new PostgresJobCardRepository(pool as unknown as Pool),
    query,
    release,
  };
}

describe('PostgresJobCardRepository.executeTransaction', () => {
  it('rolls back a failed attempt and returns the healthy connection to the pool', async () => {
    const { repository, query, release } = repositoryDouble(async () => ({ rowCount: 0, rows: [] }));

    await expect(repository.executeTransaction(async () => { throw original; })).rejects.toBe(original);

    expect(query.mock.calls.map(([text]) => text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps the original failure when ROLLBACK also fails and destroys the broken connection', async () => {
    const { repository, release } = repositoryDouble(async () => {
      throw new Error('connection terminated unexpectedly');
    });

    await expect(repository.executeTransaction(async () => { throw original; })).rejects.toBe(original);

    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
