import { describe, expect, it } from 'vitest';

import { BackupWorker } from '../src/modules/backup/worker.js';
import type { BackupWorkerRepository } from '../src/modules/backup/repository.js';
import type { BackupServiceTransitionPrimitives } from '../src/modules/backup/service.js';
import type { BackupRun, BackupWorkerClaim } from '../src/modules/backup/types.js';
import { timeAt } from './backup-time-fixture.js';

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function run(): BackupRun {
  return {
    id: RUN_ID,
    status: 'RUNNING',
    phase: 'PREFLIGHT',
    origin: 'MANUAL',
    scope: 'DATABASE',
    retentionClass: 'MANUAL',
    createdBy: null,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    startedAt: new Date('2026-08-23T00:00:00Z'),
    completedAt: null,
    formatVersion: 1,
    appVersion: null,
    gitCommit: null,
    schemaVersion: null,
    databaseServerVersion: null,
    dumpVersion: null,
    remoteKey: null,
    sizeBytes: null,
    sha256: null,
    verifiedAt: null,
    warningCode: null,
    warningSummary: null,
    failureCode: null,
    failureSummary: null,
  };
}

function claim(): BackupWorkerClaim {
  return {
    run: run(),
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    leaseUntil: new Date('2026-08-23T00:01:00Z'),
  };
}

function serviceSpy(calls: string[]): BackupServiceTransitionPrimitives {
  const current = run();
  return {
    startRun: async (_id, token) => { calls.push(`start:${token}`); return current; },
    recordArtifactGeneration: async (_id, _before, token) => { calls.push(`generation:${token}`); return current; },
    advancePhase: async (_id, _phase, _files, token) => { calls.push(`advance:${token}`); return current; },
    markFailed: async (_id, code, _summary, token) => { calls.push(`failed:${code}:${token}`); return current; },
    markCancelled: async (_id, token) => { calls.push(`cancel:${token}`); return current; },
    recordVerification: async (_id, _input, token) => { calls.push(`verify:${token}`); return current; },
    completeRun: async (_id, _options, token) => { calls.push(`complete:${token}`); return current; },
    markCleanupWarning: async (_id, _summary, token) => { calls.push(`warning:${token}`); return current; },
  };
}

function repositorySpy(overrides: Partial<BackupWorkerRepository> = {}) {
  const calls: string[] = [];
  const repository = {
    tryWithBackupExclusionLock: async <T>(work: () => Promise<T>) => work(),
    touchWorkerAndSchedulerHeartbeat: async (at: Date | null, evidence: unknown) => {
      calls.push(`worker-scheduler-heartbeat:${at?.toISOString() ?? 'null'}:${evidence === null ? 'null' : 'evidence'}`);
    },
    touchWorkerHeartbeat: async (at: Date | null, evidence: unknown) => {
      calls.push(`worker-heartbeat:${at?.toISOString() ?? 'null'}:${evidence === null ? 'null' : 'evidence'}`);
    },
    recoverExpiredRuns: async () => [],
    appendSystemBackupAudit: async (_id: string, event: string) => { calls.push(`audit:${event}`); },
    claimExpiredCleanupRun: async () => null,
    getPolicy: async () => null,
    touchSchedulerHeartbeat: async () => { calls.push('scheduler-heartbeat'); },
    heartbeatRun: async () => true,
    claimNextRun: async () => null,
    ...overrides,
  } as unknown as BackupWorkerRepository;
  return { repository, calls };
}

const fixedNow = () => new Date('2026-08-23T03:00:00Z');

describe('BR5 backup worker runtime', () => {
  it('does not touch the database while disabled', async () => {
    const { repository, calls } = repositorySpy();
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => ({ kind: 'completed' }),
      enabled: false,
      now: fixedNow,
    });

    expect(await worker.runOnce()).toEqual({ kind: 'disabled' });
    expect(calls).toEqual([]);
  });

  it('serializes concurrent ticks and binds all mutations to the claim lease', async () => {
    const executionCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstClaim = claim();
    const { repository, calls } = repositorySpy({
      claimNextRun: async () => firstClaim,
    });
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async (received, context) => {
        executionCalls.push(received.leaseToken);
        await gate;
        await context.service.advancePhase(received.run.id, 'DATABASE_DUMP', false);
        return { kind: 'completed' };
      },
      enabled: true,
      now: fixedNow,
      randomId: () => firstClaim.leaseToken,
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'claimed', runId: RUN_ID },
      { kind: 'claimed', runId: RUN_ID },
    ]);
    expect(executionCalls).toEqual([firstClaim.leaseToken]);
    expect(calls).toContain(`advance:${firstClaim.leaseToken}`);
  });

  it('retries a transient same-phase failure with bounded injected sleep', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const firstClaim = claim();
    const { repository, calls } = repositorySpy({
      claimNextRun: async () => firstClaim,
    });
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => {
        attempts += 1;
        return attempts === 1
          ? { kind: 'retryable-failure', failureCode: 'R2_UPLOAD_FAILED', failureSummary: 'temporary' }
          : { kind: 'completed' };
      },
      enabled: true,
      now: fixedNow,
      randomId: () => firstClaim.leaseToken,
      sleep: async (delay) => { delays.push(delay); },
    });

    await expect(worker.runOnce()).resolves.toEqual({ kind: 'claimed', runId: RUN_ID });
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(calls.some((call) => call.startsWith('failed:'))).toBe(false);
  });

  it('terminalizes a retryable failure only after the bounded attempt budget', async () => {
    const firstClaim = claim();
    const { repository, calls } = repositorySpy({
      claimNextRun: async () => firstClaim,
    });
    let attempts = 0;
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => {
        attempts += 1;
        return { kind: 'retryable-failure', failureCode: 'R2_VERIFY_FAILED', failureSummary: 'temporary' };
      },
      enabled: true,
      now: fixedNow,
      randomId: () => firstClaim.leaseToken,
      sleep: async () => undefined,
    });

    await worker.runOnce();
    expect(attempts).toBe(3);
    expect(calls).toContain(`failed:R2_VERIFY_FAILED:${firstClaim.leaseToken}`);
  });

  it.each([
    'R2_AUTH_FAILED',
    'R2_OBJECT_CONFLICT',
    'R2_OBJECT_TOO_LARGE',
    'REMOTE_CHECKSUM_MISMATCH',
  ] as const)('does not retry deterministic failure %s', async (failureCode) => {
    const firstClaim = claim();
    const delays: string[] = [];
    const { repository, calls } = repositorySpy({
      claimNextRun: async () => firstClaim,
    });
    let attempts = 0;
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => {
        attempts += 1;
        return { kind: 'retryable-failure', failureCode, failureSummary: 'deterministic' };
      },
      enabled: true,
      now: fixedNow,
      randomId: () => firstClaim.leaseToken,
      sleep: async (delay) => { delays.push(String(delay)); },
    });

    await worker.runOnce();
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
    expect(calls).toContain(`failed:${failureCode}:${firstClaim.leaseToken}`);
  });

  it('advances both trusted heartbeats from one sample per poll', async () => {
    const { repository, calls } = repositorySpy();
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => ({ kind: 'completed' }),
      enabled: true,
      now: fixedNow,
      sampleTrustedTime: async () => timeAt(fixedNow().getTime()),
    });

    await worker.runOnce();
    const heartbeats = calls.filter((call) => call.startsWith('worker-scheduler-heartbeat'));
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toContain('evidence');
  });

  it('does not advance trusted heartbeats when the sample is UNKNOWN', async () => {
    const { repository, calls } = repositorySpy();
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => ({ kind: 'completed' }),
      enabled: true,
      now: fixedNow,
      sampleTrustedTime: async () => null,
    });

    await worker.runOnce();
    expect(calls.filter((call) => call.startsWith('worker-scheduler-heartbeat')))
      .toEqual(['worker-scheduler-heartbeat:null:null']);
  });

  it('keeps the operational lease alive when trusted-time sampling fails', async () => {
    const firstClaim = claim();
    let leaseLost: boolean | null = null;
    let heartbeats = 0;
    const { repository, calls } = repositorySpy({
      claimNextRun: async () => firstClaim,
      heartbeatRun: async () => { heartbeats += 1; return true; },
    });
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async (_claim, context) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        leaseLost = context.leaseLost();
        return { kind: 'completed' };
      },
      enabled: true,
      now: fixedNow,
      heartbeatIntervalMs: 5,
      leaseMs: 60_000,
      randomId: () => firstClaim.leaseToken,
      sampleTrustedTime: async () => { throw new Error('TRUSTED_TIME_UNKNOWN'); },
    });

    await worker.runOnce();
    expect(leaseLost).toBe(false);
    expect(heartbeats).toBeGreaterThan(0);
    expect(calls.some((call) => call.startsWith('worker-heartbeat'))).toBe(false);
  });

  it('does not write a fake scheduler tick from an active-run heartbeat', async () => {
    const firstClaim = claim();
    const { repository, calls } = repositorySpy({
      claimNextRun: async () => firstClaim,
    });
    const worker = new BackupWorker({
      repository,
      service: serviceSpy(calls),
      executeRun: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { kind: 'completed' };
      },
      enabled: true,
      now: fixedNow,
      heartbeatIntervalMs: 5,
      leaseMs: 60_000,
      randomId: () => firstClaim.leaseToken,
      sampleTrustedTime: async () => timeAt(fixedNow().getTime()),
    });

    await worker.runOnce();
    expect(calls.filter((call) => call.startsWith('worker-heartbeat')).length).toBeGreaterThan(0);
    expect(calls).not.toContain('scheduler-heartbeat');
    expect(calls.filter((call) => call.startsWith('worker-scheduler-heartbeat'))).toHaveLength(1);
  });
});
