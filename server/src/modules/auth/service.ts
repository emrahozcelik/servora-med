import { AppError } from '../../errors/index.js';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
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
    if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
      throw INVALID_CREDENTIALS;
    }

    const { rawToken, tokenHash } = createSessionToken();
    const issuedAt = this.now();
    await this.repository.createSession({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(issuedAt.getTime() + this.sessionTtlSeconds * 1_000),
    });

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

    return { user: toSafeUser(result.user), tokenHash };
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
