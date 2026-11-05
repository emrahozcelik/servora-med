import { describe, expect, it } from 'vitest';

import {
  evaluateArtifactFreshness,
  sameTimeEvidence,
  validateVerificationProofBinding,
  type BackupVerificationProof,
  type VerifiedRunEvidence,
} from '../src/modules/backup/trusted-evidence.js';
import { timeAt, legacyTimeAt } from './backup-time-fixture.js';

const T0 = Date.parse('2026-11-04T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOTE_ATTEMPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHA = 'd'.repeat(64);

function proof(overrides: Partial<BackupVerificationProof> = {}): BackupVerificationProof {
  const before = timeAt(T0);
  const after = timeAt(T0 + HOUR);
  return {
    proofVersion: 2,
    runId: RUN_ID,
    artifactGenerationId: GENERATION_ID,
    artifactSha256: SHA,
    sizeBytes: 1024,
    remoteAttemptId: REMOTE_ATTEMPT_ID,
    origin: 'SCHEDULED',
    remoteKey: `production/instance/v1/scheduled/${RUN_ID}.sbk.age`,
    generationStartedAt: before.wallAtUTC,
    verificationAttemptStartedAt: new Date(T0 + 30 * 60 * 1000).toISOString(),
    verifiedAt: after.wallAtUTC,
    before,
    after,
    ...overrides,
  };
}

function run(overrides: Partial<VerifiedRunEvidence> = {}): VerifiedRunEvidence {
  const p = proof();
  return {
    id: RUN_ID,
    origin: 'SCHEDULED',
    verifiedAt: new Date(p.verifiedAt),
    remoteKey: p.remoteKey,
    sizeBytes: p.sizeBytes,
    sha256: p.artifactSha256,
    artifactGenerationId: GENERATION_ID,
    artifactGenerationTimeEvidence: p.before,
    verificationTimeEvidence: p,
    ...overrides,
  };
}

describe('BR5 verification proof binding', () => {
  it('accepts the exact run/generation/artifact/attempt binding', () => {
    expect(validateVerificationProofBinding(proof(), run())).toBe(true);
  });

  it('rejects a cross-run proof', () => {
    expect(validateVerificationProofBinding(proof({ runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), run())).toBe(false);
  });

  it('rejects a cross-generation proof', () => {
    expect(validateVerificationProofBinding(proof({
      artifactGenerationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }), run())).toBe(false);
  });

  it('rejects wrong origin, sha, size, remote key, or before', () => {
    expect(validateVerificationProofBinding(proof({ origin: 'MANUAL' }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({ artifactSha256: 'f'.repeat(64) }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({ sizeBytes: 2048 }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({ remoteKey: 'other/key' }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({ before: timeAt(T0 + 1000) }), run())).toBe(false);
  });

  it('rejects malformed, legacy, cross-boot, and unknown-field proofs', () => {
    expect(validateVerificationProofBinding({ ...proof(), proofVersion: 1 }, run())).toBe(false);
    expect(validateVerificationProofBinding({ ...proof(), extra: true } as BackupVerificationProof, run())).toBe(false);
    expect(validateVerificationProofBinding(proof({
      before: legacyTimeAt(T0) as BackupVerificationProof['before'],
    }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({
      before: timeAt(T0, { bootId: '11111111-1111-4111-8111-111111111112' }),
    }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({
      generationStartedAt: new Date(T0 + 1).toISOString(),
    }), run())).toBe(false);
    expect(validateVerificationProofBinding(proof({
      verifiedAt: new Date(T0 + HOUR + 1).toISOString(),
    }), run())).toBe(false);
  });

  it('rejects a proof when the generation before is missing', () => {
    expect(validateVerificationProofBinding(proof(), run({
      artifactGenerationTimeEvidence: null,
    }))).toBe(false);
  });

  it('rejects a proof with a non-canonical ISO attempt timestamp', () => {
    expect(validateVerificationProofBinding(proof({
      verificationAttemptStartedAt: '2026-11-04T09:30:00Z',
    }), run())).toBe(false);
  });
});

describe('BR5 artifact freshness classification', () => {
  it('is healthy at exactly 26 hours inclusive', () => {
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + 26 * HOUR))).toBe('healthy');
  });

  it('is stale at 26 hours + 1 ms', () => {
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + 26 * HOUR + 1))).toBe('stale');
  });

  it('is healthy at 20 hours after a same-generation re-encryption', () => {
    // Same generation/before; the ciphertext hash changed after re-encryption.
    const reencrypted = run({
      sha256: 'e'.repeat(64),
      verifiedAt: new Date(T0 + 20 * HOUR),
      verificationTimeEvidence: proof({
        artifactSha256: 'e'.repeat(64),
        after: timeAt(T0 + 20 * HOUR),
        verifiedAt: new Date(T0 + 20 * HOUR).toISOString(),
      }),
    });
    expect(evaluateArtifactFreshness(reencrypted, timeAt(T0 + 20 * HOUR))).toBe('healthy');
  });

  it('is stale at 27 hours even after a 20-hour re-encryption', () => {
    const reencrypted = run({
      sha256: 'e'.repeat(64),
      verifiedAt: new Date(T0 + 20 * HOUR),
      verificationTimeEvidence: proof({
        artifactSha256: 'e'.repeat(64),
        after: timeAt(T0 + 20 * HOUR),
        verifiedAt: new Date(T0 + 20 * HOUR).toISOString(),
      }),
    });
    expect(evaluateArtifactFreshness(reencrypted, timeAt(T0 + 27 * HOUR))).toBe('stale');
  });

  it('is stale at 27 hours, including a 2-hour UTC rollback', () => {
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + 27 * HOUR))).toBe('stale');
    // Boot time remains at 27h; only the wall clock rolled back to 25h.
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + 27 * HOUR, {
      wallAtUTC: new Date(T0 + 25 * HOUR).toISOString(),
    }))).toBe('stale');
  });

  it('is unavailable across a boot or namespace change', () => {
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + HOUR, {
      bootId: '11111111-1111-4111-8111-111111111113',
    }))).toBe('unavailable');
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + HOUR, {
      timeNamespaceId: 'time:[4026531999]',
    }))).toBe('unavailable');
  });

  it('is unavailable for a future after timestamp', () => {
    expect(evaluateArtifactFreshness(run(), timeAt(T0 + 30 * 60 * 1000))).toBe('unavailable');
  });

  it('is unavailable when the proof is missing or the original before is lost', () => {
    expect(evaluateArtifactFreshness(run({ verificationTimeEvidence: null }), timeAt(T0 + HOUR))).toBe('unavailable');
    expect(evaluateArtifactFreshness(run({ artifactGenerationTimeEvidence: null }), timeAt(T0 + HOUR))).toBe('unavailable');
  });

  it('is unavailable for a proof from another run or generation', () => {
    expect(evaluateArtifactFreshness(run({
      verificationTimeEvidence: proof({ runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
    }), timeAt(T0 + HOUR))).toBe('unavailable');
    expect(evaluateArtifactFreshness(run({
      verificationTimeEvidence: proof({ artifactGenerationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
    }), timeAt(T0 + HOUR))).toBe('unavailable');
  });

  it('does not bridge an ambiguous elapsed interval', () => {
    const current = timeAt(T0 + 26 * HOUR);
    expect(evaluateArtifactFreshness(run(), { ...current, bootUpperMs: current.bootUpperMs + 1 }))
      .toBe('unavailable');
  });
});

describe('sameTimeEvidence', () => {
  it('compares structurally, not by JSON key order', () => {
    const left = timeAt(T0);
    const right = { ...timeAt(T0) } as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(right).reverse());
    expect(sameTimeEvidence(left, reordered)).toBe(true);
    expect(sameTimeEvidence(left, timeAt(T0 + 1))).toBe(false);
    expect(sameTimeEvidence(left, null)).toBe(false);
  });
});
