import type { Pool } from 'pg';

/**
 * 049 fixture baseline (test-only).
 *
 * Lifecycle business time is the millisecond-normalized PostgreSQL arbitration
 * clock sampled under the JobCard lock, so PostgreSQL-backed fixtures must
 * derive their temporal inputs from that same authoritative clock instead of
 * hard-coded calendar dates that age past product validation (future-date,
 * minimum-lead, working-day and conflict rules).
 *
 * Contract:
 * - Reads the DB clock; never changes it and never monkey-patches PostgreSQL.
 * - Never injects fake reserved_at into production repositories.
 * - Emits UTC ISO strings; independent of the local machine timezone.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The millisecond-normalized DB arbitration clock (the production time source). */
export async function readDbBaseline(pool: Pool): Promise<Date> {
  const result = await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  );
  return result.rows[0]!.now;
}

/** UTC ISO instant at `deltaMs` from the baseline. */
export function baselineIso(baseline: Date, deltaMs: number): string {
  return new Date(baseline.getTime() + deltaMs).toISOString();
}

/**
 * Floor the baseline onto a whole-minute grid (default: the follow-up
 * auto-scheduler's 15-minute grid). Grid-aligned fixture instants keep
 * generated slot expectations on the same grid the production scheduler uses.
 */
export function baselineAlignedToGrid(baseline: Date, gridMinutes = 15): Date {
  const gridMs = gridMinutes * MINUTE_MS;
  return new Date(Math.floor(baseline.getTime() / gridMs) * gridMs);
}

/** Read the business time of a specific job command; rejects ambiguous fixtures. */
export async function readReservedAt(pool: Pool, jobCardId: string, command: string, clientActionId?: string): Promise<Date> {
  const result = await pool.query<{ reserved_at: Date }>(
    `SELECT reserved_at FROM job_card_lifecycle_intents
      WHERE job_card_id=$1 AND command=$2 AND ($3::text IS NULL OR client_action_id=$3)`,
    [jobCardId, command, clientActionId ?? null],
  );
  if (result.rows.length !== 1) throw new Error(`Expected one ${command} reservation, found ${result.rows.length}`);
  return result.rows[0]!.reserved_at;
}
