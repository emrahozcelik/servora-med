import { AppError } from '../../errors/index.js';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  performLoginPasswordWork,
  validateNewPassword,
} from '../auth/crypto.js';
import {
  findInstallationModule,
  INSTALLATION_MODULES,
  type InstallationModuleKey,
} from '../installation-modules/registry.js';
import type { ModuleStateLogger, ModuleStateReader, ModuleStateRow } from '../installation-modules/state.js';
import type { PostgresOperatorRepository } from './repository.js';
import {
  OPERATOR_SESSION_TTL_SECONDS,
  toOperatorPublic,
  type OperatorListEntry,
  type OperatorModuleView,
  type OperatorPublic,
  type OperatorSessionContext,
} from './types.js';

const INVALID_CREDENTIALS = new AppError(
  'INVALID_CREDENTIALS',
  401,
  'E-posta veya parola hatalı.',
);
const UNAUTHENTICATED = () => new AppError(
  'OPERATOR_UNAUTHENTICATED',
  401,
  'Oturum geçersiz veya süresi dolmuş.',
);
const FORBIDDEN = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const MODULE_STATE_UNAVAILABLE = () => new AppError(
  'MODULE_STATE_UNAVAILABLE',
  503,
  'Modül durumu şu anda okunamıyor.',
);

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function toModuleView(row: ModuleStateRow): OperatorModuleView {
  const descriptor = findInstallationModule(row.key)!;
  return {
    key: row.key,
    label: descriptor.label,
    enabled: row.enabled,
    version: row.version,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class OperatorService {
  constructor(
    private readonly repository: PostgresOperatorRepository,
    private readonly moduleState: ModuleStateReader,
    private readonly now: () => Date = () => new Date(),
    private readonly sessionTtlSeconds: number = OPERATOR_SESSION_TTL_SECONDS,
  ) {}

  /**
   * Unknown email, inactive account and wrong password all perform the same
   * fixed KDF work and fail with the same 401 (contract §3).
   */
  async login(email: string, password: string): Promise<{
    operator: OperatorPublic;
    rawToken: string;
    expiresAt: Date;
  }> {
    const account = await this.repository.findAccountByEmail(email.trim().toLowerCase());
    const work = await performLoginPasswordWork(password, account?.passwordHash ?? null);
    if (
      !account
      || !account.isActive
      || work.credentialClass === 'UNSUPPORTED'
      || !work.matches
      || !work.verifiedHash
    ) {
      throw INVALID_CREDENTIALS;
    }

    const { rawToken, tokenHash } = createSessionToken();
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.sessionTtlSeconds * 1_000);
    const loggedIn = await this.repository.createLoginSession({
      operatorId: account.id,
      expectedPasswordHash: work.verifiedHash,
      tokenHash,
      expiresAt,
      now: issuedAt,
    });
    if (!loggedIn) throw INVALID_CREDENTIALS;
    return { operator: toOperatorPublic(loggedIn), rawToken, expiresAt };
  }

  async authenticate(rawToken: string): Promise<OperatorSessionContext> {
    const tokenHash = hashSessionToken(rawToken);
    const stored = await this.repository.findSession(tokenHash);
    if (
      !stored
      || stored.revokedAt !== null
      || stored.expiresAt <= this.now()
      || !stored.account.isActive
    ) {
      throw UNAUTHENTICATED();
    }
    return {
      operator: toOperatorPublic(stored.account),
      tokenHash,
      sessionId: stored.sessionId,
    };
  }

  async logout(rawToken: string): Promise<void> {
    await this.repository.revokeSession(hashSessionToken(rawToken), this.now());
  }

  requireModuleManagement(session: OperatorSessionContext): void {
    if (!session.operator.capabilities.includes('MODULE_MANAGEMENT')) throw FORBIDDEN();
  }

  async listModules(logger: ModuleStateLogger = console): Promise<OperatorModuleView[]> {
    const views: OperatorModuleView[] = [];
    for (const module of INSTALLATION_MODULES) {
      views.push(toModuleView(await this.readModule(module.key, logger)));
    }
    return views;
  }

  async setModuleEnabled(
    session: OperatorSessionContext,
    key: InstallationModuleKey,
    enabled: boolean,
    expectedVersion: number,
  ): Promise<OperatorModuleView> {
    const result = await this.repository.updateModuleEnabled({
      operatorId: session.operator.id,
      sessionTokenHash: session.tokenHash,
      key,
      enabled,
      expectedVersion,
      now: this.now(),
    });
    switch (result.kind) {
      case 'OK': return toModuleView(result.row);
      case 'UNAUTHENTICATED': throw UNAUTHENTICATED();
      case 'FORBIDDEN': throw FORBIDDEN();
      case 'STATE_MISSING': throw MODULE_STATE_UNAVAILABLE();
      case 'VERSION_CONFLICT':
        throw new AppError(
          'MODULE_VERSION_CONFLICT',
          409,
          'Modül durumu başka bir işlemle değiştirildi. Sayfayı yenileyip tekrar deneyin.',
        );
    }
  }

  private async readModule(
    key: InstallationModuleKey,
    logger: ModuleStateLogger,
  ): Promise<ModuleStateRow> {
    let row: ModuleStateRow | null;
    try {
      row = await this.moduleState.read(key);
    } catch (error) {
      logger.error({ err: error, module: key }, 'Installation module state read failed');
      throw MODULE_STATE_UNAVAILABLE();
    }
    if (!row) throw MODULE_STATE_UNAVAILABLE();
    return row;
  }

  // ---- Host CLI administration (contract §4) ---------------------------------

  async grantOperator(input: { email: string; name: string; password: string }) {
    const { email, name } = this.validateIdentity(input.email, input.name);
    validateNewPassword(input.password);
    const result = await this.repository.grantOperator({
      email,
      name,
      passwordHash: await hashPassword(input.password),
      now: this.now(),
    });
    if (result.kind === 'ALREADY_ACTIVE') {
      throw new AppError('OPERATOR_ALREADY_ACTIVE', 409, 'Bu e-posta için etkin bir operatör hesabı zaten var.');
    }
    return { email, reactivated: result.kind === 'REACTIVATED' };
  }

  async resetPassword(input: { email: string; password: string }) {
    const email = input.email.trim().toLowerCase();
    validateNewPassword(input.password);
    const result = await this.repository.resetPassword({
      email,
      passwordHash: await hashPassword(input.password),
      now: this.now(),
    });
    if (result.kind === 'NOT_FOUND') throw this.operatorNotFound();
    if (result.kind === 'INACTIVE') {
      throw new AppError(
        'OPERATOR_INACTIVE',
        409,
        'Operatör hesabı etkin değil; yeniden yetkilendirmek için grant kullanın.',
      );
    }
    return { email, revokedSessions: result.revokedSessions };
  }

  async revokeOperator(input: { email: string }) {
    const email = input.email.trim().toLowerCase();
    const result = await this.repository.revokeOperator({ email, now: this.now() });
    if (result.kind === 'NOT_FOUND') throw this.operatorNotFound();
    return {
      email,
      alreadyInactive: result.kind === 'ALREADY_INACTIVE',
      revokedSessions: result.kind === 'OK' ? result.revokedSessions : 0,
    };
  }

  listOperators(): Promise<OperatorListEntry[]> {
    return this.repository.listOperators();
  }

  private validateIdentity(email: string, name: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    if (!normalizedName || !validEmail(normalizedEmail)) {
      throw new AppError('VALIDATION_ERROR', 400, 'Operatör bilgileri geçersiz.');
    }
    return { email: normalizedEmail, name: normalizedName };
  }

  private operatorNotFound() {
    return new AppError('OPERATOR_NOT_FOUND', 404, 'Operatör hesabı bulunamadı.');
  }
}
