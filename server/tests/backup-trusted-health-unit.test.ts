import { describe, expect, it } from 'vitest';

import { createPostgresBackupHealth } from '../src/modules/health/postgres-backup-health.js';
import { evaluateBr5PositiveHealthAdmission } from '../src/modules/backup/freshness-policy.js';
import type { BackupVerificationProof } from '../src/modules/backup/trusted-evidence.js';
import { timeAt } from './backup-time-fixture.js';

const T0 = Date.parse('2026-11-04T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOTE_ATTEMPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHA = 'd'.repeat(64);
const REMOTE_KEY = `production/instance/v1/scheduled/${RUN_ID}.sbk.age`;

type Row = {
  id?: string;
  status?: string;
  origin?: string;
  verified_at?: Date | null;
  remote_key?: string | null;
  size_bytes?: string | number | null;
  sha256?: string | null;
  artifact_generation_id?: string | null;
  artifact_generation_time_evidence?: unknown;
  verification_time_evidence?: unknown;
  worker_heartbeat_at?: Date | null;
  scheduler_last_tick_at?: Date | null;
  worker_heartbeat_time_evidence?: unknown;
  scheduler_last_tick_time_evidence?: unknown;
  active?: boolean;
};

function proof(overrides: Partial<BackupVerificationProof> = {}): BackupVerificationProof {
  const before = timeAt(T0);
  const after = timeAt(T0 + MIN);
  return {
    proofVersion: 2,
    runId: RUN_ID,
    artifactGenerationId: GENERATION_ID,
    artifactSha256: SHA,
    sizeBytes: 1024,
    remoteAttemptId: REMOTE_ATTEMPT_ID,
    origin: 'SCHEDULED',
    remoteKey: REMOTE_KEY,
    generationStartedAt: before.wallAtUTC,
    verificationAttemptStartedAt: new Date(T0 + 30_000).toISOString(),
    verifiedAt: after.wallAtUTC,
    before,
    after,
    ...overrides,
  };
}

function verifiedRow(overrides: Partial<Row> = {}): Row {
  const p = proof();
  return {
    id: RUN_ID,
    status: 'SUCCESS',
    origin: 'SCHEDULED',
    verified_at: new Date(p.verifiedAt),
    remote_key: REMOTE_KEY,
    size_bytes: 1024,
    sha256: SHA,
    artifact_generation_id: GENERATION_ID,
    artifact_generation_time_evidence: p.before,
    verification_time_evidence: p,
    ...overrides,
  };
}

function poolFixture(row: {
  latestVerified?: Row | null;
  scheduledVerified?: Row | null;
  latestStatus?: string | null;
  scheduledStatus?: string | null;
  scheduledPointer?: { id: string; status: string; origin: string } | null;
  worker?: Row | null;
  activeRunning?: boolean;
}) {
  return {
    query: async (sql: string) => {
      if (sql.includes('active_running')) return { rows: [{ active: row.activeRunning === true }] };
      if (sql.includes('scheduled_verified')) {
        return { rows: row.scheduledVerified ? [row.scheduledVerified] : [] };
      }
      if (sql.includes('latest_verified')) {
        return { rows: row.latestVerified ? [row.latestVerified] : [] };
      }
      if (sql.includes('scheduled_pointer_run')) {
        const pointer = row.scheduledPointer === undefined
          ? (row.scheduledStatus ? { id: RUN_ID, status: row.scheduledStatus, origin: 'SCHEDULED' } : null)
          : row.scheduledPointer;
        return {
          rows: [pointer
            ? {
              scheduled_pointer_id: pointer.id,
              scheduled_pointer_status: pointer.status,
              scheduled_pointer_origin: pointer.origin,
            }
            : {
              scheduled_pointer_id: null,
              scheduled_pointer_status: null,
              scheduled_pointer_origin: null,
            }],
        };
      }
      if (sql.includes('latest_run_status')) {
        return { rows: row.latestStatus ? [{ status: row.latestStatus }] : [] };
      }
      if (sql.includes('backup_worker_state')) {
        return {
          rows: [row.worker ?? {
            worker_heartbeat_at: null,
            scheduler_last_tick_at: null,
            worker_heartbeat_time_evidence: null,
            scheduler_last_tick_time_evidence: null,
          }],
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

async function health(options: {
  row: Parameters<typeof poolFixture>[0];
  current: ReturnType<typeof timeAt>;
  workerEnabled?: boolean;
  defaultThreshold?: boolean;
}) {
  const reader = createPostgresBackupHealth(poolFixture(options.row) as never, {
    workerEnabled: options.workerEnabled ?? true,
    ...(options.defaultThreshold
      ? {}
      : { workerStaleAfterMs: 2 * MIN, schedulerStaleAfterMs: 2 * MIN }),
    sampleTime: async () => options.current,
  });
  return reader.check();
}

function freshWorker(current: number): Row {
  return workerAt(current - MIN);
}

function workerAt(at: number): Row {
  return {
    worker_heartbeat_at: new Date(at),
    scheduler_last_tick_at: new Date(at),
    worker_heartbeat_time_evidence: timeAt(at),
    scheduler_last_tick_time_evidence: timeAt(at),
  };
}

describe('BR5 trusted backup health reader', () => {
  it('keeps positive admission closed until qualified clock and producer evidence exist', () => {
    expect(evaluateBr5PositiveHealthAdmission()).toBe('BLOCKED');
  });

  it('does not promote a candidate fresh scheduled proof while OT3-C/D remain blocked', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.status).toBe('unavailable');
    expect(result.providerStatus).toBe('unavailable');
    expect(result.provider).toBe('br5-r2');
    expect(result.latestScheduledVerifiedAt).toBe(new Date(T0 + MIN).toISOString());
  });

  it('keeps 26h + 1 ms stale and treats exact 26h with uncertainty conservatively', async () => {
    // The 1 ms root-distance fixture is a real error bound, so exact 26h is
    // not provably <= 26h under the two-clock model. The uncertainty-free
    // positive boundary is covered in backup-trusted-evidence-unit.test.ts.
    const exact = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: freshWorker(T0 + 26 * HOUR),
      },
      current: timeAt(T0 + 26 * HOUR),
    });
    expect(exact.providerStatus).toBe('unavailable');

    const over = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: freshWorker(T0 + 26 * HOUR + 1),
      },
      current: timeAt(T0 + 26 * HOUR + 1),
    });
    expect(over.providerStatus).toBe('stale');
    expect(over.status).toBe('unavailable');
  });

  it('never lets a manual run satisfy scheduled freshness', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow({ origin: 'MANUAL' }),
        scheduledVerified: null,
        latestStatus: 'SUCCESS',
        scheduledStatus: null,
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.providerStatus).toBe('unavailable');
    expect(result.status).toBe('unavailable');
  });

  it('gives an explicit scheduled failure priority over a fresh prior proof', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'FAILED',
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.providerStatus).toBe('failed');
    expect(result.status).toBe('unavailable');
  });

  it('uses the durable scheduled pointer instead of wall-clock ordering', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        scheduledPointer: {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          status: 'FAILED',
          origin: 'SCHEDULED',
        },
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.latestScheduledRunStatus).toBe('FAILED');
    expect(result.providerStatus).toBe('failed');
    expect(result.status).toBe('unavailable');
  });

  it('fails closed when the durable scheduled pointer is missing', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledPointer: null,
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.latestScheduledRunStatus).toBeNull();
    expect(result.providerStatus).toBe('unavailable');
    expect(result.status).toBe('unavailable');
  });

  it('fails closed when the durable pointer references a non-scheduled run', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledPointer: {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          status: 'SUCCESS',
          origin: 'MANUAL',
        },
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.latestScheduledRunStatus).toBeNull();
    expect(result.providerStatus).toBe('unavailable');
  });

  it('preserves RUNNING status and prior proof without authorizing positive health', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'RUNNING',
        scheduledStatus: 'RUNNING',
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    expect(result.providerStatus).toBe('unavailable');
    expect(result.latestScheduledRunStatus).toBe('RUNNING');
  });

  it('requires both worker and scheduler liveness independently', async () => {
    const current = T0 + HOUR;
    const staleWorker = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: {
          ...freshWorker(current),
          worker_heartbeat_at: new Date(current - 3 * MIN),
          worker_heartbeat_time_evidence: timeAt(current - 3 * MIN),
        },
      },
      current: timeAt(current),
    });
    expect(staleWorker.providerStatus).toBe('unavailable');

    const staleScheduler = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: {
          ...freshWorker(current),
          scheduler_last_tick_at: new Date(current - 3 * MIN),
          scheduler_last_tick_time_evidence: timeAt(current - 3 * MIN),
        },
      },
      current: timeAt(current),
    });
    expect(staleScheduler.providerStatus).toBe('unavailable');
  });

  it('uses the 120s default liveness window and fails closed beyond it', async () => {
    const current = T0 + HOUR;
    const at119 = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: workerAt(current - 119_000),
      },
      current: timeAt(current),
      defaultThreshold: true,
    });
    expect(at119.providerStatus).toBe('unavailable'); // Candidate liveness alone is not admission.

    const at121 = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: workerAt(current - 121_000),
      },
      current: timeAt(current),
      defaultThreshold: true,
    });
    expect(at121.providerStatus).toBe('unavailable');
    expect(at121.status).toBe('unavailable');
  });

  it('does not turn an active-run scheduler exception into unqualified positive health', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'RUNNING',
        scheduledStatus: 'RUNNING',
        worker: {
          ...freshWorker(current),
          scheduler_last_tick_at: new Date(current - 3 * MIN),
          scheduler_last_tick_time_evidence: timeAt(current - 3 * MIN),
        },
        activeRunning: true,
      },
      current: timeAt(current),
    });
    expect(result.providerStatus).toBe('unavailable');
  });

  it('removes the exception when the worker heartbeat is stale or no run is active', async () => {
    const current = T0 + HOUR;
    const staleWorker = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'RUNNING',
        scheduledStatus: 'RUNNING',
        worker: {
          ...freshWorker(current),
          worker_heartbeat_at: new Date(current - 3 * MIN),
          worker_heartbeat_time_evidence: timeAt(current - 3 * MIN),
        },
        activeRunning: true,
      },
      current: timeAt(current),
    });
    expect(staleWorker.providerStatus).toBe('unavailable');

    const inactive = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: {
          ...freshWorker(current),
          scheduler_last_tick_at: new Date(current - 3 * MIN),
          scheduler_last_tick_time_evidence: timeAt(current - 3 * MIN),
        },
        activeRunning: false,
      },
      current: timeAt(current),
    });
    expect(inactive.providerStatus).toBe('unavailable');
  });

  it('never uses workerEnabled=false as a positive-health maintenance bypass', async () => {
    const current = T0 + HOUR;
    const fresh = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: null,
      },
      current: timeAt(current),
      workerEnabled: false,
    });
    expect(fresh.providerStatus).toBe('unavailable');

    const stale = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: null,
      },
      current: timeAt(T0 + 27 * HOUR),
      workerEnabled: false,
    });
    expect(stale.providerStatus).toBe('stale');
  });

  it('treats a legacy heartbeat timestamp without evidence as unavailable', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: {
          worker_heartbeat_at: new Date(current - MIN),
          scheduler_last_tick_at: new Date(current - MIN),
          worker_heartbeat_time_evidence: null,
          scheduler_last_tick_time_evidence: null,
        },
      },
      current: timeAt(current),
    });
    expect(result.providerStatus).toBe('unavailable');
  });

  it('rejects heartbeat evidence whose timestamp does not match', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: {
          worker_heartbeat_at: new Date(current - MIN),
          scheduler_last_tick_at: new Date(current - MIN),
          worker_heartbeat_time_evidence: timeAt(current - 2 * MIN),
          scheduler_last_tick_time_evidence: timeAt(current - MIN),
        },
      },
      current: timeAt(current),
    });
    expect(result.providerStatus).toBe('unavailable');
  });

  it('fails closed for legacy, missing, invalid, cross-boot, and future proof evidence', async () => {
    const current = T0 + HOUR;
    const base = {
      latestVerified: verifiedRow(),
      scheduledVerified: verifiedRow(),
      latestStatus: 'SUCCESS',
      scheduledStatus: 'SUCCESS',
      worker: freshWorker(current),
    };
    const invalidProof = await health({
      row: {
        ...base,
        scheduledVerified: verifiedRow({
          verification_time_evidence: { ...proof(), proofVersion: 1 },
        }),
      },
      current: timeAt(current),
    });
    expect(invalidProof.providerStatus).toBe('unavailable');

    const missingProof = await health({
      row: {
        ...base,
        scheduledVerified: verifiedRow({ verification_time_evidence: null }),
      },
      current: timeAt(current),
    });
    expect(missingProof.providerStatus).toBe('unavailable');

    const crossBoot = await health({
      row: {
        ...base,
        scheduledVerified: verifiedRow(),
      },
      current: timeAt(current, { bootId: '11111111-1111-4111-8111-111111111119' }),
    });
    expect(crossBoot.providerStatus).toBe('unavailable');

    const futureAfter = await health({
      row: {
        ...base,
        scheduledVerified: verifiedRow({
          verification_time_evidence: proof({
            after: timeAt(T0 + 2 * HOUR),
            verifiedAt: new Date(T0 + 2 * HOUR).toISOString(),
          }),
          verified_at: new Date(T0 + 2 * HOUR),
        }),
      },
      current: timeAt(current),
    });
    expect(futureAfter.providerStatus).toBe('unavailable');
  });

  it('does not expose raw proof, boot, namespace, object key, or hash fields', async () => {
    const current = T0 + HOUR;
    const result = await health({
      row: {
        latestVerified: verifiedRow(),
        scheduledVerified: verifiedRow(),
        latestStatus: 'SUCCESS',
        scheduledStatus: 'SUCCESS',
        worker: freshWorker(current),
      },
      current: timeAt(current),
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'bootId', 'timeNamespaceId', 'sourcePolicy', 'configSha256', 'quorum',
      'artifactGenerationId', 'remoteAttemptId', 'remoteKey', 'sha256',
      'verificationTimeEvidence', 'workerHeartbeatTimeEvidence',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
