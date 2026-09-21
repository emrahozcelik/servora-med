/**
 * Canonical backup observation model and freshness rule (OPS-004 / OPS-BACKUP-OBS-1).
 *
 * This module is the single implementation of the accepted freshness rule. It is
 * deliberately dependency-free and side-effect-free so the future operator
 * alerting slice (`OPS-BACKUP-ALERT-1`) can consume exactly the same rule
 * instead of defining a second one.
 *
 * Nothing here reads the filesystem or the database: providers map their own
 * evidence into `BackupObservationState` and share this evaluator.
 *
 * The on-disk document is deliberately flat (one scalar per top-level key) so
 * the pure-bash writer can carry prior evidence forward without a JSON parser
 * and without adding a runtime dependency to the backup path.
 */

/**
 * Canonical local restore-point freshness threshold.
 *
 * 24h RPO plus a two-hour operational tolerance for the daily timer
 * (DECISIONS.md -> OPS-004 item 5). This is the ONLY definition of the
 * threshold; no other module may introduce a second one.
 */
export const BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS = 26 * 60 * 60 * 1000;

/** Trigger provenance. Never inferred: the call site states it explicitly. */
export const BACKUP_TRIGGER_CLASSES = ['scheduled', 'predeploy', 'postdeploy', 'manual'] as const;
export type BackupTriggerClass = (typeof BACKUP_TRIGGER_CLASSES)[number];

/** `running` means an attempt was observed but has not completed. */
export const BACKUP_ATTEMPT_RESULTS = ['running', 'success', 'failure'] as const;
export type BackupAttemptResult = (typeof BACKUP_ATTEMPT_RESULTS)[number];

/**
 * Stable, secret-safe failure vocabulary derived from the real failure stages of
 * `ops/scripts/backup-postgres.sh`.
 *
 * It is a closed set on BOTH sides of the contract: the writer refuses to
 * publish anything else, and the reader treats anything else as untrusted
 * evidence instead of echoing it back through the public health surface. That
 * keeps the vocabulary honest and makes arbitrary text — including a raw stderr
 * fragment or an uppercase-only database name — structurally unable to enter
 * the projection.
 *
 * `ops/scripts/backup-observation.sh` carries the same list; a parity test
 * asserts the two never drift.
 */
export const BACKUP_FAILURE_CLASSES = [
  'DUMP_FAILED',
  'CHECKSUM_FAILED',
  'ARTIFACT_FINALIZE_FAILED',
  'OFFSITE_COPY_FAILED',
  'OBSERVATION_WRITE_FAILED',
  'UNKNOWN',
] as const;

export type BackupFailureClass = (typeof BACKUP_FAILURE_CLASSES)[number];

/** Accepted public backup vocabulary (host-backup-observability.md §4). */
export type BackupProviderStatus = 'healthy' | 'stale' | 'failed' | 'unavailable' | 'disabled';

export type BackupObservationAttempt = {
  trigger: BackupTriggerClass;
  startedAt: string;
  completedAt: string | null;
  result: BackupAttemptResult;
  failureClass: BackupFailureClass | null;
};

export type BackupObservationSuccess = {
  trigger: BackupTriggerClass;
  verifiedAt: string;
};

/** Normalized view of `observation-v1.json`. */
export type BackupObservationState = {
  schemaVersion: 1;
  updatedAt: string;
  latestAttempt: BackupObservationAttempt | null;
  latestVerifiedSuccess: BackupObservationSuccess | null;
  latestScheduledAttempt: BackupObservationAttempt | null;
  latestScheduledVerifiedSuccess: BackupObservationSuccess | null;
};

export const BACKUP_OBSERVATION_SCHEMA_VERSION = 1;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TRIGGERS: readonly string[] = BACKUP_TRIGGER_CLASSES;
const RESULTS: readonly string[] = BACKUP_ATTEMPT_RESULTS;
const FAILURE_CLASSES: readonly string[] = BACKUP_FAILURE_CLASSES;

/**
 * Strict ISO-8601 UTC instant parser. Returns epoch milliseconds or `null`.
 *
 * Stricter than `Date.parse` alone: the shape is pinned to the exact form the
 * writer emits, and the value must survive an epoch round-trip. That rejects
 * calendar-impossible instants such as `2026-02-30T00:00:00Z`, which
 * `Date.parse` silently normalizes to March 2 and which the shell writer
 * rejects — both sides must agree on what a trustworthy instant is.
 */
export function parseObservationInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 19) + 'Z' !== value) return null;
  return ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads an optional JSON null as `null`, an ISO instant as its string form. */
function readOptionalInstant(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  return parseObservationInstant(value) === null ? { ok: false } : { ok: true, value: value as string };
}

function readTrigger(value: unknown): BackupTriggerClass | null {
  return typeof value === 'string' && (TRIGGERS as readonly string[]).includes(value)
    ? (value as BackupTriggerClass)
    : null;
}

function readAttempt(input: {
  trigger: unknown;
  startedAt: unknown;
  completedAt: unknown;
  result: unknown;
  failureClass: unknown;
}): BackupObservationAttempt | null {
  const result = typeof input.result === 'string' && (RESULTS as readonly string[]).includes(input.result)
    ? (input.result as BackupAttemptResult)
    : null;
  if (result === null) return null;
  const trigger = readTrigger(input.trigger);
  if (trigger === null) return null;
  if (parseObservationInstant(input.startedAt) === null) return null;

  const completed = readOptionalInstant(input.completedAt);
  if (!completed.ok) return null;
  // A running attempt has no completion instant; a completed one must have it.
  if (result === 'running' && completed.value !== null) return null;
  if (result !== 'running' && completed.value === null) return null;

  const rawFailure = input.failureClass === null || input.failureClass === undefined
    ? null
    : input.failureClass;
  if (rawFailure !== null && (typeof rawFailure !== 'string' || !FAILURE_CLASSES.includes(rawFailure))) {
    return null;
  }
  // A failure class is only meaningful on a completed failure.
  if (result === 'failure' && rawFailure === null) return null;
  if (result !== 'failure' && rawFailure !== null) return null;

  return {
    trigger,
    startedAt: input.startedAt as string,
    completedAt: completed.value,
    result,
    failureClass: rawFailure as BackupFailureClass | null,
  };
}

/**
 * Fail-closed parser for the canonical flat `observation-v1.json`.
 *
 * Returns `null` for a malformed document, an unsupported `schemaVersion`, a
 * missing or invalid instant, an unknown trigger/result/failure class, and any
 * impossible combination (for example a completed attempt without a completion
 * instant, or a verified instant without its trigger). Callers must treat
 * `null` as `unavailable`.
 *
 * Unknown *extra* keys are ignored so an additive writer change can never brick
 * the health surface.
 */
export function parseBackupObservationState(value: unknown): BackupObservationState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== BACKUP_OBSERVATION_SCHEMA_VERSION) return null;
  if (parseObservationInstant(value.updatedAt) === null) return null;

  const attemptPresent = value.latestAttemptResult !== null && value.latestAttemptResult !== undefined;
  const latestAttempt = attemptPresent
    ? readAttempt({
      trigger: value.latestAttemptTrigger,
      startedAt: value.latestAttemptStartedAt,
      completedAt: value.latestAttemptCompletedAt,
      result: value.latestAttemptResult,
      failureClass: value.latestAttemptFailureClass,
    })
    : null;
  if (attemptPresent && latestAttempt === null) return null;
  if (!attemptPresent) {
    // Partial attempt evidence is not a valid document.
    for (const key of [
      'latestAttemptTrigger', 'latestAttemptStartedAt',
      'latestAttemptCompletedAt', 'latestAttemptFailureClass',
    ]) {
      if (value[key] !== null && value[key] !== undefined) return null;
    }
  }

  const verified = readOptionalInstant(value.latestVerifiedAt);
  if (!verified.ok) return null;
  const verifiedTrigger = value.latestVerifiedTrigger === null || value.latestVerifiedTrigger === undefined
    ? null
    : readTrigger(value.latestVerifiedTrigger);
  if (verifiedTrigger === null && value.latestVerifiedTrigger !== null
    && value.latestVerifiedTrigger !== undefined) {
    return null;
  }
  // An instant without its trigger (or the reverse) is not a trustworthy pair.
  if ((verified.value === null) !== (verifiedTrigger === null)) return null;

  const scheduledAttemptPresent = value.latestScheduledAttemptResult !== null
    && value.latestScheduledAttemptResult !== undefined;
  const latestScheduledAttempt = scheduledAttemptPresent
    ? readAttempt({
      trigger: 'scheduled',
      startedAt: value.latestScheduledAttemptStartedAt,
      completedAt: value.latestScheduledAttemptCompletedAt,
      result: value.latestScheduledAttemptResult,
      failureClass: value.latestScheduledAttemptFailureClass,
    })
    : null;
  if (scheduledAttemptPresent && latestScheduledAttempt === null) return null;
  if (!scheduledAttemptPresent) {
    for (const key of [
      'latestScheduledAttemptStartedAt', 'latestScheduledAttemptCompletedAt',
      'latestScheduledAttemptFailureClass',
    ]) {
      if (value[key] !== null && value[key] !== undefined) return null;
    }
  }

  const scheduledVerified = readOptionalInstant(value.latestScheduledVerifiedAt);
  if (!scheduledVerified.ok) return null;
  // The schedule heartbeat baseline is only ever produced by the scheduled
  // trigger, so it cannot exist without a scheduled attempt.
  if (scheduledVerified.value !== null && latestScheduledAttempt === null) return null;

  return {
    schemaVersion: BACKUP_OBSERVATION_SCHEMA_VERSION,
    updatedAt: value.updatedAt as string,
    latestAttempt,
    latestVerifiedSuccess: verified.value === null
      ? null
      : { trigger: verifiedTrigger as BackupTriggerClass, verifiedAt: verified.value },
    latestScheduledAttempt,
    latestScheduledVerifiedSuccess: scheduledVerified.value === null
      ? null
      : { trigger: 'scheduled', verifiedAt: scheduledVerified.value },
  };
}

/**
 * Schedule heartbeat (host-backup-observability.md §5).
 *
 * `null` means the scheduled baseline is not established yet: no natural timer
 * slot has been accepted, so there is nothing to compare against and the
 * heartbeat must not be reported as broken.
 *
 * `false` means the daily timer contract is violated. Deploy/manual backups
 * cannot satisfy it, which is what stops a busy deploy from hiding a broken
 * timer.
 */
export function evaluateScheduledHeartbeat(
  state: BackupObservationState,
  nowMs: number,
): boolean | null {
  const attempt = state.latestScheduledAttempt;
  if (attempt === null) return null;
  if (attempt.result !== 'success') return false;
  const verified = state.latestScheduledVerifiedSuccess;
  if (verified === null) return false;
  const verifiedMs = parseObservationInstant(verified.verifiedAt);
  if (verifiedMs === null || verifiedMs > nowMs) return false;
  return nowMs - verifiedMs <= BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS;
}

/**
 * Canonical provider status.
 *
 * Precedence (first match wins) is deliberate: an untrustworthy observation can
 * never be reported as healthy, a failed attempt dominates a still-recent prior
 * success, and a broken scheduled contract is not hidden by a fresh
 * predeploy/postdeploy/manual artifact.
 */
export function evaluateBackupProviderStatus(
  state: BackupObservationState | null,
  nowMs: number,
): BackupProviderStatus {
  // Missing, unreadable, malformed or unsupported evidence: never trusted.
  if (state === null) return 'unavailable';

  const verified = state.latestVerifiedSuccess;
  if (verified === null) {
    // A failure with no prior success is still a failure; otherwise the provider
    // has simply never been observed (which is NOT `disabled`).
    return state.latestAttempt?.result === 'failure' ? 'failed' : 'unavailable';
  }

  const verifiedMs = parseObservationInstant(verified.verifiedAt);
  // A future timestamp invalidates the whole observation.
  if (verifiedMs === null || verifiedMs > nowMs) return 'unavailable';

  // Latest relevant attempt failed: the prior success timestamp stays visible,
  // but the projection must not read healthy.
  if (state.latestAttempt?.result === 'failure') return 'failed';

  // Scheduled contract dimension: once the baseline exists, a deploy-created
  // artifact must not mask a broken daily timer.
  const heartbeat = evaluateScheduledHeartbeat(state, nowMs);
  if (heartbeat === false) {
    if (state.latestScheduledAttempt?.result !== 'success') return 'failed';
    // The timer ran but stopped producing fresh verified artifacts.
    return 'stale';
  }

  const ageMs = nowMs - verifiedMs;
  return ageMs <= BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS ? 'healthy' : 'stale';
}

/**
 * Compatibility aggregate for the pre-existing `status: 'ok' | 'unavailable'`
 * field. `ok` is only ever reported for the fully healthy provider state, so
 * every richer state degrades to the conservative value existing consumers
 * already handle.
 */
export function toCompatibilityStatus(providerStatus: BackupProviderStatus): 'ok' | 'unavailable' {
  return providerStatus === 'healthy' ? 'ok' : 'unavailable';
}

/** Maps an observation attempt result into the existing run-status vocabulary. */
export function toRunStatusVocabulary(result: BackupAttemptResult | null): string | null {
  if (result === null) return null;
  if (result === 'success') return 'SUCCESS';
  if (result === 'failure') return 'FAILED';
  return 'RUNNING';
}
