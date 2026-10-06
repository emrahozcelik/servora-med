import { AppError } from '../../errors/index.js';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
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
    // Fixed KDF budget (R1 reader-first): every attempt performs sequentially
    // exactly one OLD-cost and one V2-cost derivation, regardless of account
    // existence, credential profile, activity, or password correctness — so no
    // branch can reveal which case applied. R1 performs NO hash mutation:
    // the verified hash only binds the session CAS below.
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
    const session = await this.repository.createSessionIfCredentialCurrent({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(issuedAt.getTime() + this.sessionTtlSeconds * 1_000),
      expectedPasswordHash: work.verifiedHash,
    });
    if (!session) {
      throw INVALID_CREDENTIALS;
    }

    return { user: toSafeUser(user), rawToken };
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
