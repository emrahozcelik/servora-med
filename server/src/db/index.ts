import { Pool } from 'pg';

import type { MigrationStore } from './migrate-runner.js';

type QueryResultLike = {
  rows: unknown[];
};

type MigrationClient = {
  query(sql: string, values?: unknown[]): Promise<QueryResultLike>;
  release(): void;
};

type MigrationPool = {
  query(sql: string, values?: unknown[]): Promise<QueryResultLike>;
  connect(): Promise<MigrationClient>;
};

export class PostgresMigrationStore implements MigrationStore {
  constructor(private readonly pool: MigrationPool) {}

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async getAppliedVersions() {
    const result = await this.pool.query('SELECT version FROM schema_migrations ORDER BY version');
    return result.rows.map((row) => (row as { version: string }).version);
  }

  async applyMigration(version: string, sql: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export type Database = {
  pool: Pool;
  migrations: PostgresMigrationStore;
};

export function createDatabase(databaseUrl: string): Database {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    pool,
    migrations: new PostgresMigrationStore(pool),
  };
}

export async function closeDatabase(database: Database) {
  await database.pool.end();
}

