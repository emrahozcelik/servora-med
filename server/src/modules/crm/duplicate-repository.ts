import type { Pool, PoolClient, QueryResultRow } from 'pg';
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
  constructor(private client: PoolClient, private deadline: number) {}
  checkpoint = () => { if (Date.now() >= this.deadline) throw duplicateUnavailable(); };
  private async query<T extends QueryResultRow>(sql: string, params: unknown[]) {
    this.checkpoint();
    // Integer interpolation only: SET does not accept bind parameters.
    const timeout = Math.max(1, Math.min(DUPLICATE_LIMITS.statementMs, this.deadline - Date.now()));
    await this.client.query(`SET LOCAL statement_timeout = ${timeout}`);
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
    const deadline = Date.now() + DUPLICATE_LIMITS.requestMs;
    let timedOut = false; let timer: NodeJS.Timeout | undefined;
    const acquisition = this.pool.connect().then((client) => {
      if (timedOut) { client.release(); throw duplicateUnavailable(); }
      return client;
    });
    let client: PoolClient;
    try {
      client = await Promise.race([acquisition, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(duplicateUnavailable()); }, DUPLICATE_LIMITS.requestMs);
      })]);
    } catch { throw duplicateUnavailable(); } finally { clearTimeout(timer); }
    let began = false; let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
      const snapshot = new DuplicateReadSnapshot(client, deadline);
      const result = await run(snapshot); snapshot.checkpoint();
      await client.query('COMMIT'); began = false;
      return result;
    } catch (error) {
      if (began) try { await client.query('ROLLBACK'); } catch { broken = true; }
      if (error instanceof AppError) throw error;
      throw duplicateUnavailable();
    } finally { client.release(broken); }
  }
}
