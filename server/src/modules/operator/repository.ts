import type { Pool, PoolClient } from 'pg';

import {
  MODULE_STATE_COLUMNS,
  mapModuleStateRow,
  type ModuleStateDbRow,
  type ModuleStateRow,
} from '../installation-modules/state.js';
import type { InstallationModuleKey } from '../installation-modules/registry.js';
import type {
  OperatorAccountRecord,
  OperatorCapability,
  OperatorListEntry,
} from './types.js';

type AccountRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_active: boolean;
  version: number;
};

const ACCOUNT_COLUMNS = 'id, email, name, password_hash, is_active, version';
const REQUIRED_CAPABILITY: OperatorCapability = 'MODULE_MANAGEMENT';
const UNIQUE_VIOLATION = '23505';

export type StoredOperatorSession = {
  sessionId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  account: OperatorAccountRecord;
};

export type UpdateModuleInput = {
  operatorId: string;
  sessionTokenHash: string;
  key: InstallationModuleKey;
  enabled: boolean;
  expectedVersion: number;
  now: Date;
};

export type UpdateModuleResult =
  | { kind: 'OK'; row: ModuleStateRow; changed: boolean }
  | { kind: 'UNAUTHENTICATED' }
  | { kind: 'FORBIDDEN' }
  | { kind: 'STATE_MISSING' }
  | { kind: 'VERSION_CONFLICT' };

export type GrantOperatorResult =
  | { kind: 'CREATED' | 'REACTIVATED'; operatorId: string }
  | { kind: 'ALREADY_ACTIVE' };

export type ResetPasswordResult =
  | { kind: 'OK'; revokedSessions: number }
  | { kind: 'NOT_FOUND' }
  | { kind: 'INACTIVE' };

export type RevokeOperatorResult =
  | { kind: 'OK'; revokedSessions: number }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_INACTIVE' };

type AuditInput = {
  actorKind: 'OPERATOR' | 'HOST_CLI' | 'SYSTEM';
  operatorId?: string | null;
  eventType: string;
  targetOperatorId?: string | null;
  moduleKey?: string | null;
  oldValue?: object | null;
  newValue?: object | null;
  occurredAt: Date;
};

async function insertAudit(client: PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO operator_audit_events
       (actor_kind, operator_id, event_type, target_operator_id, module_key,
        old_value, new_value, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      input.actorKind,
      input.operatorId ?? null,
      input.eventType,
      input.targetOperatorId ?? null,
      input.moduleKey ?? null,
      input.oldValue ? JSON.stringify(input.oldValue) : null,
      input.newValue ? JSON.stringify(input.newValue) : null,
      input.occurredAt,
    ],
  );
}

async function loadCapabilities(
  queryable: Pick<Pool, 'query'>,
  operatorId: string,
): Promise<OperatorCapability[]> {
  const result = await queryable.query<{ capability: OperatorCapability }>(
    `SELECT capability FROM operator_account_capabilities
      WHERE operator_id = $1 ORDER BY capability`,
    [operatorId],
  );
  return result.rows.map((row) => row.capability);
}

async function mapAccount(
  queryable: Pick<Pool, 'query'>,
  row: AccountRow,
): Promise<OperatorAccountRecord> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    version: row.version,
    capabilities: await loadCapabilities(queryable, row.id),
  };
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function revokeAllSessions(
  client: PoolClient,
  operatorId: string,
  now: Date,
): Promise<number> {
  const result = await client.query(
    `UPDATE operator_sessions SET revoked_at = $2
      WHERE operator_id = $1 AND revoked_at IS NULL`,
    [operatorId, now],
  );
  return result.rowCount ?? 0;
}

export class PostgresOperatorRepository {
  constructor(private readonly pool: Pool) {}

  async findAccountByEmail(normalizedEmail: string): Promise<OperatorAccountRecord | null> {
    const result = await this.pool.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM operator_accounts WHERE email = $1`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    return row ? mapAccount(this.pool, row) : null;
  }

  /**
   * Successful-login transaction: lock the account, re-check the exact
   * verified hash and `is_active`, then write the session and the
   * `OPERATOR_LOGIN_SUCCEEDED` event together. Returns null when the account
   * changed after the (slow) KDF verification.
   */
  async createLoginSession(input: {
    operatorId: string;
    expectedPasswordHash: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<OperatorAccountRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM operator_accounts WHERE id = $1 FOR UPDATE`,
        [input.operatorId],
      );
      const row = locked.rows[0];
      if (!row || !row.is_active || row.password_hash !== input.expectedPasswordHash) {
        return null;
      }
      await client.query(
        `INSERT INTO operator_sessions (operator_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [row.id, input.tokenHash, input.now, input.expiresAt],
      );
      await insertAudit(client, {
        actorKind: 'OPERATOR',
        operatorId: row.id,
        eventType: 'OPERATOR_LOGIN_SUCCEEDED',
        targetOperatorId: row.id,
        occurredAt: input.now,
      });
      return mapAccount(client, row);
    });
  }

  async findSession(tokenHash: string): Promise<StoredOperatorSession | null> {
    const result = await this.pool.query<AccountRow & {
      session_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              a.id, a.email, a.name, a.password_hash, a.is_active, a.version
         FROM operator_sessions s
         JOIN operator_accounts a ON a.id = s.operator_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      account: await mapAccount(this.pool, row),
    };
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE operator_sessions SET revoked_at = $2
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash, now],
    );
  }

  /**
   * Module-state mutation (contract §6). Lock order everywhere: operator
   * account, then session, then module-state row. Session, account activity
   * and the capability are re-validated inside the transaction under the
   * account lock, so a revocation that committed before the lock cannot be
   * outrun.
   */
  async updateModuleEnabled(input: UpdateModuleInput): Promise<UpdateModuleResult> {
    return withTransaction(this.pool, async (client): Promise<UpdateModuleResult> => {
      const account = await client.query<{ is_active: boolean }>(
        'SELECT is_active FROM operator_accounts WHERE id = $1 FOR UPDATE',
        [input.operatorId],
      );
      const session = await client.query<{ expires_at: Date; revoked_at: Date | null }>(
        `SELECT expires_at, revoked_at FROM operator_sessions
          WHERE token_hash = $1 AND operator_id = $2 FOR SHARE`,
        [input.sessionTokenHash, input.operatorId],
      );
      const sessionRow = session.rows[0];
      if (
        !account.rows[0]?.is_active
        || !sessionRow
        || sessionRow.revoked_at !== null
        || sessionRow.expires_at <= input.now
      ) {
        return { kind: 'UNAUTHENTICATED' };
      }
      const capabilities = await loadCapabilities(client, input.operatorId);
      if (!capabilities.includes(REQUIRED_CAPABILITY)) return { kind: 'FORBIDDEN' };

      const state = await client.query<ModuleStateDbRow>(
        `SELECT ${MODULE_STATE_COLUMNS} FROM installation_module_state
          WHERE module_key = $1 FOR UPDATE`,
        [input.key],
      );
      const current = state.rows[0];
      if (!current) return { kind: 'STATE_MISSING' };
      if (current.version !== input.expectedVersion) return { kind: 'VERSION_CONFLICT' };
      if (current.enabled === input.enabled) {
        return { kind: 'OK', row: mapModuleStateRow(current), changed: false };
      }

      const updated = await client.query<ModuleStateDbRow>(
        `UPDATE installation_module_state
            SET enabled = $2, version = version + 1, source = 'OPERATOR',
                updated_at = $3, updated_by_operator_id = $4
          WHERE module_key = $1
          RETURNING ${MODULE_STATE_COLUMNS}`,
        [input.key, input.enabled, input.now, input.operatorId],
      );
      const next = updated.rows[0]!;
      await insertAudit(client, {
        actorKind: 'OPERATOR',
        operatorId: input.operatorId,
        eventType: 'MODULE_STATE_CHANGED',
        moduleKey: input.key,
        oldValue: { enabled: current.enabled, version: current.version },
        newValue: { enabled: next.enabled, version: next.version },
        occurredAt: input.now,
      });
      return { kind: 'OK', row: mapModuleStateRow(next), changed: true };
    });
  }

  // ---- Host CLI administration ------------------------------------------------

  async grantOperator(input: {
    email: string;
    name: string;
    passwordHash: string;
    now: Date;
  }): Promise<GrantOperatorResult> {
    try {
      return await withTransaction(this.pool, async (client): Promise<GrantOperatorResult> => {
        const existing = await client.query<AccountRow>(
          `SELECT ${ACCOUNT_COLUMNS} FROM operator_accounts WHERE email = $1 FOR UPDATE`,
          [input.email],
        );
        const row = existing.rows[0];
        if (row?.is_active) return { kind: 'ALREADY_ACTIVE' };

        let operatorId: string;
        let kind: 'CREATED' | 'REACTIVATED';
        if (row) {
          operatorId = row.id;
          kind = 'REACTIVATED';
          await client.query(
            `UPDATE operator_accounts
                SET name = $2, password_hash = $3, is_active = TRUE,
                    version = version + 1, updated_at = $4
              WHERE id = $1`,
            [operatorId, input.name, input.passwordHash, input.now],
          );
          await revokeAllSessions(client, operatorId, input.now);
        } else {
          kind = 'CREATED';
          const created = await client.query<{ id: string }>(
            `INSERT INTO operator_accounts (email, name, password_hash, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4) RETURNING id`,
            [input.email, input.name, input.passwordHash, input.now],
          );
          operatorId = created.rows[0]!.id;
        }
        await client.query(
          `INSERT INTO operator_account_capabilities (operator_id, capability)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [operatorId, REQUIRED_CAPABILITY],
        );
        await insertAudit(client, {
          actorKind: 'HOST_CLI',
          eventType: 'OPERATOR_GRANTED',
          targetOperatorId: operatorId,
          oldValue: row ? { isActive: false } : null,
          newValue: { isActive: true },
          occurredAt: input.now,
        });
        return { kind, operatorId };
      });
    } catch (error) {
      // Concurrent grant for the same new email: the unique index decides.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return { kind: 'ALREADY_ACTIVE' };
      }
      throw error;
    }
  }

  async resetPassword(input: {
    email: string;
    passwordHash: string;
    now: Date;
  }): Promise<ResetPasswordResult> {
    return withTransaction(this.pool, async (client): Promise<ResetPasswordResult> => {
      const existing = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM operator_accounts WHERE email = $1 FOR UPDATE`,
        [input.email],
      );
      const row = existing.rows[0];
      if (!row) return { kind: 'NOT_FOUND' };
      if (!row.is_active) return { kind: 'INACTIVE' };
      await client.query(
        `UPDATE operator_accounts
            SET password_hash = $2, version = version + 1, updated_at = $3
          WHERE id = $1`,
        [row.id, input.passwordHash, input.now],
      );
      const revokedSessions = await revokeAllSessions(client, row.id, input.now);
      await insertAudit(client, {
        actorKind: 'HOST_CLI',
        eventType: 'OPERATOR_PASSWORD_RESET',
        targetOperatorId: row.id,
        newValue: { revokedSessions },
        occurredAt: input.now,
      });
      return { kind: 'OK', revokedSessions };
    });
  }

  async revokeOperator(input: { email: string; now: Date }): Promise<RevokeOperatorResult> {
    return withTransaction(this.pool, async (client): Promise<RevokeOperatorResult> => {
      const existing = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM operator_accounts WHERE email = $1 FOR UPDATE`,
        [input.email],
      );
      const row = existing.rows[0];
      if (!row) return { kind: 'NOT_FOUND' };
      if (!row.is_active) return { kind: 'ALREADY_INACTIVE' };
      await client.query(
        `UPDATE operator_accounts
            SET is_active = FALSE, version = version + 1, updated_at = $2
          WHERE id = $1`,
        [row.id, input.now],
      );
      const revokedSessions = await revokeAllSessions(client, row.id, input.now);
      await insertAudit(client, {
        actorKind: 'HOST_CLI',
        eventType: 'OPERATOR_REVOKED',
        targetOperatorId: row.id,
        oldValue: { isActive: true },
        newValue: { isActive: false, revokedSessions },
        occurredAt: input.now,
      });
      return { kind: 'OK', revokedSessions };
    });
  }

  async listOperators(): Promise<OperatorListEntry[]> {
    const result = await this.pool.query<{
      email: string;
      name: string;
      is_active: boolean;
      capabilities: OperatorCapability[];
      last_login_at: Date | null;
    }>(
      `SELECT a.email, a.name, a.is_active,
              COALESCE(
                (SELECT array_agg(c.capability ORDER BY c.capability)
                   FROM operator_account_capabilities c WHERE c.operator_id = a.id),
                '{}') AS capabilities,
              (SELECT MAX(e.occurred_at) FROM operator_audit_events e
                WHERE e.target_operator_id = a.id
                  AND e.event_type = 'OPERATOR_LOGIN_SUCCEEDED') AS last_login_at
         FROM operator_accounts a
        ORDER BY a.email`,
    );
    return result.rows.map((row) => ({
      email: row.email,
      name: row.name,
      isActive: row.is_active,
      capabilities: row.capabilities,
      lastLoginAt: row.last_login_at,
    }));
  }
}
