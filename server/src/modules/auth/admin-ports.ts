import type { PoolClient } from 'pg';

import { hashPassword, validatePassword } from './crypto.js';

export interface CredentialAdministrationPort {
  validatePassword(password: string): void;
  hashPassword(password: string): Promise<string>;
  resetTemporaryPassword(
    client: PoolClient,
    userId: string,
    expectedVersion: number,
    password: string,
  ): Promise<number | null>;
}

export interface SessionRevocationPort {
  revokeAllSessions(client: PoolClient, userId: string, revokedAt: Date): Promise<void>;
}

export class AuthCredentialAdministration implements CredentialAdministrationPort {
  validatePassword(password: string) {
    validatePassword(password);
  }

  hashPassword(password: string) {
    return hashPassword(password);
  }

  async resetTemporaryPassword(
    client: PoolClient,
    userId: string,
    expectedVersion: number,
    password: string,
  ) {
    validatePassword(password);
    const passwordHash = await hashPassword(password);
    const result = await client.query<{ version: number }>(
      `UPDATE users
       SET password_hash = $3, must_change_password = TRUE,
           version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2
       RETURNING version`,
      [userId, expectedVersion, passwordHash],
    );
    return result.rows[0]?.version ?? null;
  }
}

export class PostgresSessionRevocationPort implements SessionRevocationPort {
  async revokeAllSessions(client: PoolClient, userId: string, revokedAt: Date) {
    await client.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1`,
      [userId, revokedAt],
    );
  }
}
