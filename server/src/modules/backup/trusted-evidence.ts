import {
  elapsedBootTime,
  validateCurrentTimeEvidence,
  type CurrentTimeEvidence,
} from '../../../../ops/scripts/trusted-time.mjs';

import type { BackupOrigin } from './types.js';

import {
  BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS,
  TWO_CLOCK_LEAP_ALLOWANCE_MS,
  TWO_CLOCK_MAX_SLEW_RATE_PPM,
} from './freshness-policy.js';

export { BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS };

/** BR5 scheduled freshness is 26 hours inclusive (OPS-TT-004 §2.2). */

export type BackupVerificationProof = {
  proofVersion: 2;
  runId: string;
  artifactGenerationId: string;
  artifactSha256: string;
  sizeBytes: number;
  remoteAttemptId: string;
  origin: BackupOrigin;
  remoteKey: string;
  generationStartedAt: string;
  verificationAttemptStartedAt: string;
  verifiedAt: string;
  before: CurrentTimeEvidence;
  after: CurrentTimeEvidence;
};

/** The persisted run fields a proof must bind to. */
export type VerifiedRunEvidence = {
  id: string;
  origin: BackupOrigin;
  verifiedAt: Date | null;
  remoteKey: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  artifactGenerationId: string | null;
  artifactGenerationTimeEvidence: CurrentTimeEvidence | null;
  verificationTimeEvidence: BackupVerificationProof | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ORIGINS: readonly BackupOrigin[] = ['MANUAL', 'SCHEDULED', 'PRE_RESTORE'];
const PROOF_KEYS = [
  'proofVersion',
  'runId',
  'artifactGenerationId',
  'artifactSha256',
  'sizeBytes',
  'remoteAttemptId',
  'origin',
  'remoteKey',
  'generationStartedAt',
  'verificationAttemptStartedAt',
  'verifiedAt',
  'before',
  'after',
] as const;
const TIME_KEYS = [
  'formatVersion',
  'source',
  'bootId',
  'timeNamespaceId',
  'bootLowerMs',
  'bootUpperMs',
  'wallAtUTC',
  'wallResolutionMs',
] as const;
const SYNC_KEYS = [
  'service',
  'referenceAgeMs',
  'rootDistanceMs',
  'correctionMs',
  'sourceCount',
  'sourcePolicy',
  'configSha256',
  'configuredSourceCount',
  'authenticatedSourceCount',
  'selectableSources',
  'selectedSource',
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

/** Stored evidence is only trusted when it is a valid format-2 sample. */
export function parseTimeEvidence(value: unknown): CurrentTimeEvidence | null {
  try {
    return validateCurrentTimeEvidence(value);
  } catch {
    return null;
  }
}

function sameSync(
  left: CurrentTimeEvidence['synchronization'],
  right: CurrentTimeEvidence['synchronization'],
): boolean {
  return SYNC_KEYS.every((key) => {
    const a = left[key];
    const b = right[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b)
        && a.length === b.length
        && a.every((item, index) => item === b[index]);
    }
    return a === b;
  });
}

/** Structural comparison; JSONB does not preserve object key order. */
export function sameTimeEvidence(left: unknown, right: unknown): boolean {
  const a = parseTimeEvidence(left);
  const b = parseTimeEvidence(right);
  if (!a || !b) return false;
  return TIME_KEYS.every((key) => a[key] === b[key])
    && sameSync(a.synchronization, b.synchronization);
}

export type TwoClockElapsed =
  | { status: 'UNKNOWN' }
  | {
      status: 'KNOWN';
      bootLowerMs: number;
      bootUpperMs: number;
      utcLowerMs: number;
      utcUpperMs: number;
    };

/**
 * Chrony's documented absolute clock-error bound at one sample:
 * `|system time| + root dispersion + 0.5*root delay`, plus a bounded sampling
 * allowance derived from the sample's own collector window. `wallAtUTC` and the
 * chrony query are both read inside the `[bootLowerMs, bootUpperMs]` bracket.
 */
function sampleUtcErrorMs(evidence: CurrentTimeEvidence): number {
  const windowMs = Math.max(0, evidence.bootUpperMs - evidence.bootLowerMs);
  const samplingMs = windowMs
    + Math.ceil((windowMs * TWO_CLOCK_MAX_SLEW_RATE_PPM) / 1_000_000);
  return Math.abs(evidence.synchronization.correctionMs)
    + evidence.synchronization.rootDistanceMs
    + samplingMs;
}

/** True when the interval crosses a June/December leap-second boundary. */
function crossesLeapBoundary(eventWallAtUTC: string, currentWallAtUTC: string): boolean {
  const start = Date.parse(eventWallAtUTC);
  const end = Date.parse(currentWallAtUTC);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const firstYear = new Date(start).getUTCFullYear();
  const lastYear = new Date(end).getUTCFullYear();
  for (let year = firstYear; year <= lastYear; year += 1) {
    // Leap seconds are inserted/deleted at 23:59:60 UTC on 30 June or
    // 31 December; Date.UTC rolls second 60 into 00:00:00 of the next day/year.
    for (const boundary of [Date.UTC(year, 6, 1), Date.UTC(year + 1, 0, 1)]) {
      if (start < boundary && boundary <= end) return true;
    }
  }
  return false;
}

/**
 * BR5-only conservative elapsed-time evaluator. It does not compare the two
 * clocks' rates (the old `elapsedTime` coherence veto); it bounds each sample's
 * absolute UTC error independently and combines the boot and UTC upper bounds.
 * `elapsedTime` itself is unchanged for TT-A/TT-B.
 */
export function twoClockElapsed(event: unknown, current: unknown): TwoClockElapsed {
  const before = parseTimeEvidence(event);
  const after = parseTimeEvidence(current);
  if (!before || !after) return { status: 'UNKNOWN' };
  const boot = elapsedBootTime(before, after);
  if (boot.status !== 'KNOWN') return { status: 'UNKNOWN' };
  const wallDeltaMs = Date.parse(after.wallAtUTC) - Date.parse(before.wallAtUTC);
  if (!Number.isFinite(wallDeltaMs)) return { status: 'UNKNOWN' };
  const errorMs = sampleUtcErrorMs(before) + sampleUtcErrorMs(after);
  const leapMs = crossesLeapBoundary(before.wallAtUTC, after.wallAtUTC)
    ? TWO_CLOCK_LEAP_ALLOWANCE_MS
    : 0;
  return {
    status: 'KNOWN',
    bootLowerMs: boot.lowerMs,
    bootUpperMs: boot.upperMs,
    utcLowerMs: wallDeltaMs - errorMs - leapMs,
    utcUpperMs: wallDeltaMs + errorMs + leapMs,
  };
}

/**
 * Validates a proof against the run row it claims to prove. This is used both
 * when persisting a proof and when reading one; a proof with any mismatched
 * identity is never healthy.
 */
export function validateVerificationProofBinding(
  value: unknown,
  run: VerifiedRunEvidence,
): value is BackupVerificationProof {
  if (!exact(value, PROOF_KEYS)) return false;
  if (value.proofVersion !== 2) return false;
  if (typeof value.runId !== 'string' || !UUID.test(value.runId)) return false;
  if (typeof value.artifactGenerationId !== 'string' || !UUID.test(value.artifactGenerationId)) return false;
  if (typeof value.remoteAttemptId !== 'string' || !UUID.test(value.remoteAttemptId)) return false;
  if (typeof value.artifactSha256 !== 'string' || !SHA256.test(value.artifactSha256)) return false;
  const sizeBytes = value.sizeBytes;
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return false;
  if (typeof value.origin !== 'string' || !ORIGINS.includes(value.origin as BackupOrigin)) return false;
  if (typeof value.remoteKey !== 'string' || value.remoteKey.trim().length === 0 || value.remoteKey.length > 500) return false;
  if (!canonicalIso(value.generationStartedAt)) return false;
  if (!canonicalIso(value.verificationAttemptStartedAt)) return false;
  if (!canonicalIso(value.verifiedAt)) return false;

  const before = parseTimeEvidence(value.before);
  const after = parseTimeEvidence(value.after);
  if (!before || !after) return false;
  if (value.generationStartedAt !== before.wallAtUTC) return false;
  if (value.verifiedAt !== after.wallAtUTC) return false;
  // BR5 event ordering is boot-based, not rate-coherence-based. The verification
  // sample must start after the generation sample ends, and UTC must not run
  // backwards between them. A normal NTP frequency correction no longer rejects
  // a genuine proof; a rollback or an ambiguous overlap still fails closed.
  const bootOrder = elapsedBootTime(before, after);
  if (bootOrder.status !== 'KNOWN') return false;
  if (after.bootLowerMs < before.bootUpperMs) return false;
  const beforeWallMs = Date.parse(before.wallAtUTC);
  const afterWallMs = Date.parse(after.wallAtUTC);
  if (afterWallMs < beforeWallMs) return false;

  if (run.id !== value.runId) return false;
  if (run.origin !== value.origin) return false;
  if (run.artifactGenerationId !== value.artifactGenerationId) return false;
  if (run.sha256 !== value.artifactSha256) return false;
  if (run.sizeBytes !== sizeBytes) return false;
  if (run.remoteKey !== value.remoteKey) return false;
  if (!sameTimeEvidence(run.artifactGenerationTimeEvidence, value.before)) return false;
  if (run.verifiedAt !== null
    && run.verifiedAt.getTime() !== Date.parse(after.wallAtUTC)) return false;
  return true;
}

/**
 * Classifies a verified run's freshness from its generation `before` and a
 * current trusted sample. Healthy requires both independent upper bounds:
 * BOOTTIME and the chrony-bounded UTC interval. Either lower bound can prove
 * staleness. See TWO_CLOCK_SECURITY_DESIGN.md for the proof.
 */
export function evaluateArtifactFreshness(
  run: VerifiedRunEvidence,
  current: unknown,
): 'healthy' | 'stale' | 'unavailable' {
  const now = parseTimeEvidence(current);
  if (!now) return 'unavailable';
  const proof = run.verificationTimeEvidence;
  if (!proof) return 'unavailable';
  if (!validateVerificationProofBinding(proof, run)) return 'unavailable';
  // The current sample must not precede the verification: same boot/namespace,
  // the boot interval must reach the verification's end, and UTC must not run
  // backwards. Equality is allowed (the current sample may be the `after` one).
  if (elapsedBootTime(proof.after, now).status !== 'KNOWN') return 'unavailable';
  if (Date.parse(proof.after.wallAtUTC) > Date.parse(now.wallAtUTC)) return 'unavailable';

  const before = twoClockElapsed(proof.before, now);
  if (before.status === 'KNOWN'
    && before.bootUpperMs <= BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS
    && before.utcUpperMs <= BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS) {
    return 'healthy';
  }
  if (before.status === 'KNOWN'
    && (before.bootLowerMs > BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS
      || before.utcLowerMs > BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS)) {
    return 'stale';
  }

  const after = twoClockElapsed(proof.after, now);
  if (after.status === 'KNOWN'
    && (after.bootLowerMs > BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS
      || after.utcLowerMs > BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS)) {
    return 'stale';
  }
  return 'unavailable';
}
