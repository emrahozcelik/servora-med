import type { Pool } from 'pg';

/**
 * The minimal query surface shared by a pooled connection and a checked-out
 * client. Read models accept this so the same SQL can run either directly on
 * the pool (one statement per call) or inside a request-scoped transaction on
 * a single checked-out client (one MVCC snapshot for every call).
 */
export type SqlExecutor = Pick<Pool, 'query'>;

/**
 * Serializes the statements issued through one executor. Report compositions
 * legitimately fire reads concurrently (Promise.all), but a single connection
 * executes one statement at a time and node-postgres deprecated its implicit
 * busy-client queue — so a request-scoped snapshot drives them in order itself.
 */
export function serializeExecutor(executor: SqlExecutor): SqlExecutor {
  let tail: Promise<unknown> = Promise.resolve();
  const query = (queryText: string, values?: unknown[]) => {
    const invocation = tail.then(() => executor.query(queryText, values));
    tail = invocation.catch(() => undefined);
    return invocation;
  };
  return { query: query as unknown as Pool['query'] };
}
