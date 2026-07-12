import { describe, expect, it } from 'vitest';

import {
  AuthCredentialAdministration,
  PostgresSessionRevocationPort,
} from '../src/modules/auth/admin-ports.js';
import { requirePasswordChanged } from '../src/modules/auth/middleware.js';

describe('mandatory password change integration', () => {
  it('blocks domain work while allowing a changed-password identity through', async () => {
    const guard = requirePasswordChanged();
    const forced = { currentUser: { mustChangePassword: true } };
    const changed = { currentUser: { mustChangePassword: false } };

    await expect(guard(forced as never, {} as never)).rejects.toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED', statusCode: 403,
    });
    await expect(guard(changed as never, {} as never)).resolves.toBeUndefined();
  });

  it('sets a validated temporary password with version concurrency', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = { query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values }); return { rows: [{ version: 4 }], rowCount: 1 };
    } };
    const port = new AuthCredentialAdministration();

    await expect(port.resetTemporaryPassword(client as never, 'user-1', 3, 'temporary-password'))
      .resolves.toBe(4);
    const update = calls[0]!;
    expect(update.text).toMatch(/must_change_password = TRUE/);
    expect(update.text).toMatch(/version = version \+ 1/);
    expect(update.text).toMatch(/WHERE id = \$1 AND version = \$2/);
    expect(update.values[2]).not.toBe('temporary-password');
  });

  it('revokes every active session for a user through the supplied transaction', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = { query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values }); return { rows: [], rowCount: 2 };
    } };
    const at = new Date('2026-07-12T08:00:00.000Z');

    await new PostgresSessionRevocationPort().revokeAllSessions(client as never, 'user-1', at);

    expect(calls[0]!.text).toMatch(/UPDATE sessions SET revoked_at = COALESCE\(revoked_at, \$2\)/);
    expect(calls[0]!.values).toEqual(['user-1', at]);
  });
});
