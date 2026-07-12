import type { PoolClient } from 'pg';

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
