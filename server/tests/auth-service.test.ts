import { beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, hashSessionToken } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';

class MemoryAuthRepository implements AuthRepository {
  users: AuthUserRecord[] = [];
  sessions: SessionRecord[] = [];

  async findUserByEmail(email: string) {
    return this.users.find((user) => user.email.toLowerCase() === email) ?? null;
  }

  async findUserById(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const session = { ...input, id: `session-${this.sessions.length + 1}`, revokedAt: null };
    this.sessions.push(session);
    return session;
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

describe('AuthService', () => {
  const now = new Date('2026-07-11T08:00:00.000Z');
  let repository: MemoryAuthRepository;
  let service: AuthService;

  beforeEach(async () => {
    repository = new MemoryAuthRepository();
    repository.users.push({
      id: 'user-1', organizationId: 'org-1', name: 'Admin User',
      email: 'admin@example.com', passwordHash: await hashPassword('correct-password'),
      role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
    });
    service = new AuthService(repository, 28_800, () => now);
  });

  it('logs in case-insensitively and persists only the token hash with expiry', async () => {
    const result = await service.login(' ADMIN@EXAMPLE.COM ', 'correct-password');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.rawToken).toHaveLength(43);
    expect(repository.sessions[0]?.tokenHash).toBe(hashSessionToken(result.rawToken));
    expect(repository.sessions[0]?.expiresAt.toISOString()).toBe('2026-07-11T16:00:00.000Z');
  });

  it.each([
    ['missing@example.com', 'correct-password'],
    ['admin@example.com', 'wrong-password'],
  ])('returns the same error for invalid credentials', async (email, password) => {
    await expect(service.login(email, password)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS', statusCode: 401,
    });
  });

  it('rejects inactive users', async () => {
    repository.users[0]!.isActive = false;
    await expect(service.login('admin@example.com', 'correct-password')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS', statusCode: 401,
    });
  });

  it('rejects expired, revoked, and inactive-user sessions', async () => {
    const login = await service.login('admin@example.com', 'correct-password');
    repository.sessions[0]!.expiresAt = now;
    await expect(service.authenticateSession(login.rawToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    repository.sessions[0]!.expiresAt = new Date(now.getTime() + 1_000);
    repository.sessions[0]!.revokedAt = now;
    await expect(service.authenticateSession(login.rawToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    repository.sessions[0]!.revokedAt = null;
    repository.users[0]!.isActive = false;
    await expect(service.authenticateSession(login.rawToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('authenticates an active session without exposing secrets', async () => {
    const login = await service.login('admin@example.com', 'correct-password');
    const result = await service.authenticateSession(login.rawToken);
    expect(result.user.email).toBe('admin@example.com');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.tokenHash).toBe(hashSessionToken(login.rawToken));
    expect(result.sessionId).toBe('session-1');
  });

  it('logs out idempotently', async () => {
    const login = await service.login('admin@example.com', 'correct-password');
    await service.logout(login.rawToken);
    await service.logout(login.rawToken);
    expect(repository.sessions[0]?.revokedAt).toEqual(now);
  });

  it('changes the password, clears must-change flag, and revokes all sessions', async () => {
    const login = await service.login('admin@example.com', 'correct-password');
    await service.changePassword('user-1', 'correct-password', 'new-secure-password');
    await expect(service.authenticateSession(login.rawToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(service.login('admin@example.com', 'new-secure-password')).resolves.toBeDefined();
    expect(repository.users[0]?.mustChangePassword).toBe(false);
    expect(repository.users[0]?.version).toBe(2);
  });

  it('rejects password change when the current password is wrong', async () => {
    await expect(service.changePassword('user-1', 'wrong-password', 'new-secure-password'))
      .rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD', statusCode: 400 });
  });
});
