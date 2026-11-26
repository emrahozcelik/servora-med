import { Pool } from 'pg';

import {
  operatorTablesExist,
  resetOperatorAccessAfterRestore,
} from '../../operator/restore-reset.js';

/**
 * Applies the MOD-002 restore reset (all operator sessions revoked, all
 * operator accounts deactivated) to a freshly restored target database, in one
 * transaction. A package older than migration 074 has no operator tables, so
 * there is nothing to reset.
 */
export async function resetOperatorAccessInRestoredDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (await operatorTablesExist(client)) {
        await resetOperatorAccessAfterRestore(client, new Date());
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
