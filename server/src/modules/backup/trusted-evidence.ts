import {
  elapsedBootTime,
  elapsedTime,
  validateCurrentTimeEvidence,
  validateTimeEvidence,
  type CurrentTimeEvidence,
  type TimeEvidence,
} from '../../../../ops/scripts/trusted-time.mjs';

import type { BackupOrigin } from './types.js';

/** BR5 scheduled freshness is 26 hours inclusive (OPS-TT-004 §2.2). */
export const BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS = 26 * 60 * 60 * 1000;

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
  artifactGenerationTimeEvidence: TimeEvidence | null;
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
  if (elapsedTime(before, after).status !== 'KNOWN') return false;

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
 * Classifies a verified run's freshness from its generation `before`, the
 * verification `after`, and a current trusted sample. The generation start is
 * the healthy upper bound; either event's lower bound can prove staleness.
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
  if (Date.parse(proof.after.wallAtUTC) > Date.parse(now.wallAtUTC)) return 'unavailable';

  const healthy = elapsedTime(proof.before, now);
  if (healthy.status === 'KNOWN' && healthy.upperMs <= BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS) {
    return 'healthy';
  }

  const beforeStale = elapsedBootTime(proof.before, now);
  if (beforeStale.status === 'KNOWN' && beforeStale.lowerMs > BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS) {
    return 'stale';
  }
  const afterStale = elapsedBootTime(proof.after, now);
  if (afterStale.status === 'KNOWN' && afterStale.lowerMs > BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS) {
    return 'stale';
  }
  return 'unavailable';
}

/** Validates a persisted JSON value without inventing missing evidence. */
export function parseStoredVerificationProof(
  value: unknown,
  run: VerifiedRunEvidence,
): BackupVerificationProof | null {
  return validateVerificationProofBinding(value, run) ? value : null;
}

/** Used by writers to reject structurally invalid samples before persistence. */
export function validCurrentEvidence(value: unknown): CurrentTimeEvidence | null {
  try {
    return validateCurrentTimeEvidence(value);
  } catch {
    return null;
  }
}

/** Historical/format-1 evidence remains readable only as history. */
export function historicalTimeEvidence(value: unknown): TimeEvidence | null {
  try {
    return validateTimeEvidence(value);
  } catch {
    return null;
  }
}
