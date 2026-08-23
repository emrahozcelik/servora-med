import { BACKUP_EXCLUSION_ADVISORY_LOCK_KEY } from '../types.js';

type AdvisoryClient = {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Array<{ locked?: boolean }> }>;
  release(): void;
};

type AdvisoryPool = { connect(): Promise<AdvisoryClient> };

export async function withTargetRestoreAdvisoryLock<T>(
  pool: AdvisoryPool,
  work: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [BACKUP_EXCLUSION_ADVISORY_LOCK_KEY],
    );
    acquired = result.rows[0]?.locked === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await work() };
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [BACKUP_EXCLUSION_ADVISORY_LOCK_KEY]);
    }
    client.release();
  }
}
