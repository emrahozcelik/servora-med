import type { Pool } from 'pg';

import { serializeExecutor } from '../../db/executor.js';
import type {
  ApprovalQueueItemPort,
  ReportReaders,
  ReportReadSnapshot,
} from './ports.js';
import { createReportsReadModel } from './repository.js';

/**
 * Runs a report composition on one checked-out connection inside a read-only
 * REPEATABLE READ transaction. PostgreSQL fixes the MVCC snapshot at the first
 * statement of the transaction, so every read the callback performs — including
 * the cross-module approval-item read — observes the same committed state and a
 * response can never mix aggregates from different points in time.
 */
export class PostgresReportReadSnapshot implements ReportReadSnapshot {
  constructor(
    private readonly pool: Pool,
    private readonly approvalItems: ApprovalQueueItemPort,
  ) {}

  async run<T>(work: (readers: ReportReaders) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const executor = serializeExecutor(client);
      const result = await work({
        reports: createReportsReadModel(executor),
        approvalItems: this.approvalItems.bindTo(executor),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
