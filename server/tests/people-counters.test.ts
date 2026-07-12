import { describe, expect, it } from 'vitest';

import { PostgresPeopleRepository } from '../src/modules/people/repository.js';

describe('Staff counter query', () => {
  it('derives overlapping counters from persisted status, approval time, and local due date', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
    };
    const repository = new PostgresPeopleRepository(
      pool as never,
      { validatePassword: () => undefined, hashPassword: async () => 'hash', resetTemporaryPassword: async () => 2 },
      { revokeAllSessions: async () => undefined },
    );

    await repository.listStaff('org-1', 'active', new Date('2026-07-12T08:00:00.000Z'));

    const query = calls[0]!;
    expect(query.text).toContain("status IN ('NEW', 'PLANNED', 'IN_PROGRESS')");
    expect(query.text).toContain("status = 'WAITING_APPROVAL'");
    expect(query.text).toContain("status = 'REVISION_REQUESTED'");
    expect(query.text).toContain("status = 'COMPLETED' AND manager_approved_at >=");
    expect(query.text).toContain("due_date < ($2::timestamptz AT TIME ZONE o.timezone)::date");
    expect(query.text).toContain("status NOT IN ('COMPLETED', 'CANCELLED')");
    expect(query.text).toContain('u.is_active = TRUE');
    expect(query.values).toEqual(['org-1', new Date('2026-07-12T08:00:00.000Z')]);
  });

  it('applies explicit active, inactive, and all Staff filters', async () => {
    const texts: string[] = [];
    const pool = { query: async (text: string) => { texts.push(text); return { rows: [], rowCount: 0 }; } };
    const repository = new PostgresPeopleRepository(
      pool as never,
      { validatePassword: () => undefined, hashPassword: async () => 'hash', resetTemporaryPassword: async () => 2 },
      { revokeAllSessions: async () => undefined },
    );

    await repository.listStaff('org-1', 'active', new Date());
    await repository.listStaff('org-1', 'inactive', new Date());
    await repository.listStaff('org-1', 'all', new Date());

    expect(texts[0]).toContain('u.is_active = TRUE');
    expect(texts[1]).toContain('u.is_active = FALSE');
    expect(texts[2]).not.toMatch(/u\.is_active = (TRUE|FALSE)/);
  });
});
