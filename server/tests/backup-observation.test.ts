/**
 * OPS-BACKUP-OBS-1 — host backup observation contract (server side).
 *
 * Deterministic and self-contained: no database, no production access, every
 * fixture built in a temporary directory. It covers the accepted contract:
 *
 *   A. observation schema parsing is fail-closed
 *   B. the canonical shell writer and the TypeScript reader agree
 *   C. the single canonical 26-hour freshness rule
 *   D. trigger semantics and the independent schedule heartbeat
 *   E. disabled vs unavailable vs never-observed are distinct
 *   F. the public health contract changed only additively
 *   G. writer and reader share exactly one vocabulary
 */

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  BACKUP_ATTEMPT_RESULTS,
  BACKUP_FAILURE_CLASSES,
  BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS,
  BACKUP_OBSERVATION_SCHEMA_VERSION,
  BACKUP_TRIGGER_CLASSES,
  evaluateBackupProviderStatus,
  evaluateScheduledHeartbeat,
  parseBackupObservationState,
  parseObservationInstant,
  type BackupFailureClass,
  type BackupObservationState,
  type BackupTriggerClass,
} from '../src/modules/health/backup-freshness.js';
import {
  createDisabledBackupHealth,
  createHostBackupObservationHealth,
} from '../src/modules/health/host-backup-observation.js';

const WRITER = fileURLToPath(new URL('../../ops/scripts/backup-observation.sh', import.meta.url));
const TEST_RELEASE_SHA = '6325e44bf774d2cb0de2c4cd27ba93443b57d4c0';
const HOUR = 60 * 60 * 1000;
const MAX_AGE_MS = BACKUP_LOCAL_FRESHNESS_MAX_AGE_MS;

/** Fixed clock: every freshness assertion is relative to this instant. */
const NOW = Date.parse('2026-09-21T12:00:00Z');

/** Second-precision UTC instant, the only form the contract accepts. */
function instant(offsetMs: number): string {
  return `${new Date(NOW + offsetMs).toISOString().slice(0, 19)}Z`;
}

type Doc = Record<string, unknown>;

/** A valid document with no observed attempt at all. */
function emptyDocument(updatedAt: string): Doc {
  return {
    schemaVersion: BACKUP_OBSERVATION_SCHEMA_VERSION,
    updatedAt,
    latestAttemptTrigger: null,
    latestAttemptStartedAt: null,
    latestAttemptCompletedAt: null,
    latestAttemptResult: null,
    latestAttemptFailureClass: null,
    latestVerifiedAt: null,
    latestVerifiedTrigger: null,
    latestScheduledAttemptStartedAt: null,
    latestScheduledAttemptCompletedAt: null,
    latestScheduledAttemptResult: null,
    latestScheduledAttemptFailureClass: null,
    latestScheduledVerifiedAt: null,
  };
}

/**
 * Overlays a completed success attempt, exactly as the writer does: a verified
 * success becomes the authoritative local restore point for every trigger class,
 * while only the scheduled class advances the schedule-heartbeat group.
 */
function withSuccess(doc: Doc, trigger: BackupTriggerClass, at: string): Doc {
  const next: Doc = {
    ...doc,
    updatedAt: at,
    latestAttemptTrigger: trigger,
    latestAttemptStartedAt: at,
    latestAttemptCompletedAt: at,
    latestAttemptResult: 'success',
    latestAttemptFailureClass: null,
    latestVerifiedAt: at,
    latestVerifiedTrigger: trigger,
  };
  if (trigger === 'scheduled') {
    next.latestScheduledAttemptStartedAt = at;
    next.latestScheduledAttemptCompletedAt = at;
    next.latestScheduledAttemptResult = 'success';
    next.latestScheduledAttemptFailureClass = null;
    next.latestScheduledVerifiedAt = at;
  }
  return next;
}

function withFailure(
  doc: Doc,
  trigger: BackupTriggerClass,
  startedAt: string,
  completedAt: string,
  failureClass: BackupFailureClass,
): Doc {
  const next: Doc = {
    ...doc,
    updatedAt: completedAt,
    latestAttemptTrigger: trigger,
    latestAttemptStartedAt: startedAt,
    latestAttemptCompletedAt: completedAt,
    latestAttemptResult: 'failure',
    latestAttemptFailureClass: failureClass,
  };
  if (trigger === 'scheduled') {
    next.latestScheduledAttemptStartedAt = startedAt;
    next.latestScheduledAttemptCompletedAt = completedAt;
    next.latestScheduledAttemptResult = 'failure';
    next.latestScheduledAttemptFailureClass = failureClass;
  }
  return next;
}

function withRunning(doc: Doc, trigger: BackupTriggerClass, startedAt: string): Doc {
  const next: Doc = {
    ...doc,
    updatedAt: startedAt,
    latestAttemptTrigger: trigger,
    latestAttemptStartedAt: startedAt,
    latestAttemptCompletedAt: null,
    latestAttemptResult: 'running',
    latestAttemptFailureClass: null,
  };
  if (trigger === 'scheduled') {
    next.latestScheduledAttemptStartedAt = startedAt;
    next.latestScheduledAttemptCompletedAt = null;
    next.latestScheduledAttemptResult = 'running';
    next.latestScheduledAttemptFailureClass = null;
  }
  return next;
}

function successDocument(trigger: BackupTriggerClass, at: string): Doc {
  return withSuccess(emptyDocument(at), trigger, at);
}

function stateOf(doc: unknown): BackupObservationState {
  const state = parseBackupObservationState(doc);
  expect(state, 'fixture must be a valid observation document').not.toBeNull();
  return state as BackupObservationState;
}

function statusOf(doc: Doc, nowMs = NOW): string {
  return evaluateBackupProviderStatus(stateOf(doc), nowMs);
}

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'obs1-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Runs the canonical writer and returns the state path it published. */
async function publish(args: string[]): Promise<string> {
  const dir = await makeTempDir();
  const statePath = path.join(dir, 'observation-v1.json');
  execFileSync('bash', [WRITER, '--state', statePath, ...args], { stdio: 'pipe' });
  return statePath;
}

function hostHealth(observationPath: string, nowMs = NOW) {
  return createHostBackupObservationHealth({
    observationPath,
    now: () => new Date(nowMs),
  });
}

function readStatus(observationPath: string, nowMs = NOW) {
  return hostHealth(observationPath, nowMs).check();
}

async function writeDocument(statePath: string, doc: unknown): Promise<void> {
  await writeFile(statePath, JSON.stringify(doc));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('A. observation schema is parsed fail-closed', () => {
  it('accepts a canonical scheduled success document', () => {
    const state = stateOf(successDocument('scheduled', instant(-HOUR)));
    expect(state).toEqual({
      schemaVersion: BACKUP_OBSERVATION_SCHEMA_VERSION,
      updatedAt: instant(-HOUR),
      latestAttempt: {
        trigger: 'scheduled',
        startedAt: instant(-HOUR),
        completedAt: instant(-HOUR),
        result: 'success',
        failureClass: null,
      },
      latestVerifiedSuccess: { trigger: 'scheduled', verifiedAt: instant(-HOUR) },
      latestScheduledAttempt: {
        trigger: 'scheduled',
        startedAt: instant(-HOUR),
        completedAt: instant(-HOUR),
        result: 'success',
        failureClass: null,
      },
      latestScheduledVerifiedSuccess: { trigger: 'scheduled', verifiedAt: instant(-HOUR) },
    });
  });

  it('accepts a document that carries no attempt yet', () => {
    const state = stateOf(emptyDocument(instant(-HOUR)));
    expect(state.latestAttempt).toBeNull();
    expect(state.latestVerifiedSuccess).toBeNull();
    expect(state.latestScheduledVerifiedSuccess).toBeNull();
  });

  it.each([
    ['a JSON scalar', 42],
    ['a JSON string', '{"schemaVersion":1}'],
    ['a JSON array', []],
    ['null', null],
    ['a missing schema version', { ...emptyDocument(instant(0)), schemaVersion: undefined }],
    ['an unsupported schema version', { ...emptyDocument(instant(0)), schemaVersion: 2 }],
    ['a stringified schema version', { ...emptyDocument(instant(0)), schemaVersion: '1' }],
  ])('rejects %s', (_label, doc) => {
    expect(parseBackupObservationState(doc)).toBeNull();
  });

  it('ignores unknown additive keys instead of failing the whole document', () => {
    const doc = {
      ...successDocument('scheduled', instant(-HOUR)),
      futureField: 'anything',
      nested: { a: 1 },
    };
    expect(stateOf(doc).latestVerifiedSuccess?.verifiedAt).toBe(instant(-HOUR));
  });

  it.each([
    ['a partial attempt group', { ...emptyDocument(instant(0)), latestAttemptTrigger: 'scheduled' }],
    [
      'a completed attempt without a completion instant',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'scheduled',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptResult: 'success',
      },
    ],
    [
      'a running attempt that carries a completion instant',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'scheduled',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptCompletedAt: instant(-HOUR),
        latestAttemptResult: 'running',
      },
    ],
    [
      'a failure without a failure class',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'scheduled',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptCompletedAt: instant(-HOUR),
        latestAttemptResult: 'failure',
      },
    ],
    [
      'a failure class on a successful attempt',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'scheduled',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptCompletedAt: instant(-HOUR),
        latestAttemptResult: 'success',
        latestAttemptFailureClass: 'DUMP_FAILED',
      },
    ],
    [
      'an unknown trigger class',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'cron',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptCompletedAt: instant(-HOUR),
        latestAttemptResult: 'success',
      },
    ],
    [
      'an out-of-vocabulary attempt result',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'scheduled',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptCompletedAt: instant(-HOUR),
        latestAttemptResult: 'SUCCESS',
      },
    ],
    [
      'a failure class outside the published vocabulary',
      {
        ...emptyDocument(instant(0)),
        latestAttemptTrigger: 'scheduled',
        latestAttemptStartedAt: instant(-HOUR),
        latestAttemptCompletedAt: instant(-HOUR),
        latestAttemptResult: 'failure',
        latestAttemptFailureClass: 'SERVORA_MED',
      },
    ],
    ['a verified instant without its trigger', { ...emptyDocument(instant(0)), latestVerifiedAt: instant(-HOUR) }],
    ['a verified trigger without its instant', { ...emptyDocument(instant(0)), latestVerifiedTrigger: 'manual' }],
    ['a scheduled verified instant without a scheduled attempt', { ...emptyDocument(instant(0)), latestScheduledVerifiedAt: instant(-HOUR) }],
    ['a scheduled result without its started-at instant', { ...emptyDocument(instant(0)), latestScheduledAttemptResult: 'success' }],
  ])('rejects %s', (_label, doc) => {
    expect(parseBackupObservationState(doc)).toBeNull();
  });

  it.each([
    ['a millisecond-precision instant the writer never emits', '2026-09-21T12:00:00.000Z'],
    ['a calendar-impossible instant', '2026-02-30T00:00:00Z'],
    ['an out-of-range month', '2026-13-01T00:00:00Z'],
    ['a numeric UTC offset form', '2026-09-21T12:00:00+00:00'],
    ['a local-time form', '2026-09-21T12:00:00'],
    ['free text', 'yesterday'],
    ['an empty string', ''],
    ['an epoch number rather than an instant', 1758456000000],
    ['a boolean', true],
    ['null', null],
  ])('rejects %s as an instant', (_label, value) => {
    expect(parseObservationInstant(value)).toBeNull();
  });

  it('accepts only instants that survive an epoch round-trip', () => {
    expect(parseObservationInstant('2026-09-21T12:00:00Z')).toBe(NOW);
    // Date.parse normalizes this to 2026-03-02; the round-trip rejects it so the
    // reader and the range-limited shell writer agree on what is trustworthy.
    expect(parseObservationInstant('2026-02-30T00:00:00Z')).toBeNull();
  });
});

describe('B. the canonical writer produces documents the reader accepts', () => {
  it('round-trips a real scheduled success into a healthy projection', async () => {
    const startedAt = instant(-60_000);
    const completedAt = instant(-55_000);
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', startedAt,
      '--outcome', 'success',
      '--completed-at', completedAt,
    ]);

    await expect(readStatus(statePath)).resolves.toMatchObject({
      status: 'ok',
      provider: 'host-observation',
      providerStatus: 'healthy',
      latestVerifiedAt: completedAt,
      latestScheduledVerifiedAt: completedAt,
      latestRunStatus: 'SUCCESS',
      latestScheduledRunStatus: 'SUCCESS',
      latestAttemptTrigger: 'scheduled',
      latestAttemptAt: startedAt,
      latestAttemptCompletedAt: completedAt,
      latestAttemptFailureClass: null,
      observationUpdatedAt: expect.any(String),
      workerHeartbeatAt: null,
      schedulerLastTickAt: null,
    });
  });

  it('round-trips a real failure and keeps the prior verified restore point visible', async () => {
    const verifiedAt = instant(-2 * HOUR);
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', verifiedAt,
      '--outcome', 'success',
      '--completed-at', verifiedAt,
    ]);
    execFileSync('bash', [
      WRITER,
      '--state', statePath,
      '--trigger', 'scheduled',
      '--started-at', instant(-60_000),
      '--outcome', 'failure',
      '--completed-at', instant(-55_000),
      '--failure-class', 'DUMP_FAILED',
    ], { stdio: 'pipe' });

    const health = await readStatus(statePath);
    expect(health).toMatchObject({
      status: 'unavailable',
      providerStatus: 'failed',
      latestRunStatus: 'FAILED',
      latestAttemptFailureClass: 'DUMP_FAILED',
      // The prior restore point stays visible even though the projection is not ok.
      latestVerifiedAt: verifiedAt,
      latestScheduledVerifiedAt: verifiedAt,
    });
  });

  it('projects a running attempt as unavailable rather than failed or healthy', async () => {
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', instant(-30_000),
      '--outcome', 'running',
    ]);

    await expect(readStatus(statePath)).resolves.toMatchObject({
      providerStatus: 'unavailable',
      latestRunStatus: 'RUNNING',
      latestScheduledRunStatus: 'RUNNING',
      latestAttemptCompletedAt: null,
      latestVerifiedAt: null,
      latestScheduledVerifiedAt: null,
    });
  });

  it('advances the scheduled baseline when a running attempt completes successfully', async () => {
    const priorVerifiedAt = instant(-HOUR);
    const runningAt = instant(-30_000);
    const completedAt = instant(-25_000);
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', priorVerifiedAt,
      '--outcome', 'success',
      '--completed-at', priorVerifiedAt,
    ]);
    execFileSync('bash', [
      WRITER,
      '--state', statePath,
      '--trigger', 'scheduled',
      '--started-at', runningAt,
      '--outcome', 'running',
    ], { stdio: 'pipe' });
    execFileSync('bash', [
      WRITER,
      '--state', statePath,
      '--trigger', 'scheduled',
      '--started-at', runningAt,
      '--outcome', 'success',
      '--completed-at', completedAt,
    ], { stdio: 'pipe' });

    await expect(readStatus(statePath)).resolves.toMatchObject({
      status: 'ok',
      providerStatus: 'healthy',
      latestVerifiedAt: completedAt,
      latestScheduledVerifiedAt: completedAt,
      latestRunStatus: 'SUCCESS',
      latestScheduledRunStatus: 'SUCCESS',
      latestAttemptAt: runningAt,
      latestAttemptCompletedAt: completedAt,
    });
  });

  it('reports a first-ever failure as failed even though no success exists yet', async () => {
    const statePath = await publish([
      '--trigger', 'postdeploy',
      '--started-at', instant(-60_000),
      '--outcome', 'failure',
      '--completed-at', instant(-55_000),
      '--failure-class', 'ARTIFACT_FINALIZE_FAILED',
    ]);

    await expect(readStatus(statePath)).resolves.toMatchObject({
      status: 'unavailable',
      providerStatus: 'failed',
      latestAttemptTrigger: 'postdeploy',
      latestAttemptFailureClass: 'ARTIFACT_FINALIZE_FAILED',
      latestVerifiedAt: null,
    });
  });

  it('rejects a millisecond-precision artifact the writer would never produce', async () => {
    const dir = await makeTempDir();
    const statePath = path.join(dir, 'observation-v1.json');
    await writeDocument(statePath, {
      ...successDocument('scheduled', instant(-HOUR)),
      updatedAt: new Date(NOW).toISOString(),
    });
    await expect(readStatus(statePath)).resolves.toMatchObject({ providerStatus: 'unavailable' });
  });
});

describe('C. the single canonical 26-hour freshness rule', () => {
  it('defines exactly one threshold', () => {
    expect(MAX_AGE_MS).toBe(26 * 60 * 60 * 1000);
  });

  it.each([
    ['a just-verified artifact', -60_000, 'healthy'],
    ['an artifact just under the limit', -(MAX_AGE_MS - 1000), 'healthy'],
    ['an artifact exactly at the limit', -MAX_AGE_MS, 'healthy'],
    ['an artifact one second past the limit', -(MAX_AGE_MS + 1000), 'stale'],
    ['an artifact a week old', -(7 * 24 * HOUR), 'stale'],
  ])('reports %s as %s', (_label, offsetMs, expected) => {
    expect(statusOf(successDocument('scheduled', instant(offsetMs)))).toBe(expected);
  });

  it('fails closed for a verified instant in the future', () => {
    expect(statusOf(successDocument('scheduled', instant(HOUR)))).toBe('unavailable');
  });

  it('reports failed when the latest attempt failed despite a recent success', () => {
    const doc = withFailure(
      successDocument('scheduled', instant(-HOUR)),
      'scheduled',
      instant(-120_000),
      instant(-115_000),
      'CHECKSUM_FAILED',
    );
    const state = stateOf(doc);
    expect(evaluateBackupProviderStatus(state, NOW)).toBe('failed');
    // The prior success timestamp must remain visible, not be erased.
    expect(state.latestVerifiedSuccess?.verifiedAt).toBe(instant(-HOUR));
  });

  it('keeps the compatibility aggregate ok only for the healthy state', () => {
    expect(statusOf(successDocument('scheduled', instant(-HOUR)))).toBe('healthy');
    expect(statusOf(successDocument('scheduled', instant(-(MAX_AGE_MS + 1000))))).toBe('stale');
  });
});

describe('D. trigger semantics and the schedule heartbeat', () => {
  it('counts a scheduled success for recoverability and for the heartbeat', () => {
    const state = stateOf(successDocument('scheduled', instant(-HOUR)));
    expect(evaluateBackupProviderStatus(state, NOW)).toBe('healthy');
    expect(evaluateScheduledHeartbeat(state, NOW)).toBe(true);
  });

  it.each(['predeploy', 'postdeploy', 'manual'] as const)(
    'counts a %s success for recoverability but never for the heartbeat',
    (trigger) => {
      const state = stateOf(successDocument(trigger, instant(-HOUR)));
      expect(evaluateBackupProviderStatus(state, NOW)).toBe('healthy');
      expect(evaluateScheduledHeartbeat(state, NOW)).toBeNull();
      expect(state.latestScheduledVerifiedSuccess).toBeNull();
    },
  );

  it('does not let a fresh deploy backup hide a stale scheduled baseline', () => {
    const staleBaseline = successDocument('scheduled', instant(-30 * HOUR));
    const afterDeploy = withSuccess(staleBaseline, 'postdeploy', instant(-HOUR));
    const state = stateOf(afterDeploy);

    expect(evaluateScheduledHeartbeat(state, NOW)).toBe(false);
    expect(evaluateBackupProviderStatus(state, NOW)).toBe('stale');
    // Recoverability evidence is still fresh and visible.
    expect(state.latestVerifiedSuccess?.verifiedAt).toBe(instant(-HOUR));
    // The stale scheduled baseline is not overwritten by the deploy run.
    expect(state.latestScheduledVerifiedSuccess?.verifiedAt).toBe(instant(-30 * HOUR));
  });

  it('does not let a manual backup satisfy a stale scheduled baseline', () => {
    const staleBaseline = successDocument('scheduled', instant(-30 * HOUR));
    const afterManual = withSuccess(staleBaseline, 'manual', instant(-HOUR));

    expect(evaluateBackupProviderStatus(stateOf(afterManual), NOW)).toBe('stale');
    expect(stateOf(afterManual).latestScheduledVerifiedSuccess?.verifiedAt).toBe(instant(-30 * HOUR));
  });

  it('keeps the fresh prior scheduled heartbeat while the next scheduled attempt runs', () => {
    const priorSuccess = successDocument('scheduled', instant(-HOUR));
    const state = stateOf(withRunning(priorSuccess, 'scheduled', instant(-30_000)));

    expect(evaluateScheduledHeartbeat(state, NOW)).toBe(true);
    expect(evaluateBackupProviderStatus(state, NOW)).toBe('healthy');
    expect(state.latestScheduledVerifiedSuccess?.verifiedAt).toBe(instant(-HOUR));
  });

  it.each(['postdeploy', 'manual'] as const)(
    'keeps a running scheduled attempt stale when only a fresh %s success exists',
    (freshTrigger) => {
      const staleBaseline = successDocument('scheduled', instant(-30 * HOUR));
      const afterFreshBackup = withSuccess(staleBaseline, freshTrigger, instant(-HOUR));
      const whileScheduledRuns = withRunning(afterFreshBackup, 'scheduled', instant(-30_000));
      const state = stateOf(whileScheduledRuns);

      expect(evaluateScheduledHeartbeat(state, NOW)).toBe(false);
      expect(evaluateBackupProviderStatus(state, NOW)).toBe('stale');
      expect(state.latestVerifiedSuccess?.verifiedAt).toBe(instant(-HOUR));
      expect(state.latestScheduledVerifiedSuccess?.verifiedAt).toBe(instant(-30 * HOUR));
    },
  );

  it.each(['postdeploy', 'manual'] as const)(
    'reports failed when the scheduled attempt failed and a fresh %s backup exists',
    (freshTrigger) => {
      const failedScheduled = withFailure(
        successDocument('scheduled', instant(-30 * HOUR)),
        'scheduled',
        instant(-2 * HOUR),
        instant(-2 * HOUR + 4000),
        'DUMP_FAILED',
      );
      const afterFreshBackup = withSuccess(failedScheduled, freshTrigger, instant(-HOUR));
      const state = stateOf(afterFreshBackup);

      expect(evaluateScheduledHeartbeat(state, NOW)).toBe(false);
      expect(evaluateBackupProviderStatus(state, NOW)).toBe('failed');
      // The fresh artifact is still reported, but it cannot mask the failure.
      expect(state.latestVerifiedSuccess?.verifiedAt).toBe(instant(-HOUR));
    },
  );

  it('treats a scheduled attempt that succeeded but went stale as stale, not failed', () => {
    const state = stateOf(successDocument('scheduled', instant(-30 * HOUR)));
    expect(evaluateScheduledHeartbeat(state, NOW)).toBe(false);
    expect(evaluateBackupProviderStatus(state, NOW)).toBe('stale');
  });

  it('does not report a broken heartbeat before the baseline is established', () => {
    const noBaseline = successDocument('postdeploy', instant(-HOUR));
    expect(evaluateScheduledHeartbeat(stateOf(noBaseline), NOW)).toBeNull();
    expect(statusOf(noBaseline)).toBe('healthy');
  });
});

describe('E. disabled, unavailable and never-observed stay distinct', () => {
  it('reports a deliberately disabled mechanism as disabled, not as a failed run', async () => {
    await expect(createDisabledBackupHealth().check()).resolves.toMatchObject({
      status: 'unavailable',
      provider: 'none',
      providerStatus: 'disabled',
      latestVerifiedAt: null,
      latestRunStatus: null,
    });
  });

  it('reports a missing artifact as unavailable, never as disabled', async () => {
    const dir = await makeTempDir();
    const health = await readStatus(path.join(dir, 'observation-v1.json'));
    expect(health).toMatchObject({ status: 'unavailable', provider: 'host-observation', providerStatus: 'unavailable' });
    expect(health.providerStatus).not.toBe('disabled');
  });

  it('reports never-observed evidence as unavailable, never as disabled', async () => {
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', instant(-30_000),
      '--outcome', 'running',
    ]);
    const health = await readStatus(statePath);
    expect(health.providerStatus).toBe('unavailable');
    expect(health.providerStatus).not.toBe('disabled');
  });

  it('never reports disabled for a real failure', async () => {
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', instant(-60_000),
      '--outcome', 'failure',
      '--completed-at', instant(-55_000),
      '--failure-class', 'OBSERVATION_WRITE_FAILED',
    ]);
    const health = await readStatus(statePath);
    expect(health.providerStatus).toBe('failed');
    expect(health.providerStatus).not.toBe('disabled');
  });
});

describe('E2. the reader fails closed for untrustworthy evidence', () => {
  it.each([
    ['a missing file', null],
    ['malformed JSON', '{not json'],
    ['an empty file', ''],
    ['a JSON scalar', '42'],
    ['an unsupported schema version', '{"schemaVersion":2,"updatedAt":"2026-09-21T11:00:00Z"}'],
    ['a document with no updated-at', '{"schemaVersion":1}'],
    ['a partial attempt group', '{"schemaVersion":1,"updatedAt":"2026-09-21T11:00:00Z","latestAttemptTrigger":"scheduled"}'],
  ])('reports %s as unavailable', async (_label, contents) => {
    const dir = await makeTempDir();
    const statePath = path.join(dir, 'observation-v1.json');
    if (contents !== null) await writeFile(statePath, contents);
    await expect(readStatus(statePath)).resolves.toMatchObject({
      status: 'unavailable',
      providerStatus: 'unavailable',
    });
  });

  it('refuses a symlinked state file', async () => {
    const dir = await makeTempDir();
    const realPath = path.join(dir, 'elsewhere.json');
    const statePath = path.join(dir, 'observation-v1.json');
    await writeDocument(realPath, successDocument('scheduled', instant(-HOUR)));
    await symlink(realPath, statePath);

    await expect(readStatus(statePath)).resolves.toMatchObject({ providerStatus: 'unavailable' });
  });

  it('refuses a directory in place of the state file', async () => {
    const dir = await makeTempDir();
    const statePath = path.join(dir, 'observation-v1.json');
    await mkdir(statePath);
    await expect(readStatus(statePath)).resolves.toMatchObject({ providerStatus: 'unavailable' });
  });

  it('refuses an oversized artifact while accepting the same document unpadded', async () => {
    const dir = await makeTempDir();
    const statePath = path.join(dir, 'observation-v1.json');
    const doc = successDocument('scheduled', instant(-HOUR));

    await writeDocument(statePath, doc);
    await expect(readStatus(statePath)).resolves.toMatchObject({ providerStatus: 'healthy' });

    // Still a valid document for the parser; only the size guard rejects it.
    await writeDocument(statePath, { ...doc, padding: 'x'.repeat(70 * 1024) });
    await expect(readStatus(statePath)).resolves.toMatchObject({ providerStatus: 'unavailable' });
  });

  it.skipIf(process.getuid?.() === 0)('refuses an unreadable artifact', async () => {
    const dir = await makeTempDir();
    const statePath = path.join(dir, 'observation-v1.json');
    await writeDocument(statePath, successDocument('scheduled', instant(-HOUR)));
    await chmod(statePath, 0o000);
    await expect(readStatus(statePath)).resolves.toMatchObject({ providerStatus: 'unavailable' });
  });
});

describe('F. the public health contract changed only additively', () => {
  const testConfig: AppConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3000,
    databaseUrl: 'postgresql://unused-in-app-test',
    logLevel: 'silent',
    corsOrigin: 'http://127.0.0.1:5173',
    sessionTtlSeconds: 28_800,
    loginRateLimitMax: 5,
    rateLimitWindowMs: 60_000,
    trustedProxy: 'loopback',
    healthSchemaVersion: null,
    releaseSha: TEST_RELEASE_SHA,
    actionScopedGeolocationEnabled: false,
    reverseGeocoderProvider: null,
    googleGeocodingApiKey: null,
    reverseGeocoderTimeoutMs: 2000,
    geocodingUserDailyLimit: 15,
    geocodingOrganizationDailyLimit: 250,
    geocodingGlobalMonthlyLimit: 8000,
    webPush: {
      enabled: false,
      vapidSubject: null,
      vapidPublicKey: null,
      vapidPrivateKey: null,
    },
  };

  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const PRE_EXISTING_FIELDS = [
    'status',
    'latestVerifiedAt',
    'latestScheduledVerifiedAt',
    'latestRunStatus',
    'latestScheduledRunStatus',
    'workerHeartbeatAt',
    'schedulerLastTickAt',
  ] as const;

  async function appWithHostProvider(statePath: string) {
    const app = await buildApp(testConfig, {
      healthReadiness: { check: async () => 'ok' },
      backupHealthReadiness: hostHealth(statePath),
    });
    apps.push(app);
    return app;
  }

  it('keeps every pre-existing /api/health backup field with its original shape', async () => {
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', instant(-60_000),
      '--outcome', 'success',
      '--completed-at', instant(-55_000),
    ]);
    const app = await appWithHostProvider(statePath);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', releaseSha: TEST_RELEASE_SHA });

    const backup = response.json().backup as Record<string, unknown>;
    for (const field of PRE_EXISTING_FIELDS) {
      expect(backup, `missing pre-existing field ${field}`).toHaveProperty(field);
    }
    expect(backup.status).toBe('ok');
    expect(backup.latestRunStatus).toBe('SUCCESS');
    expect(backup.latestVerifiedAt).toBe(instant(-55_000));
  });

  it('leaves the top-level /api/health semantics untouched by the backup projection', async () => {
    const statePath = await publish([
      '--trigger', 'scheduled',
      '--started-at', instant(-60_000),
      '--outcome', 'failure',
      '--completed-at', instant(-55_000),
      '--failure-class', 'DUMP_FAILED',
    ]);
    const app = await appWithHostProvider(statePath);

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    // Readiness is ok, so the top-level status and HTTP code are unchanged even
    // though the backup projection is degraded.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', releaseSha: TEST_RELEASE_SHA });
    expect(response.json().backup).toMatchObject({ status: 'unavailable', providerStatus: 'failed' });
  });

  it('keeps a fresh scheduled success healthy while the next scheduled attempt is running', async () => {
    const dir = await makeTempDir();
    const statePath = path.join(dir, 'observation-v1.json');
    execFileSync('bash', [
      WRITER,
      '--state', statePath,
      '--trigger', 'scheduled',
      '--started-at', instant(-HOUR),
      '--outcome', 'success',
      '--completed-at', instant(-HOUR),
    ], { stdio: 'pipe' });
    execFileSync('bash', [
      WRITER,
      '--state', statePath,
      '--trigger', 'scheduled',
      '--started-at', instant(-30_000),
      '--outcome', 'running',
    ], { stdio: 'pipe' });
    const app = await appWithHostProvider(statePath);

    const response = await app.inject({ method: 'GET', url: '/api/health/backup' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      providerStatus: 'healthy',
      latestVerifiedAt: instant(-HOUR),
      latestScheduledVerifiedAt: instant(-HOUR),
      latestRunStatus: 'RUNNING',
      latestScheduledRunStatus: 'RUNNING',
    });
  });

  it.each([
    ['healthy', 'ok', 200],
    ['stale', 'unavailable', 503],
    ['failed', 'unavailable', 503],
    ['unavailable', 'unavailable', 503],
  ])('serves /api/health/backup for a %s provider', async (label, expectedStatus, expectedCode) => {
    let backupReadiness;
    if (label === 'healthy') {
      const statePath = await publish([
        '--trigger', 'scheduled', '--started-at', instant(-60_000),
        '--outcome', 'success', '--completed-at', instant(-55_000),
      ]);
      backupReadiness = hostHealth(statePath);
    } else if (label === 'stale') {
      const statePath = await publish([
        '--trigger', 'scheduled', '--started-at', instant(-30 * HOUR),
        '--outcome', 'success', '--completed-at', instant(-30 * HOUR),
      ]);
      backupReadiness = hostHealth(statePath);
    } else if (label === 'failed') {
      const statePath = await publish([
        '--trigger', 'scheduled', '--started-at', instant(-60_000),
        '--outcome', 'failure', '--completed-at', instant(-55_000),
        '--failure-class', 'DUMP_FAILED',
      ]);
      backupReadiness = hostHealth(statePath);
    } else {
      const dir = await makeTempDir();
      backupReadiness = hostHealth(path.join(dir, 'observation-v1.json'));
    }

    const app = await buildApp(testConfig, {
      healthReadiness: { check: async () => 'ok' },
      backupHealthReadiness: backupReadiness,
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health/backup' });
    expect(response.statusCode).toBe(expectedCode);
    expect(response.json()).toMatchObject({ status: expectedStatus, providerStatus: label });
  });

  it('serves /api/health/backup as HTTP 503 for a disabled mechanism', async () => {
    const app = await buildApp(testConfig, {
      healthReadiness: { check: async () => 'ok' },
      backupHealthReadiness: createDisabledBackupHealth(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health/backup' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'unavailable', provider: 'none', providerStatus: 'disabled' });
  });

  it('never projects a path, filename, directory or credential into the response', async () => {
    const dir = await makeTempDir('obs1-supersecret-sentinel-');
    const statePath = path.join(dir, 'observation-v1.json');
    await writeDocument(statePath, successDocument('scheduled', instant(-HOUR)));

    const app = await appWithHostProvider(statePath);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const backup = await app.inject({ method: 'GET', url: '/api/health/backup' });

    for (const body of [JSON.stringify(health.json()), JSON.stringify(backup.json())]) {
      expect(body).not.toContain('supersecret');
      expect(body).not.toContain(dir);
      expect(body).not.toContain('observation-v1');
      expect(body).not.toContain('/var/');
      expect(body).not.toContain('DATABASE_URL');
      expect(body).not.toContain('password');
      expect(body).not.toContain('postgresql://');
      expect(body).not.toMatch(/[A-Za-z0-9_]*\.(json|dump|sql|sha256)/);
    }
  });
});

describe('G. writer and reader share exactly one vocabulary', () => {
  function bashArray(script: string, name: string): string[] {
    const match = new RegExp(`${name}=\\(([\\s\\S]*?)\\)`).exec(script);
    if (match === null) throw new Error(`${name} not found in the observation writer`);
    return match[1]
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !token.startsWith('#'));
  }

  it('pins the same schema version on both sides of the contract', async () => {
    const script = await readFile(WRITER, 'utf8');
    expect(script).toContain(`readonly SCHEMA_VERSION=${BACKUP_OBSERVATION_SCHEMA_VERSION}`);
  });

  it.each([
    ['TRIGGER_ALLOWLIST', () => [...BACKUP_TRIGGER_CLASSES]],
    ['OUTCOME_ALLOWLIST', () => [...BACKUP_ATTEMPT_RESULTS]],
    ['FAILURE_CLASS_ALLOWLIST', () => [...BACKUP_FAILURE_CLASSES]],
  ])('keeps the %s vocabulary identical to the TypeScript contract', async (name, expected) => {
    const script = await readFile(WRITER, 'utf8');
    expect(bashArray(script, name)).toEqual(expected());
  });
});

describe('H. provider selection is explicit and fail-closed', () => {
  const base = { DATABASE_URL: 'postgresql://servora:servora@localhost:5432/servora_med' };
  const OBSERVATION_PATH = '/var/lib/servora-med-backup/observation-v1.json';

  it('preserves the previously wired provider when BACKUP_PROVIDER is unset', () => {
    expect(loadConfig(base).backupProvider).toEqual({ provider: 'br5-r2', observationPath: null });
  });

  it('does not let a configured observation path activate the host provider implicitly', () => {
    expect(loadConfig({ ...base, BACKUP_OBSERVATION_PATH: OBSERVATION_PATH }).backupProvider)
      .toEqual({ provider: 'br5-r2', observationPath: OBSERVATION_PATH });
  });

  it('selects the host observation provider only when explicitly configured', () => {
    expect(loadConfig({
      ...base,
      BACKUP_PROVIDER: 'host-observation',
      BACKUP_OBSERVATION_PATH: OBSERVATION_PATH,
    }).backupProvider).toEqual({ provider: 'host-observation', observationPath: OBSERVATION_PATH });
  });

  it('supports an explicit intentionally-disabled declaration', () => {
    expect(loadConfig({ ...base, BACKUP_PROVIDER: 'none' }).backupProvider)
      .toEqual({ provider: 'none', observationPath: null });
  });

  it('keeps the BR5 worker unconfigured by default', () => {
    const config = loadConfig(base);
    expect(config.backupWorker).toBeUndefined();
    expect(config.backupProvider?.provider).toBe('br5-r2');
  });

  it('requires the observation path for the host observation provider', () => {
    expect(() => loadConfig({ ...base, BACKUP_PROVIDER: 'host-observation' }))
      .toThrow('BACKUP_OBSERVATION_PATH is required when BACKUP_PROVIDER=host-observation');
  });

  it('rejects an unknown provider name', () => {
    expect(() => loadConfig({ ...base, BACKUP_PROVIDER: 'r2' }))
      .toThrow('BACKUP_PROVIDER must be one of none, host-observation, br5-r2');
  });

  it.each([
    ['a relative path', 'var/lib/observation-v1.json'],
    ['a traversing path', '/var/lib/../etc/observation-v1.json'],
    ['a dot segment', '/var/lib/./observation-v1.json'],
    ['a duplicated separator', '/var//lib/observation-v1.json'],
    ['a trailing separator', '/var/lib/'],
    ['surrounding whitespace', ' /var/lib/observation-v1.json'],
  ])('rejects %s as an observation path', (_label, value) => {
    expect(() => loadConfig({
      ...base,
      BACKUP_PROVIDER: 'host-observation',
      BACKUP_OBSERVATION_PATH: value,
    })).toThrow();
  });
});
