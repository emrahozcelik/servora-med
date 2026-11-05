import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { CurrentTimeEvidence } from '../../ops/scripts/trusted-time.mjs';
import { PostgresBackupRepository } from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';
import type { BackupVerificationProof } from '../src/modules/backup/trusted-evidence.js';
import { createPostgresBackupHealth } from '../src/modules/health/postgres-backup-health.js';
import { timeAt, legacyTimeAt } from './backup-time-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const T0 = Date.parse('2026-11-04T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const SHA = 'a'.repeat(64);

describe.skipIf(!databaseUrl)('BR5-TT-1 trusted evidence PostgreSQL', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let pool: Pool;
  let repository: PostgresBackupRepository;
  let service: BackupService;
  const schema = `br5tt1pg_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    repository = new PostgresBackupRepository(pool);
    service = new BackupService(repository);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `UPDATE backup_worker_state
          SET worker_heartbeat_at = NULL, worker_heartbeat_time_evidence = NULL,
              scheduler_last_tick_at = NULL, scheduler_last_tick_time_evidence = NULL,
              last_scheduled_slot_key = NULL, last_scheduled_local_date = NULL,
              last_scheduled_for = NULL, last_scheduled_run_id = NULL
        WHERE singleton`,
    );
    await pool.query('DELETE FROM backup_runs');
  });

  async function insertRun(input: {
    id?: string;
    phase?: string;
    origin?: 'MANUAL' | 'SCHEDULED' | 'PRE_RESTORE';
    status?: 'RUNNING' | 'CLEANUP' | 'SUCCESS';
    token?: string;
    leaseUntil?: Date;
    generation?: boolean;
    before?: CurrentTimeEvidence | null;
    remote?: boolean;
    verifiedAt?: Date | null;
    sha?: string;
  } = {}) {
    const id = input.id ?? randomUUID();
    const token = input.token ?? randomUUID();
    const generationId = input.generation === false ? null : randomUUID();
    const before = input.before === undefined
      ? (input.generation === false ? null : timeAt(T0))
      : input.before;
    const sha = input.sha ?? SHA;
    const key = `production/instance/v1/scheduled/${id}.sbk.age`;
    const phase = input.phase ?? 'REMOTE_VERIFY';
    const status = input.status ?? 'RUNNING';
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, phase, origin, scope, retention_class, created_at, started_at,
         lease_token, lease_until, heartbeat_at, artifact_generation_id,
         artifact_generation_time_evidence, remote_key, size_bytes, sha256, verified_at)
       VALUES ($1, $2, $3, $4, 'DATABASE', 'DAILY', NOW(), NOW(),
               $5, $6, NOW(), $7, $8::jsonb, $9, $10, $11, $12)`,
      [
        id, status, phase, input.origin ?? 'SCHEDULED', token,
        input.leaseUntil ?? new Date(Date.now() + 60_000),
        generationId,
        before === null ? null : JSON.stringify(before),
        input.remote === false ? null : key,
        input.remote === false ? null : 1024,
        input.remote === false ? null : sha,
        input.verifiedAt ?? null,
      ],
    );
    return { id, token, generationId, before, sha, key };
  }

  function proofFor(
    run: { id: string; generationId: string | null; before: CurrentTimeEvidence | null; sha: string; key: string },
    after: CurrentTimeEvidence = timeAt(T0 + MIN),
    overrides: Partial<BackupVerificationProof> = {},
  ): BackupVerificationProof {
    if (!run.generationId || !run.before) throw new Error('run has no generation evidence');
    return {
      proofVersion: 2,
      runId: run.id,
      artifactGenerationId: run.generationId,
      artifactSha256: run.sha,
      sizeBytes: 1024,
      remoteAttemptId: randomUUID(),
      origin: 'SCHEDULED',
      remoteKey: run.key,
      generationStartedAt: run.before.wallAtUTC,
      verificationAttemptStartedAt: new Date(T0 + 30_000).toISOString(),
      verifiedAt: after.wallAtUTC,
      before: run.before,
      after,
      ...overrides,
    };
  }

  async function healthStatus(current: CurrentTimeEvidence, workerEnabled = false) {
    const reader = createPostgresBackupHealth(pool, {
      workerEnabled,
      workerStaleAfterMs: 2 * MIN,
      schedulerStaleAfterMs: 2 * MIN,
      sampleTime: async () => current,
    });
    return reader.check();
  }

  it('mints one generation per run and never refreshes the original before', async () => {
    const run = await insertRun({ phase: 'DATABASE_DUMP', generation: false, remote: false });
    const first = await repository.recordArtifactGeneration(run.id, timeAt(T0), run.token);
    expect(first?.artifactGenerationId).not.toBeNull();
    expect(first?.artifactGenerationTimeEvidence).toEqual(timeAt(T0));

    const retry = await repository.recordArtifactGeneration(run.id, timeAt(T0 + HOUR), run.token);
    expect(retry?.artifactGenerationId).toBe(first?.artifactGenerationId);
    expect(retry?.artifactGenerationTimeEvidence).toEqual(timeAt(T0));

    const runs = await Promise.all([
      repository.recordArtifactGeneration(run.id, timeAt(T0 + 2 * HOUR), run.token),
      repository.recordArtifactGeneration(run.id, timeAt(T0 + 3 * HOUR), run.token),
    ]);
    expect(new Set(runs.map((item) => item?.artifactGenerationId)).size).toBe(1);
    expect(runs[0]?.artifactGenerationTimeEvidence).toEqual(timeAt(T0));
  });

  it('keeps the generation before NULL when the first sample failed', async () => {
    const run = await insertRun({ phase: 'DATABASE_DUMP', generation: false, remote: false });
    const first = await repository.recordArtifactGeneration(run.id, null, run.token);
    expect(first?.artifactGenerationId).not.toBeNull();
    expect(first?.artifactGenerationTimeEvidence).toBeNull();

    const later = await repository.recordArtifactGeneration(run.id, timeAt(T0 + HOUR), run.token);
    expect(later?.artifactGenerationId).toBe(first?.artifactGenerationId);
    expect(later?.artifactGenerationTimeEvidence).toBeNull();
  });

  it('writes an immutable generation-bound proof and derives verified_at from after', async () => {
    const run = await insertRun();
    const proof = proofFor(run);
    const recorded = await service.recordVerification(run.id, {
      remoteKey: run.key,
      sizeBytes: 1024,
      sha256: run.sha,
      proof,
    }, run.token);
    expect(recorded.verificationTimeEvidence).toMatchObject({
      proofVersion: 2,
      artifactGenerationId: run.generationId,
      verifiedAt: proof.verifiedAt,
    });
    expect(recorded.verifiedAt).toBeNull();

    await service.advancePhase(run.id, 'CLEANUP', false, run.token);
    const completed = await service.completeRun(run.id, {}, run.token);
    expect(completed.status).toBe('SUCCESS');
    expect(completed.verifiedAt?.toISOString()).toBe(proof.verifiedAt);
    expect(completed.verificationTimeEvidence).not.toBeNull();

    const health = await healthStatus(timeAt(T0 + HOUR));
    expect(health.providerStatus).toBe('healthy');
  });

  it('preserves R2 integrity and SUCCESS when trusted time is unavailable', async () => {
    const run = await insertRun();
    const recorded = await service.recordVerification(run.id, {
      remoteKey: run.key,
      sizeBytes: 1024,
      sha256: run.sha,
      proof: null,
    }, run.token);
    expect(recorded.verificationTimeEvidence).toBeNull();
    expect(recorded.remoteKey).toBe(run.key);
    expect(recorded.sha256).toBe(run.sha);

    await service.advancePhase(run.id, 'CLEANUP', false, run.token);
    const completed = await service.completeRun(run.id, {}, run.token);
    expect(completed.status).toBe('SUCCESS');
    expect(completed.verifiedAt).not.toBeNull();
    expect(completed.verificationTimeEvidence).toBeNull();
    expect(completed.remoteKey).toBe(run.key);

    const health = await healthStatus(timeAt(T0 + HOUR));
    expect(health.providerStatus).toBe('unavailable');
    expect(health.status).toBe('unavailable');
  });

  it('reuses a valid proof on retry and rejects a conflicting retry', async () => {
    const run = await insertRun();
    const firstProof = proofFor(run);
    await service.recordVerification(run.id, {
      remoteKey: run.key, sizeBytes: 1024, sha256: run.sha, proof: firstProof,
    }, run.token);

    const laterProof = proofFor(run, timeAt(T0 + 20 * HOUR));
    const retried = await service.recordVerification(run.id, {
      remoteKey: run.key, sizeBytes: 1024, sha256: run.sha, proof: laterProof,
    }, run.token);
    expect(retried.verificationTimeEvidence?.verifiedAt).toBe(firstProof.verifiedAt);
    expect(retried.verificationTimeEvidence?.remoteAttemptId).toBe(firstProof.remoteAttemptId);

    await expect(service.recordVerification(run.id, {
      remoteKey: run.key, sizeBytes: 2048, sha256: run.sha, proof: laterProof,
    }, run.token)).rejects.toThrow();
  });

  it('keeps one immutable proof under concurrent verification retries', async () => {
    const run = await insertRun();
    const proof = proofFor(run);
    const results = await Promise.all([
      service.recordVerification(run.id, {
        remoteKey: run.key, sizeBytes: 1024, sha256: run.sha, proof,
      }, run.token),
      service.recordVerification(run.id, {
        remoteKey: run.key, sizeBytes: 1024, sha256: run.sha, proof,
      }, run.token),
    ]);
    expect(results[0]?.verificationTimeEvidence?.remoteAttemptId).toBe(proof.remoteAttemptId);
    expect(results[1]?.verificationTimeEvidence?.remoteAttemptId).toBe(proof.remoteAttemptId);
    const stored = await repository.findRunById(run.id);
    expect(stored?.verificationTimeEvidence?.remoteAttemptId).toBe(proof.remoteAttemptId);
    expect(stored?.verificationTimeEvidence?.verifiedAt).toBe(proof.verifiedAt);
  });

  it('rejects proofs with a mismatched run, generation, origin, sha, size, key, or before', async () => {
    const run = await insertRun();
    const valid = proofFor(run);
    const bad = [
      { ...valid, runId: randomUUID() },
      { ...valid, artifactGenerationId: randomUUID() },
      { ...valid, origin: 'MANUAL' as const },
      { ...valid, artifactSha256: 'b'.repeat(64) },
      { ...valid, sizeBytes: 2048 },
      { ...valid, remoteKey: 'other/key' },
      { ...valid, before: timeAt(T0 + 1000) },
    ];
    for (const proof of bad) {
      await expect(service.recordVerification(run.id, {
        remoteKey: run.key, sizeBytes: 1024, sha256: run.sha, proof,
      }, run.token)).rejects.toThrow();
    }
    const row = await repository.findRunById(run.id);
    expect(row?.verificationTimeEvidence).toBeNull();
  });

  it('never synthesizes a before when the generation evidence was lost', async () => {
    const run = await insertRun({ phase: 'DATABASE_DUMP', generation: true, before: null, remote: false });
    // Advance to REMOTE_VERIFY with remote fields directly; this models a lost
    // original sample rather than a real remote attempt.
    await pool.query(
      `UPDATE backup_runs
          SET phase = 'REMOTE_VERIFY', remote_key = $2, size_bytes = 1024, sha256 = $3
        WHERE id = $1`,
      [run.id, run.key, run.sha],
    );
    await expect(service.recordVerification(run.id, {
      remoteKey: run.key, sizeBytes: 1024, sha256: run.sha,
      proof: proofFor({ ...run, before: timeAt(T0) }),
    }, run.token)).rejects.toThrow();

    await service.recordVerification(run.id, {
      remoteKey: run.key, sizeBytes: 1024, sha256: run.sha, proof: null,
    }, run.token);
    await service.advancePhase(run.id, 'CLEANUP', false, run.token);
    const completed = await service.completeRun(run.id, {}, run.token);
    expect(completed.status).toBe('SUCCESS');
    expect(completed.verificationTimeEvidence).toBeNull();
    expect(completed.verifiedAt).not.toBeNull();
  });

  it('completes a NULL-evidence CLEANUP row through recovery without blocking the active slot', async () => {
    const run = await insertRun({
      phase: 'CLEANUP',
      leaseUntil: new Date(Date.now() - 60_000),
    });
    const claim = await repository.claimExpiredCleanupRun(new Date(), randomUUID(), new Date(Date.now() + 60_000));
    expect(claim?.run.id).toBe(run.id);
    const completed = await service.completeRun(run.id, {}, claim!.leaseToken);
    expect(completed.status).toBe('SUCCESS');
    expect(completed.verificationTimeEvidence).toBeNull();

    const nextId = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY')`,
      [nextId],
    );
    await expect(repository.claimNextRun(
      new Date(), randomUUID(), new Date(Date.now() + 60_000),
    )).resolves.toMatchObject({ run: { id: nextId } });
  });

  it('does not falsely recover a CLEANUP row without complete remote evidence', async () => {
    const run = await insertRun({
      phase: 'CLEANUP',
      remote: false,
      leaseUntil: new Date(Date.now() - 60_000),
    });
    await expect(repository.claimExpiredCleanupRun(
      new Date(), randomUUID(), new Date(Date.now() + 60_000),
    )).resolves.toBeNull();
    const recovered = await repository.recoverExpiredRuns(new Date());
    expect(recovered.map((item) => item.id)).toContain(run.id);
    const failed = await repository.findRunById(run.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.failureCode).toBe('WORKER_LOST');
  });

  it('writes worker and scheduler evidence atomically and never advances on a failed sample', async () => {
    await repository.touchWorkerAndSchedulerHeartbeat(new Date(T0), timeAt(T0));
    let state = await repository.getWorkerState();
    expect(state?.workerHeartbeatAt?.toISOString()).toBe(new Date(T0).toISOString());
    expect(state?.schedulerLastTickAt?.toISOString()).toBe(new Date(T0).toISOString());
    expect(state?.workerHeartbeatTimeEvidence?.wallAtUTC).toBe(new Date(T0).toISOString());
    expect(state?.schedulerLastTickTimeEvidence?.wallAtUTC).toBe(new Date(T0).toISOString());

    const before = JSON.stringify(state);
    await repository.touchWorkerAndSchedulerHeartbeat(null, null);
    state = await repository.getWorkerState();
    expect(JSON.stringify(state)).toBe(before);

    await repository.touchWorkerHeartbeat(new Date(T0 + HOUR), timeAt(T0 + HOUR));
    state = await repository.getWorkerState();
    expect(state?.workerHeartbeatAt?.toISOString()).toBe(new Date(T0 + HOUR).toISOString());
    expect(state?.schedulerLastTickAt?.toISOString()).toBe(new Date(T0).toISOString());

    await expect(repository.touchWorkerAndSchedulerHeartbeat(
      new Date(T0 + 2 * HOUR),
      legacyTimeAt(T0 + 2 * HOUR) as never,
    )).rejects.toThrow();
  });

  it('covers created, already-consumed, and blocked scheduler branches with evidence', async () => {
    const input = {
      id: randomUUID(),
      scope: 'DATABASE' as const,
      retentionClass: 'DAILY' as const,
      createdAt: new Date(T0),
      slotKey: 'Europe/Istanbul|2026-11-04|02:30',
      localDate: '2026-11-04',
      scheduledFor: new Date(T0),
    };
    const created = await repository.enqueueScheduledRun(input, new Date(T0), timeAt(T0));
    expect(created.kind).toBe('created');
    let state = await repository.getWorkerState();
    expect(state?.schedulerLastTickTimeEvidence?.wallAtUTC).toBe(new Date(T0).toISOString());

    const consumed = await repository.enqueueScheduledRun(
      { ...input, id: randomUUID() },
      new Date(T0 + MIN),
      timeAt(T0 + MIN),
    );
    expect(consumed.kind).toBe('already-consumed');
    state = await repository.getWorkerState();
    expect(state?.schedulerLastTickAt?.toISOString()).toBe(new Date(T0 + MIN).toISOString());

    await pool.query(
      `UPDATE backup_worker_state
          SET last_scheduled_slot_key = NULL, last_scheduled_local_date = NULL,
              last_scheduled_for = NULL, last_scheduled_run_id = NULL
        WHERE singleton`,
    );
    await pool.query('DELETE FROM backup_runs');
    await pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY')`,
      [randomUUID()],
    );
    const blocked = await repository.enqueueScheduledRun(
      { ...input, id: randomUUID(), slotKey: 'other-slot', localDate: '2026-11-05' },
      new Date(T0 + 2 * MIN),
      timeAt(T0 + 2 * MIN),
    );
    expect(blocked.kind).toBe('blocked');
    state = await repository.getWorkerState();
    expect(state?.schedulerLastTickAt?.toISOString()).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  it('does not advance the scheduler tick when no valid sample exists', async () => {
    const input = {
      id: randomUUID(),
      scope: 'DATABASE' as const,
      retentionClass: 'DAILY' as const,
      createdAt: new Date(T0),
      slotKey: 'Europe/Istanbul|2026-11-04|02:30',
      localDate: '2026-11-04',
      scheduledFor: new Date(T0),
    };
    const created = await repository.enqueueScheduledRun(input, null, null);
    expect(created.kind).toBe('created');
    const state = await repository.getWorkerState();
    expect(state?.schedulerLastTickAt).toBeNull();
    expect(state?.schedulerLastTickTimeEvidence).toBeNull();
  });

  it('keeps the same local-day slot consumed across a boot identity change', async () => {
    const input = {
      id: randomUUID(),
      scope: 'DATABASE' as const,
      retentionClass: 'DAILY' as const,
      createdAt: new Date(T0),
      slotKey: 'Europe/Istanbul|2026-11-04|02:30',
      localDate: '2026-11-04',
      scheduledFor: new Date(T0),
    };
    await repository.enqueueScheduledRun(input, new Date(T0), timeAt(T0));
    const rowsBefore = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM backup_runs',
    );
    const nextBootEvidence = timeAt(T0 + MIN, {
      bootId: '22222222-2222-4222-8222-222222222222',
    });
    const result = await repository.enqueueScheduledRun(
      { ...input, id: randomUUID() },
      new Date(T0 + MIN),
      nextBootEvidence,
    );
    expect(result.kind).toBe('already-consumed');
    const rowsAfter = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM backup_runs',
    );
    expect(rowsAfter.rows[0]?.count).toBe(rowsBefore.rows[0]?.count);
    const state = await repository.getWorkerState();
    expect(state?.lastScheduledSlotKey).toBe(input.slotKey);
    expect(state?.schedulerLastTickTimeEvidence?.bootId)
      .toBe('22222222-2222-4222-8222-222222222222');
  });

  it('keeps a 27h retry stale and a genuinely new dump healthy', async () => {
    const old = await insertRun();
    await service.recordVerification(old.id, {
      remoteKey: old.key, sizeBytes: 1024, sha256: old.sha, proof: proofFor(old),
    }, old.token);
    await service.advancePhase(old.id, 'CLEANUP', false, old.token);
    await service.completeRun(old.id, {}, old.token);
    expect((await healthStatus(timeAt(T0 + 27 * HOUR))).providerStatus).toBe('stale');

    // Same generation, new remote attempt 27h later: the proof binding still
    // carries the original before, so it cannot become fresh.
    await pool.query('DELETE FROM backup_runs');
    const retry = await insertRun();
    await service.recordVerification(retry.id, {
      remoteKey: retry.key,
      sizeBytes: 1024,
      sha256: retry.sha,
      proof: proofFor(retry, timeAt(T0 + 27 * HOUR)),
    }, retry.token);
    await service.advancePhase(retry.id, 'CLEANUP', false, retry.token);
    await service.completeRun(retry.id, {}, retry.token);
    expect((await healthStatus(timeAt(T0 + 27 * HOUR))).providerStatus).toBe('stale');

    // A genuinely new dump generation starts at T0+27h and is healthy.
    await pool.query('DELETE FROM backup_runs');
    const freshBefore = timeAt(T0 + 27 * HOUR);
    const fresh = await insertRun({ before: freshBefore });
    await service.recordVerification(fresh.id, {
      remoteKey: fresh.key,
      sizeBytes: 1024,
      sha256: fresh.sha,
      proof: proofFor(fresh, timeAt(T0 + 27 * HOUR + MIN)),
    }, fresh.token);
    await service.advancePhase(fresh.id, 'CLEANUP', false, fresh.token);
    await service.completeRun(fresh.id, {}, fresh.token);
    expect((await healthStatus(timeAt(T0 + 28 * HOUR))).providerStatus).toBe('healthy');
  });

  it('classifies a 20h re-encryption as healthy but the same generation at 27h as stale', async () => {
    const run = await insertRun();
    const reencryptedSha = 'c'.repeat(64);
    const proof = proofFor(run, timeAt(T0 + 20 * HOUR), { artifactSha256: reencryptedSha });
    await service.recordVerification(run.id, {
      remoteKey: run.key,
      sizeBytes: 1024,
      sha256: reencryptedSha,
      proof,
    }, run.token);
    await service.advancePhase(run.id, 'CLEANUP', false, run.token);
    await service.completeRun(run.id, {}, run.token);
    expect((await healthStatus(timeAt(T0 + 20 * HOUR))).providerStatus).toBe('healthy');
    expect((await healthStatus(timeAt(T0 + 27 * HOUR))).providerStatus).toBe('stale');
  });

  it('rejects cross-run generation adoption', async () => {
    const first = await insertRun({ phase: 'DATABASE_DUMP', generation: true, remote: false });
    await pool.query(
      `UPDATE backup_runs
          SET status = 'FAILED', failure_code = 'WORKER_LOST', failure_summary = 'test',
              completed_at = NOW(), lease_token = NULL, lease_until = NULL, heartbeat_at = NULL
        WHERE id = $1`,
      [first.id],
    );
    const second = await insertRun({ phase: 'DATABASE_DUMP', generation: true, remote: false });
    await expect(pool.query(
      `UPDATE backup_runs SET artifact_generation_id = $2 WHERE id = $1`,
      [second.id, first.generationId],
    )).rejects.toThrow(/immutable|duplicate key/);
  });

  it('keeps legacy SUCCESS rows readable but never healthy', async () => {
    await pool.query(
      `INSERT INTO backup_runs
        (id, status, origin, scope, retention_class, created_at, started_at, completed_at,
         remote_key, size_bytes, sha256, verified_at)
       VALUES ($1, 'SUCCESS', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), NOW(),
               $2, 1024, $3, NOW())`,
      [randomUUID(), `legacy/${randomUUID()}.sbk.age`, 'd'.repeat(64)],
    );
    const result = await healthStatus(timeAt(T0 + HOUR));
    expect(result.providerStatus).toBe('unavailable');
    expect(result.latestScheduledVerifiedAt).not.toBeNull();
  });
});
