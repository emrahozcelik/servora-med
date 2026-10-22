import type { Client, Pool, PoolClient, QueryResultRow } from 'pg';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../errors/index.js';
import type { CustomerPair, DuplicateSource } from './duplicate-candidates.js';
import { DUPLICATE_LIMITS, type DuplicateCustomerFacts } from './duplicate-types.js';
import { reviewHeadFromRow, type DuplicateReviewHead } from './duplicate-review.js';
import { mapContact, mapCustomer, type ContactRow, type CustomerRow } from './types.js';

export const DUPLICATE_SOURCE_SQL = `SELECT id,name,phone,status FROM customers
  WHERE organization_id=$1 AND data_class='BUSINESS' AND status IN ('prospect','active','inactive')
    AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM customers anchor
      WHERE anchor.organization_id=$1 AND anchor.id=$3 AND anchor.data_class='BUSINESS'))
  ORDER BY id LIMIT $2`;
export const DUPLICATE_FACTS_SQL = `SELECT id,name,customer_type,tax_number,phone,email,city,district,
  CASE WHEN octet_length(COALESCE(address,'')) <= $3 THEN address ELSE NULL END AS address,
  octet_length(COALESCE(address,'')) > $3 AS address_overflow,assigned_staff_user_id,status,version
  FROM customers WHERE organization_id=$1 AND data_class='BUSINESS' AND id=ANY($2::uuid[]) ORDER BY id`;
export const DUPLICATE_CONTACTS_SQL = `SELECT parent.customer_id,ct.* FROM unnest($2::uuid[]) AS parent(customer_id)
  CROSS JOIN LATERAL (SELECT id,name,title,phone,email,is_primary,is_active,version FROM contacts
    WHERE organization_id=$1 AND customer_id BETWEEN parent.customer_id AND parent.customer_id
    ORDER BY customer_id,id LIMIT $3) ct
  ORDER BY parent.customer_id,ct.id`;
// Bounded batch read: probe the canonical pair index once per wanted pair.
// A plain LEFT JOIN lets the planner choose an organization-wide review scan and
// sort (20k rows at the accepted dataset size) even when only 1-32 pairs are
// asked for. LATERAL keeps every probe on the unique pair/event indexes.
export const DUPLICATE_REVIEW_HEADS_SQL = `SELECT wanted.customer_a_id, wanted.customer_b_id,
  r.id, r.version, e.id AS event_id, e.seq, e.event_kind, e.resulting_status, e.reason_code,
  e.actor_user_id, e.occurred_at, e.evidence_schema_version, e.matching_rule_version,
  e.evidence_key_id, e.evidence_digest, e.matching_codes, e.conflicting_tax_numbers,
  previous_decision.id AS previous_decision_id, previous_decision.seq AS previous_decision_seq,
  previous_decision.resulting_status AS previous_decision_status,
  previous_decision.reason_code AS previous_decision_reason,
  previous_decision.actor_user_id AS previous_decision_actor_id,
  previous_decision.occurred_at AS previous_decision_at
FROM unnest($2::uuid[], $3::uuid[]) AS wanted(customer_a_id, customer_b_id)
LEFT JOIN LATERAL (
  SELECT r.id, r.version
  FROM customer_duplicate_reviews r
  WHERE r.organization_id=$1 AND r.customer_a_id=wanted.customer_a_id AND r.customer_b_id=wanted.customer_b_id
  LIMIT 1
) r ON true
LEFT JOIN LATERAL (
  SELECT e.id, e.seq, e.event_kind, e.resulting_status, e.reason_code, e.actor_user_id, e.occurred_at,
         e.evidence_schema_version, e.matching_rule_version, e.evidence_key_id, e.evidence_digest,
         e.matching_codes, e.conflicting_tax_numbers
  FROM customer_duplicate_review_events e
  WHERE e.organization_id=$1 AND e.review_id=r.id AND e.seq=r.version
  LIMIT 1
) e ON true
LEFT JOIN LATERAL (
  SELECT pd.id, pd.seq, pd.resulting_status, pd.reason_code, pd.actor_user_id, pd.occurred_at
  FROM customer_duplicate_review_events pd
  WHERE pd.organization_id=$1 AND pd.review_id=r.id
    AND pd.seq=r.version-1 AND pd.event_kind='DECISION_RECORDED'
    AND e.event_kind='REVIEW_REOPENED'
  LIMIT 1
) previous_decision ON true
ORDER BY wanted.customer_a_id, wanted.customer_b_id`;

export const DUPLICATE_REGISTER_HEADS_SQL = `SELECT r.customer_a_id, r.customer_b_id,
  r.id, r.version, e.id AS event_id, e.seq, e.event_kind, e.resulting_status, e.reason_code,
  e.actor_user_id, e.occurred_at, e.evidence_schema_version, e.matching_rule_version,
  e.evidence_key_id, e.evidence_digest, e.matching_codes, e.conflicting_tax_numbers,
  previous_decision.id AS previous_decision_id, previous_decision.seq AS previous_decision_seq,
  previous_decision.resulting_status AS previous_decision_status,
  previous_decision.reason_code AS previous_decision_reason,
  previous_decision.actor_user_id AS previous_decision_actor_id,
  previous_decision.occurred_at AS previous_decision_at
FROM customer_duplicate_reviews r
JOIN LATERAL (
  SELECT e.id, e.seq, e.event_kind, e.resulting_status, e.reason_code, e.actor_user_id, e.occurred_at,
         e.evidence_schema_version, e.matching_rule_version, e.evidence_key_id, e.evidence_digest,
         e.matching_codes, e.conflicting_tax_numbers
  FROM customer_duplicate_review_events e
  WHERE e.organization_id = r.organization_id AND e.review_id = r.id AND e.seq = r.version
) e ON true
LEFT JOIN LATERAL (
  SELECT pd.id, pd.seq, pd.resulting_status, pd.reason_code, pd.actor_user_id, pd.occurred_at
  FROM customer_duplicate_review_events pd
  WHERE pd.organization_id = r.organization_id AND pd.review_id = r.id
    AND pd.seq = r.version - 1 AND pd.event_kind = 'DECISION_RECORDED'
    AND e.event_kind = 'REVIEW_REOPENED'
  LIMIT 1
) previous_decision ON true
WHERE r.organization_id = $1
  AND ($2::uuid IS NULL OR (r.customer_a_id, r.customer_b_id) > ($2::uuid, $3::uuid))
ORDER BY r.customer_a_id, r.customer_b_id
LIMIT $4`;

export const duplicateUnavailable = () => new AppError('REVIEW_TEMPORARILY_UNAVAILABLE', 503, 'Karşılaştırma şu anda yüklenemiyor. Yeniden deneyin.');
export class DuplicateReadSnapshot {
  readonly asOf = new Date().toISOString();
  constructor(private client: PoolClient, private deadline: number, readonly checkpoint: () => void) {}
  async query<T extends QueryResultRow>(sql: string, params: unknown[]) {
    this.checkpoint();
    // Integer interpolation only: SET does not accept bind parameters.
    const timeout = Math.max(1, Math.floor(Math.min(DUPLICATE_LIMITS.statementMs, this.deadline - performance.now())));
    await this.client.query(`SET LOCAL statement_timeout = ${timeout}`);
    this.checkpoint();
    const result = await this.client.query<T>(sql, params);
    this.checkpoint();
    return result.rows;
  }
  source(org: string, anchor: string | null) {
    return this.query<DuplicateSource>(DUPLICATE_SOURCE_SQL, [org, DUPLICATE_LIMITS.sourceCustomers + 1, anchor]);
  }
  async reviewHeads(org: string, pairs: { customerAId: string; customerBId: string }[]): Promise<Map<string, DuplicateReviewHead>> {
    if (!pairs.length) return new Map();
    const a = pairs.map((pair) => pair.customerAId);
    const b = pairs.map((pair) => pair.customerBId);
    const rows = await this.query<Parameters<typeof reviewHeadFromRow>[0]>(DUPLICATE_REVIEW_HEADS_SQL, [org, a, b]);
    const heads = new Map<string, DuplicateReviewHead>();
    for (const row of rows) {
      if (!row.id) continue;
      if (!row.event_id) throw duplicateUnavailable();
      heads.set(`${row.customer_a_id}:${row.customer_b_id}`, reviewHeadFromRow(row));
    }
    return heads;
  }
  async registerHeads(org: string, after: { customerAId: string; customerBId: string } | null, limit: number): Promise<Array<{ pair: CustomerPair; head: DuplicateReviewHead }>> {
    const rows = await this.query<Parameters<typeof reviewHeadFromRow>[0]>(DUPLICATE_REGISTER_HEADS_SQL, [
      org, after?.customerAId ?? null, after?.customerBId ?? null, limit,
    ]);
    return rows.map((row) => {
      if (!row.event_id) throw duplicateUnavailable();
      return {
        pair: { customerAId: row.customer_a_id, customerBId: row.customer_b_id },
        head: reviewHeadFromRow(row),
      };
    });
  }
  async facts(org: string, ids: string[]): Promise<Map<string, DuplicateCustomerFacts>> {
    const rows = await this.query<CustomerRow & { address_overflow: boolean }>(DUPLICATE_FACTS_SQL, [org, ids, DUPLICATE_LIMITS.addressBytes]);
    const customers = new Map(rows.map((row) => {
      const { organizationId: _org, createdAt: _created, updatedAt: _updated, ...customer } = mapCustomer(row);
      return [row.id, { ...customer, contacts: [], addressOverflow: row.address_overflow }] as [string, DuplicateCustomerFacts];
    }));
    if (!customers.size) return customers;
    const contacts = await this.query<ContactRow>(DUPLICATE_CONTACTS_SQL, [org, [...customers.keys()], DUPLICATE_LIMITS.contacts + 1]);
    for (const row of contacts) {
      const { organizationId: _org, customerId, createdAt: _created, updatedAt: _updated, ...contact } = mapContact(row);
      customers.get(customerId)!.contacts.push(contact);
    }
    return customers;
  }
}

export class PostgresDuplicateReadRepository {
  constructor(private pool: Pool) {}
  async snapshot<T>(run: (snapshot: DuplicateReadSnapshot) => Promise<T>): Promise<T> {
    const deadline = performance.now() + DUPLICATE_LIMITS.requestMs;
    let expired = false;
    let client: PoolClient | undefined;
    // This is the sole release owner, including late acquisition and timeout.
    const release = (destroy: boolean) => {
      const owned = client;
      client = undefined;
      if (!owned) return;
      try { owned.release(destroy); }
      finally {
        // pg's idle Client.end() is graceful and can wait for a stopped peer.
        // This pool uses pg's default JS Client (PoolClient's interface omits
        // Client.connection). The pinned Client exposes this Duplex: close locally
        // after pool removal for BOTH active-query and between-query expiry.
        if (destroy) (owned as PoolClient & Pick<Client, 'connection'>).connection.stream.destroy();
      }
    };
    const checkpoint = () => {
      if (expired || performance.now() >= deadline) throw duplicateUnavailable();
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        // pg 8.22/pg-pool 3.14: release(true) removes the client synchronously;
        // Explicit transport destroy also covers idle clients. Do this
        // BEFORE settling HTTP; never return a busy connection to the pool.
        release(true);
        reject(duplicateUnavailable());
      }, DUPLICATE_LIMITS.requestMs);
    });
    const work = async () => {
      client = await this.pool.connect();
      checkpoint();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      checkpoint();
      const snapshot = new DuplicateReadSnapshot(client, deadline, checkpoint);
      const result = await run(snapshot);
      checkpoint();
      await client!.query('COMMIT');
      checkpoint();
      release(false);
      return result;
    };
    // Both branches have rejection handlers, including a late connect/query
    // failure after the deadline. No late continuation can issue another query.
    const operation = work().catch((error: unknown) => {
      // Closing the owned read-only transaction is the error cleanup. Waiting
      // for ROLLBACK on an unresponsive transport would defeat this deadline.
      release(true);
      if (error instanceof AppError) throw error;
      throw duplicateUnavailable();
    });
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer); }
  }
}
