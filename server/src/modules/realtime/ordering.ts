import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Organization-scoped realtime commit-ordering boundary.
 *
 * realtime_events.id is a GLOBAL identity sequence allocated at INSERT time,
 * but cursor replay filters per organization with `id > cursor`. Without a
 * shared boundary, a transaction can allocate a lower id, stay uncommitted,
 * and commit after a higher id from another transaction — permanently hiding
 * the lower id from any client that already advanced its cursor.
 *
 * Acquiring this transaction-scoped advisory lock immediately BEFORE the
 * realtime INSERT (on the same connection/transaction) serializes id
 * allocation with commit visibility for one organization: the next same-org
 * INSERT blocks until the holder commits or rolls back, so same-org commit
 * order matches id order. Different organizations use different keys and
 * never block each other. Rolled-back ids simply leave gaps, which the
 * `id > cursor` contract already tolerates.
 *
 * Every durable realtime producer MUST call this on its write transaction
 * before inserting into realtime_events. See PostgresRealtimeEventTransaction
 * (job-cards) which was the only producer doing so before B3.
 */
export async function acquireRealtimeOrderingLock(
  client: Queryable,
  organizationId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(1, hashtext($1::text))',
    [organizationId],
  );
}
