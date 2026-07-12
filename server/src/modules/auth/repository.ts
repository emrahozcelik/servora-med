import type { AuthUserRecord, SessionRecord } from './types.js';
import type { Pool, PoolClient } from 'pg';

export type SessionWithUser = {
  session: SessionRecord;
  user: AuthUserRecord;
};

export interface AuthRepository {
  findUserByEmail(normalizedEmail: string): Promise<AuthUserRecord | null>;
  findUserById(id: string): Promise<AuthUserRecord | null>;
  createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>): Promise<SessionRecord>;
  findSessionWithUser(tokenHash: string): Promise<SessionWithUser | null>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<void>;
  updatePasswordAndRevokeSessions(
    userId: string,
    expectedPasswordHash: string,
    passwordHash: string,
    revokedAt: Date,
  ): Promise<boolean>;
}

type UserRow = {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  password_hash: string;
  role: AuthUserRecord['role'];
  must_change_password: boolean;
  is_active: boolean;
  version: number;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
};

function mapUser(row: UserRow): AuthUserRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    mustChangePassword: row.must_change_password,
    isActive: row.is_active,
    version: row.version,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

const USER_COLUMNS = `
  id, organization_id, name, email, password_hash, role,
  must_change_password, is_active
  , version
`;

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async findUserByEmail(normalizedEmail: string) {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1 LIMIT 1`,
      [normalizedEmail],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async findUserById(id: string) {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, token_hash, expires_at, revoked_at`,
      [input.userId, input.tokenHash, input.expiresAt],
    );
    return mapSession(result.rows[0]!);
  }

  async findSessionWithUser(tokenHash: string) {
    const result = await this.pool.query<SessionRow & UserRow>(
      `SELECT
         s.id, s.user_id, s.token_hash, s.expires_at, s.revoked_at,
         u.id AS user_record_id, u.organization_id, u.name, u.email,
         u.password_hash, u.role, u.must_change_password, u.is_active, u.version
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: mapSession(row),
      user: mapUser({ ...row, id: (row as typeof row & { user_record_id: string }).user_record_id }),
    };
  }

  async revokeSession(tokenHash: string, revokedAt: Date) {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_hash = $1`,
      [tokenHash, revokedAt],
    );
  }

  async updatePasswordAndRevokeSessions(
    userId: string,
    expectedPasswordHash: string,
    passwordHash: string,
    revokedAt: Date,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await this.updatePassword(client, userId, expectedPasswordHash, passwordHash);
      if (updated) {
        await client.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1`,
          [userId, revokedAt],
        );
      }
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async updatePassword(
    client: PoolClient,
    userId: string,
    expectedPasswordHash: string,
    passwordHash: string,
  ) {
    const result = await client.query(
      `UPDATE users
       SET password_hash = $3, must_change_password = FALSE,
           version = version + 1, updated_at = NOW()
       WHERE id = $1 AND password_hash = $2`,
      [userId, expectedPasswordHash, passwordHash],
    );
    return result.rowCount === 1;
  }
}
