import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

/** Apply every current migration in filename order. */
export async function applyMigrations(pool: Pool): Promise<void> {
  const directory = fileURLToPath(
    new URL('../../src/db/migrations', import.meta.url),
  );
  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(`${directory}/${migration}`, 'utf8'));
  }
}

export type Interleave = {
  /**
   * 1-based index of the data statement that must run after {@link action}
   * committed. Transaction-control statements are not counted, so the pooled
   * and the snapshot paths number their reads identically.
   */
  beforeStatement: number;
  /** Commits an external change on a connection outside the report read. */
  action: () => Promise<void>;
};

export type InterleavingHarness = {
  pool: Pool;
  statements: string[];
  dataStatementCount: () => number;
};

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

/**
 * Wraps a real pool and drives every statement strictly one at a time, so a
 * committed change can be injected exactly between two statements of one
 * logical report read. The interleave is pinned to statement completion rather
 * than to a timer, which makes the evidence deterministic: no sleeps, no race
 * timing, and the same outcome on every run.
 */
export function interleavingPool(
  real: Pool,
  interleave: Interleave,
): InterleavingHarness {
  const statements: string[] = [];
  let dataStatements = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const issue = (
    text: string,
    values: unknown[] | undefined,
    run: () => Promise<unknown>,
  ) => {
    const invocation = tail.then(async () => {
      if (!TRANSACTION_CONTROL.test(text)) {
        dataStatements += 1;
        if (dataStatements === interleave.beforeStatement) {
          await interleave.action();
        }
      }
      statements.push(text);
      return run();
    });
    tail = invocation.catch(() => undefined);
    return invocation;
  };

  const pool = {
    query: (text: string, values?: unknown[]) =>
      issue(text, values, () => real.query(text, values as never[])),
    connect: async () => {
      const client = await real.connect();
      return {
        query: (text: string, values?: unknown[]) =>
          issue(text, values, () => client.query(text, values as never[])),
        release: () => client.release(),
      };
    },
  };

  return {
    pool: pool as unknown as Pool,
    statements,
    dataStatementCount: () => dataStatements,
  };
}

export type ReportOrganization = {
  organizationId: string;
  managerId: string;
  staffId: string;
  productId: string;
};

export async function seedReportOrganization(
  pool: Pool,
): Promise<ReportOrganization> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone)
     VALUES ($1, 'Europe/Istanbul')
     RETURNING id`,
    [randomUUID()],
  )).rows[0]!.id;

  const managerId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Snapshot Manager', $2, 'test-hash', 'MANAGER')
     RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`],
  )).rows[0]!.id;

  // A staff member who existed before the prior comparison range, so the
  // report always resolves a prior period as well.
  const staffId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, created_at)
     VALUES ($1, 'Ayse Personnel', $2, 'test-hash', 'STAFF', '2026-05-01T00:00:00.000Z')
     RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
  await pool.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title)
     VALUES ($1, $2, 'Field Staff')`,
    [organizationId, staffId],
  );

  const productId = (await pool.query<{ id: string }>(
    `INSERT INTO products (organization_id, sku, name, unit)
     VALUES ($1, $2, 'Implant Classic', 'adet')
     RETURNING id`,
    [organizationId, `SNP-${randomUUID().slice(0, 8)}`],
  )).rows[0]!.id;

  return { organizationId, managerId, staffId, productId };
}

export async function insertCustomer(
  pool: Pool,
  organizationId: string,
  name: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'prospect')
     RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
}

export type JobCardInsert = {
  organizationId: string;
  assignedTo: string;
  createdBy: string;
  title: string;
  type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';
  status?: string;
  startedAt?: string;
  staffCompletedAt?: string;
  staffCompletedBy?: string;
  managerApprovedAt?: string;
  managerApprovedBy?: string;
  scheduledAt?: string;
  engagementKind?: string;
};

/**
 * `job_cards_started_status_timestamp_check` requires a start timestamp for
 * every status that is past NEW, so a fixture that skips it would be rejected
 * by the schema instead of exercising the report.
 */
const STARTED_STATUSES = new Set([
  'IN_PROGRESS',
  'WAITING_APPROVAL',
  'REVISION_REQUESTED',
  'COMPLETED',
]);

const DEFAULT_STARTED_AT = '2026-07-01T07:00:00.000Z';

export async function insertJobCard(
  pool: Pool,
  input: JobCardInsert,
): Promise<string> {
  const status = input.status ?? 'NEW';
  const startedAt = input.startedAt ?? (STARTED_STATUSES.has(status)
    ? input.staffCompletedAt
      ? new Date(Date.parse(input.staffCompletedAt) - 60 * 60 * 1000)
        .toISOString()
      : DEFAULT_STARTED_AT
    : null);
  // `job_cards_engagement_kind_check` requires a sub-kind for meetings and
  // forbids it for every other job type.
  const engagementKind = input.engagementKind
    ?? (input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null);

  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title, assigned_to, created_by,
       scheduled_at, started_at, engagement_kind,
       staff_completed_at, staff_completed_by,
       manager_approved_at, manager_approved_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      input.organizationId,
      input.type,
      status,
      input.title,
      input.assignedTo,
      input.createdBy,
      input.scheduledAt ?? null,
      startedAt,
      engagementKind,
      input.staffCompletedAt ?? null,
      input.staffCompletedBy ?? null,
      input.managerApprovedAt ?? null,
      input.managerApprovedBy ?? null,
    ],
  )).rows[0]!.id;
}

export async function insertDeliveryItem(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    productId: string;
    deliveredAt: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_delivery_items (
       organization_id, job_card_id, product_id, delivery_purpose,
       delivered_at, quantity, unit, product_name_snapshot
     ) VALUES ($1, $2, $3, 'SALE', $4, 1, 'adet', 'Implant Classic')`,
    [input.organizationId, input.jobCardId, input.productId, input.deliveredAt],
  );
}
