import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { PostgresMigrationStore } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate-runner.js';

/**
 * 049 test-only harness. Reads the millisecond-normalized DB arbitration
 * clock, builds minimal fixtures, and observes real lock/blocked state.
 * Never changes the production clock and never injects fake reserved_at.
 */

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

export async function withIntentSchema(
  databaseUrl: string | undefined,
  run: (pool: Pool, schema: string) => Promise<void>,
): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `lcproof_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool, schema);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

export async function insertProofOrg(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  )).rows[0]!.id;
}

export async function insertProofUser(
  pool: Pool,
  organizationId: string,
  role: 'MANAGER' | 'STAFF',
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, `proof-${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

export async function insertProofJob(pool: Pool, organizationId: string, userId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
     VALUES ($1, 'GENERAL_TASK', 'Proof job', $2, $2) RETURNING id`,
    [organizationId, userId],
  )).rows[0]!.id;
}

/** Millisecond-normalized DB arbitration clock (the production time source). */
export async function readDbClock(pool: Pool): Promise<Date> {
  const result = await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  );
  return result.rows[0]!.now;
}

/** Bounded condition poll. Throws explicitly on timeout: never a blind sleep. */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for condition: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export type StatementGate = {
  pool: Pool;
  arrived: Promise<void>;
  arrivalCount: () => number;
  release: () => void;
};

/**
 * Proxy-gate around a pool: the first client query whose text contains
 * `marker` notifies `arrived` and blocks until `release()`. The source
 * pool is never mutated. Callers must always release (use try/finally).
 */
export function gatePoolStatements(source: Pool, marker: string): StatementGate {
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let arrivalResolve: (() => void) | null = null;
  const arrived = new Promise<void>((resolve) => {
    arrivalResolve = resolve;
  });
  let count = 0;
  const passthrough = (target: PoolClient, args: unknown[]): unknown =>
    Reflect.apply(
      target.query as unknown as (...callArgs: unknown[]) => unknown,
      target,
      args,
    );
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property, receiver) {
        if (property === 'query') {
          return (...args: unknown[]) => {
            const first = args[0];
            const text = typeof first === 'string'
              ? first
              : (first as { text?: unknown } | null)?.text;
            if (typeof text === 'string' && text.includes(marker)) {
              count += 1;
              arrivalResolve?.();
              return (async () => {
                await gate;
                return passthrough(target, args);
              })();
            }
            return passthrough(target, args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...callArgs: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as PoolClient;
  const originalConnect = source.connect.bind(source);
  const proxy = new Proxy(source, {
    get(target, property, receiver) {
      if (property === 'connect') {
        return async () => wrapClient(await originalConnect());
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...callArgs: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Pool;
  return {
    pool: proxy,
    arrived,
    arrivalCount: () => count,
    release: () => releaseGate?.(),
  };
}
