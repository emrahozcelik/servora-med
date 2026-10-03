import { beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

/**
 * Backward-compatibility contract for the new-password policy slice.
 *
 * `legacy-password` fails the NEW policy (no uppercase, no digit) but was a
 * historically valid credential. It must keep authenticating exactly as
 * before; the policy applies only when SETTING a new password. `verifyPassword`
 * stays policy-agnostic, so this distinction holds at every layer.
 */
const LEGACY_PASSWORD = 'legacy-password';

class MemoryAuthRepository implements AuthRepository {
  users: AuthUserRecord[] = [];
  sessions: SessionRecord[] = [];

  async findUserByEmail(email: string) {
    return this.users.find((user) => user.email.toLowerCase() === email) ?? null;
  }

  async findUserById(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async createSessionIfCredentialCurrent(
    input: Omit<SessionRecord, 'id' | 'revokedAt'> & { expectedPasswordHash: string },
  ) {
    const user = this.users.find((candidate) => candidate.id === input.userId);
    if (!user || !user.isActive || user.passwordHash !== input.expectedPasswordHash) return null;
    const session: SessionRecord = {
      id: `session-${this.sessions.length + 1}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.push(session);
    return session;
  }

  async upgradePasswordHashIfCurrent(): Promise<'updated' | 'conflict'> {
    return 'conflict';
  }

  async findSessionWithUser(tokenHash: string) {
    const session = this.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    const user = session && this.users.find((candidate) => candidate.id === session.userId);
    return session && user ? { session, user } : null;
  }

  async revokeSession(tokenHash: string, revokedAt: Date) {
    const session = this.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (session && !session.revokedAt) session.revokedAt = revokedAt;
  }

  async updatePasswordAndRevokeSessions(
    userId: string,
    expectedPasswordHash: string,
    passwordHash: string,
    revokedAt: Date,
  ) {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || user.passwordHash !== expectedPasswordHash) return false;
    user.passwordHash = passwordHash;
    user.mustChangePassword = false;
    user.version += 1;
    for (const session of this.sessions) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = revokedAt;
    }
    return true;
  }
}

describe('new-password policy backward compatibility', () => {
  const now = new Date('2026-07-11T08:00:00.000Z');
  let repository: MemoryAuthRepository;
  let service: AuthService;

  beforeEach(async () => {
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Legacy User',
      email: 'legacy@example.com', passwordHash: await hashPassword(LEGACY_PASSWORD),
      role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
    });
    service = new AuthService(repository, 28_800, () => now);
  });

  it('logs in with a legacy password that fails the new policy', async () => {
    const result = await service.login('legacy@example.com', LEGACY_PASSWORD);
    expect(result.user.email).toBe('legacy@example.com');
  });

  it('introduces no forced reset for legacy credentials', async () => {
    await service.login('legacy@example.com', LEGACY_PASSWORD);
    expect(repository.users[0]?.mustChangePassword).toBe(false);
  });

  it('rejects setting the legacy password as a new password with 400', async () => {
    const before = repository.users[0]!.passwordHash;
    await expect(service.changePassword('user-1', LEGACY_PASSWORD, LEGACY_PASSWORD))
      .rejects.toMatchObject({ code: 'PASSWORD_POLICY_VIOLATION', statusCode: 400 });
    expect(repository.users[0]?.passwordHash).toBe(before);
  });

  it('does not revoke sessions when new-password validation fails', async () => {
    const login = await service.login('legacy@example.com', LEGACY_PASSWORD);
    await expect(service.changePassword('user-1', LEGACY_PASSWORD, 'still-legacy'))
      .rejects.toMatchObject({ code: 'PASSWORD_POLICY_VIOLATION', statusCode: 400 });
    await expect(service.authenticateSession(login.rawToken)).resolves.toBeDefined();
  });

  it('accepts a compliant new password and revokes existing sessions', async () => {
    const login = await service.login('legacy@example.com', LEGACY_PASSWORD);
    await service.changePassword('user-1', LEGACY_PASSWORD, 'Serv1!');
    await expect(service.authenticateSession(login.rawToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(service.login('legacy@example.com', 'Serv1!')).resolves.toBeDefined();
    await expect(service.login('legacy@example.com', LEGACY_PASSWORD)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });
});
