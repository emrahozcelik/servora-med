import type { Client, Pool, PoolClient, QueryResultRow } from 'pg';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../errors/index.js';
import type { DuplicateSource } from './duplicate-candidates.js';
import { DUPLICATE_LIMITS, type DuplicateCustomerFacts } from './duplicate-types.js';
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

export const duplicateUnavailable = () => new AppError('REVIEW_TEMPORARILY_UNAVAILABLE', 503, 'Karşılaştırma şu anda yüklenemiyor. Yeniden deneyin.');
export class DuplicateReadSnapshot {
  readonly asOf = new Date().toISOString();
  constructor(private client: PoolClient, private deadline: number, readonly checkpoint: () => void) {}
  private async query<T extends QueryResultRow>(sql: string, params: unknown[]) {
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
