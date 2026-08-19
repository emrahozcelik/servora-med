import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresMessagingRepository } from '../src/modules/messaging/repository.js';

describe('MessagingRepository conversation archive filtering', () => {
  it('applies the archive view before cursor and limit pagination', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repository = new PostgresMessagingRepository({ query } as unknown as Pick<Pool, 'query'>);

    await (repository.listConversations as (...args: unknown[]) => Promise<unknown>)(
      randomUUID(), randomUUID(), 'STAFF',
      { updatedAt: new Date('2026-08-18T10:00:00.000Z'), id: randomUUID() },
      20,
      'archived',
    );

    const statement = query.mock.calls[0]?.[0] as string;
    const archiveFilterIndex = statement.indexOf('cus.archived_at IS NOT NULL');
    const cursorIndex = statement.indexOf('c.updated_at, c.id) <');
    const limitIndex = statement.lastIndexOf('LIMIT $6');

    expect(archiveFilterIndex).toBeGreaterThan(-1);
    expect(archiveFilterIndex).toBeLessThan(cursorIndex);
    expect(cursorIndex).toBeLessThan(limitIndex);
  });
});
