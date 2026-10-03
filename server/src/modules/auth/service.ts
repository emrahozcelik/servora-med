import { AppError } from '../../errors/index.js';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  parsePasswordHash,
  passwordHashNeedsUpgrade,
  performLoginPasswordWork,
  validateNewPassword,
  verifyPassword,
} from './crypto.js';
import type { AuthRepository } from './repository.js';
import type { AuthUserRecord, SafeUser } from './types.js';

const INVALID_CREDENTIALS = new AppError(
  'INVALID_CREDENTIALS',
  401,
  'E-posta veya parola hatalı.',
);
const UNAUTHENTICATED = new AppError(
  'UNAUTHENTICATED',
  401,
  'Oturum geçersiz veya süresi dolmuş.',
);

function toSafeUser(user: AuthUserRecord): SafeUser {
  return {
    id: user.id,
    organizationId: user.organizationId,
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    isActive: user.isActive,
    version: user.version,
  };
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly sessionTtlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.repository.findUserByEmail(normalizedEmail);
    // Fixed KDF budget: every attempt performs sequentially exactly one
    // OLD-class and one CURRENT-class derivation, regardless of account
    // existence, credential profile, activity, or password correctness.
    const work = await performLoginPasswordWork(password, user?.passwordHash ?? null);
    if (
      !user ||
      !user.isActive ||
      work.credentialClass === 'UNSUPPORTED' ||
      !work.matches ||
      !work.verifiedHash
    ) {
      throw INVALID_CREDENTIALS;
    }

    const { rawToken, tokenHash } = createSessionToken();
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.sessionTtlSeconds * 1_000);
    let session = await this.repository.createSessionIfCredentialCurrent({
      userId: user.id,
      tokenHash,
      expiresAt,
      expectedPasswordHash: work.verifiedHash,
    });
    // The record serialized as the authenticated user. Normally the login-time
    // row; the Option-2 path below may rebind it to the refetched row so the
    // response never carries stale flags (e.g. must_change_password set by a
    // concurrent admin reset to the same password).
    let authenticatedUser = user;
    // The hash the issued session is bound to. Normally the verified hash;
    // the Option-2 path below may rebind it after re-verification.
    let sessionHash = work.verifiedHash;
    if (!session && work.credentialClass === 'OLD') {
      // Bounded Option-2 recovery (single attempt): the initial CAS failed
      // after a successfully verified OLD credential, so another login may
      // have transparently upgraded it. Re-verify the SAME supplied password
      // against the CURRENT stored hash — never assume hash-changed == rehash.
      const current = await this.repository.findUserById(user.id);
      const currentHash = current?.passwordHash ?? null;
      if (
        current &&
        current.isActive &&
        currentHash &&
        currentHash !== work.verifiedHash &&
        parsePasswordHash(currentHash) &&
        (await verifyPassword(password, currentHash))
      ) {
        session = await this.repository.createSessionIfCredentialCurrent({
          userId: user.id,
          tokenHash,
          expiresAt,
          expectedPasswordHash: currentHash,
        });
        if (session) {
          sessionHash = currentHash;
          authenticatedUser = current;
        }
      }
    }
    if (!session) {
      throw INVALID_CREDENTIALS;
    }

    // Transparent upgrade only after a durable session, reusing the
    // precomputed candidate (no third normal-path KDF). The candidate was
    // derived from the supplied password, which verified against sessionHash,
    // so it represents the same secret in the current representation.
    if (
      work.upgradeCandidateHash &&
      passwordHashNeedsUpgrade(sessionHash)
    ) {
      await this.bestEffortPasswordHashUpgrade(user.id, sessionHash, work.upgradeCandidateHash);
    }

    return { user: toSafeUser(authenticatedUser), rawToken };
  }

  /**
   * Best-effort transparent KDF maintenance. Runs only after a session was
   * durably created; CAS conflict (lost race) and operational errors never
   * fail the already-successful login. Operational errors emit a structured
   * warning without credential material.
   */
  private async bestEffortPasswordHashUpgrade(
    userId: string,
    expectedPasswordHash: string,
    replacementPasswordHash: string,
  ): Promise<void> {
    try {
      await this.repository.upgradePasswordHashIfCurrent(
        userId,
        expectedPasswordHash,
        replacementPasswordHash,
      );
    } catch (error) {
      console.warn('Transparent password-hash upgrade failed', {
        userId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  async authenticateSession(rawToken: string) {
    const tokenHash = hashSessionToken(rawToken);
    const result = await this.repository.findSessionWithUser(tokenHash);
    if (
      !result ||
      result.session.revokedAt !== null ||
      result.session.expiresAt <= this.now() ||
      !result.user.isActive
    ) {
      throw UNAUTHENTICATED;
    }

    return { user: toSafeUser(result.user), tokenHash, sessionId: result.session.id };
  }

  async logout(rawToken: string): Promise<void> {
    await this.repository.revokeSession(hashSessionToken(rawToken), this.now());
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.repository.findUserById(userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AppError(
        'INVALID_CURRENT_PASSWORD',
        400,
        'Mevcut parola hatalı.',
      );
    }

    // New-password policy applies ONLY to the replacement credential: the
    // current password is verified as-is so historical passwords keep working.
    validateNewPassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const changed = await this.repository.updatePasswordAndRevokeSessions(
      user.id,
      user.passwordHash,
      passwordHash,
      this.now(),
    );
    if (!changed) {
      throw new AppError(
        'PASSWORD_CHANGE_CONFLICT',
        409,
        'Parola başka bir işlem tarafından değiştirildi. Yeniden giriş yapın.',
      );
    }
  }
}
