import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { backupRoutes } from '../src/modules/backup/routes.js';
import type {
  BackupRepository,
  BackupTransaction,
  CreateQueuedBackupRunInput,
  CreateRestoreRunInput,
} from '../src/modules/backup/repository.js';
import { BackupService } from '../src/modules/backup/service.js';
import type {
  BackupPolicy,
  BackupPolicyUpdate,
  BackupRun,
  BackupRunPage,
  BackupRunPageQuery,
  BackupStorageState,
  BackupCursor,
  RestoreRun,
} from '../src/modules/backup/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userWith(role: SafeUser['role']): SafeUser {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    name: role,
    email: `${role.toLowerCase()}@test.local`,
    role,
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

class MemoryBackupRepository implements BackupRepository {
  runs: BackupRun[] = [];
  restoreRuns: RestoreRun[] = [];
  policy: BackupPolicy = {
    id: randomUUID(),
    enabled: false,
    scheduleTimeLocal: '02:30',
    timezone: 'UTC',
    dailyRetention: 7,
    weeklyRetention: 4,
    monthlyRetention: 6,
    defaultScope: 'DATABASE',
    updatedAt: new Date('2026-08-22T00:00:00Z'),
    updatedBy: null,
  };
  storage: BackupStorageState = {
    provider: 'CLOUDFLARE_R2',
    bucketAlias: null,
    prefix: 'production/',
    enabled: false,
    lastConnectionTestAt: null,
    lastConnectionTestOk: null,
  };
  claimed: string[] = [];

  private tx: BackupTransaction = {
    findActiveBackupRun: async () =>
      this.runs.find((run) => run.status === 'QUEUED' || run.status === 'RUNNING') ?? null,
    findActiveRestoreRun: async () =>
      this.restoreRuns.find((run) => run.status === 'RUNNING') ?? null,
    insertQueuedRun: async (input: CreateQueuedBackupRunInput) => {
      const run: BackupRun = {
        id: input.id,
        status: 'QUEUED',
        phase: null,
        origin: input.origin,
        scope: input.scope,
        retentionClass: input.retentionClass,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        startedAt: null,
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
      this.runs.push(run);
      return run;
    },
    updatePolicy: async (input: BackupPolicyUpdate, updatedBy: string | null, updatedAt: Date) => {
      this.policy = { ...this.policy, ...input, updatedBy, updatedAt };
      return this.policy;
    },
    appendAudit: async () => {},
  };

  async execute<T>(work: (tx: BackupTransaction) => Promise<T>): Promise<T> {
    return work(this.tx);
  }

  async executeCriticalAction<T>(
    claim: { organizationId: string; userId: string; clientActionId: string; operationKey: string },
    work: (tx: BackupTransaction) => Promise<T>,
  ): Promise<{ kind: 'completed'; response: T } | { kind: 'replay'; response: T } | { kind: 'processing' }> {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.claimed.includes(key)) {
      return { kind: 'processing' };
    }
    this.claimed.push(key);
    return { kind: 'completed', response: await work(this.tx) };
  }

  async findRunById(id: string) {
    return this.runs.find((run) => run.id === id) ?? null;
  }

  async listRuns(query: BackupRunPageQuery): Promise<BackupRunPage> {
    const sorted = [...this.runs].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? -1 : 1),
    );
    const start = query.cursor
      ? sorted.findIndex((run) => run.createdAt <= query.cursor!.createdAt && run.id !== query.cursor!.id)
      : 0;
    const slice = sorted.slice(Math.max(start, 0), Math.max(start, 0) + query.limit);
    const last = slice.at(-1);
    return {
      items: slice,
      nextCursor: sorted.length > Math.max(start, 0) + query.limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
    };
  }

  async findActiveBackupRun() {
    return this.runs.find((run) => run.status === 'QUEUED' || run.status === 'RUNNING') ?? null;
  }

  async getPolicy() {
    return this.policy;
  }

  async getStorageState() {
    return this.storage;
  }

  async recordStorageConnectionTest(ok: boolean, testedAt: Date) {
    this.storage = { ...this.storage, lastConnectionTestAt: testedAt, lastConnectionTestOk: ok };
  }

  async startRun(id: string, startedAt: Date) {
    const run = this.runs.find((candidate) => candidate.id === id && candidate.status === 'QUEUED');
    if (!run) return null;
    Object.assign(run, { status: 'RUNNING', phase: 'PREFLIGHT', startedAt });
    return run;
  }

  async advancePhase(id: string, _fromPhase: BackupRun['phase'], toPhase: NonNullable<BackupRun['phase']>, _filesArchiveRequired: boolean) {
    const run = this.runs.find((candidate) => candidate.id === id && candidate.status === 'RUNNING');
    if (!run) return null;
    run.phase = toPhase;
    return run;
  }

  async markFailed(id: string, failureCode: BackupRun['failureCode'], failureSummary: string, completedAt: Date) {
    const run = this.runs.find((candidate) => candidate.id === id && candidate.status === 'RUNNING');
    if (!run) return null;
    Object.assign(run, { status: 'FAILED', failureCode, failureSummary, completedAt });
    return run;
  }

  async markCancelled(id: string, completedAt: Date) {
    const run = this.runs.find(
      (candidate) => candidate.id === id && (candidate.status === 'QUEUED' || candidate.status === 'RUNNING'),
    );
    if (!run) return null;
    Object.assign(run, { status: 'CANCELLED', completedAt });
    return run;
  }

  async recordVerification(id: string, input: { remoteKey: string; sizeBytes: number; sha256: string }) {
    const run = this.runs.find(
      (candidate) => candidate.id === id && candidate.status === 'RUNNING' && candidate.phase === 'REMOTE_VERIFY',
    );
    if (!run) return null;
    Object.assign(run, { remoteKey: input.remoteKey, sizeBytes: input.sizeBytes, sha256: input.sha256 });
    return run;
  }

  async completeRun(id: string, input: { completedAt: Date; cleanupWarning: string | null }) {
    const run = this.runs.find(
      (candidate) => candidate.id === id && candidate.status === 'RUNNING' && candidate.phase === 'CLEANUP',
    );
    if (!run) return null;
    Object.assign(run, {
      status: 'SUCCESS',
      verifiedAt: input.completedAt,
      completedAt: input.completedAt,
      ...(input.cleanupWarning !== null
        ? { warningCode: 'CLEANUP_FAILED' as const, warningSummary: input.cleanupWarning }
        : {}),
    });
    return run;
  }

  async markCleanupWarning(id: string, warningSummary: string) {
    const run = this.runs.find((candidate) => candidate.id === id && candidate.status === 'SUCCESS');
    if (!run) return null;
    Object.assign(run, { warningCode: 'CLEANUP_FAILED', warningSummary });
    return run;
  }

  async createRestoreRun(input: CreateRestoreRunInput) {
    const run: RestoreRun = {
      id: input.id,
      backupId: input.backupId,
      mode: input.mode,
      status: 'RUNNING',
      startedAt: new Date(),
      completedAt: null,
      initiatedBy: input.initiatedBy,
      targetDatabase: input.targetDatabase,
      preRestoreBackupId: input.preRestoreBackupId,
      verificationResult: null,
      failureCode: null,
    };
    this.restoreRuns.push(run);
    return run;
  }

  async getRestoreRunById(id: string) {
    return this.restoreRuns.find((run) => run.id === id) ?? null;
  }
}

const apps: Array<ReturnType<typeof Fastify>> = [];

function createApp(
  user: SafeUser | null,
  storageProbe?: () => Promise<{ ok: true } | { ok: false; errorClass: 'CONFIG' | 'AUTH' | 'TRANSPORT' | 'SERVICE' | 'UNKNOWN' }>,
  storageRuntimeState?: { enabled: boolean; bucketAlias: string | null; prefix: string },
  now: () => Date = () => new Date(),
) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!user) throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
    request.currentUser = user;
  };
  const repository = new MemoryBackupRepository();
  const service = new BackupService(repository, now, storageRuntimeState ?? null);
  void app.register(backupRoutes, { prefix: '/api/admin', service, authenticate, ...(storageProbe ? { storageProbe } : {}) });
  apps.push(app);
  return { app, repository };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('backup admin routes', () => {
  const admin = userWith('ADMIN');
  const manager = userWith('MANAGER');
  const staff = userWith('STAFF');

  it('requires authentication', async () => {
    const { app } = createApp(null);
    const response = await app.inject({ method: 'GET', url: '/api/admin/backups' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('denies MANAGER and STAFF on every endpoint (backend-owned RBAC)', async () => {
    for (const denied of [manager, staff]) {
      const { app } = createApp(denied);
      for (const request of [
        { method: 'GET', url: '/api/admin/backups' },
        { method: 'GET', url: `/api/admin/backups/${randomUUID()}` },
        { method: 'GET', url: '/api/admin/backup-overview' },
        { method: 'POST', url: '/api/admin/backups', payload: { clientActionId: 'x' } },
        { method: 'GET', url: '/api/admin/backup-policy' },
        { method: 'PUT', url: '/api/admin/backup-policy', payload: policyPayload() },
        { method: 'GET', url: '/api/admin/backup-storage' },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  it('ADMIN: manual request returns 202 with a queued MANUAL run', async () => {
    const { app } = createApp(admin);
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      payload: { clientActionId: 'route-create-1' },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body).toMatchObject({
      status: 'QUEUED',
      origin: 'MANUAL',
      retentionClass: 'MANUAL',
      scope: 'DATABASE',
      createdBy: admin.id,
      formatVersion: 1,
    });
    expect(UUID.test(body.id)).toBe(true);
    expect(body.sha256).toBeNull();
    expect(body.verifiedAt).toBeNull();
  });

  it('ADMIN: request body validation and scope defaulting', async () => {
    const { app } = createApp(admin);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      payload: { clientActionId: 'x', retentionClass: 'DAILY' },
    });
    expect(unknown.statusCode).toBe(400);

    const missing = await app.inject({ method: 'POST', url: '/api/admin/backups', payload: {} });
    expect(missing.statusCode).toBe(400);

    const badScope = await app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      payload: { clientActionId: 'x', scope: 'EVERYTHING' },
    });
    expect(badScope.statusCode).toBe(400);

    const scoped = await app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      payload: { clientActionId: 'x', scope: 'FULL_DATA' },
    });
    expect(scoped.statusCode).toBe(202);
    expect(scoped.json()).toMatchObject({ scope: 'FULL_DATA' });
  });

  it('ADMIN: list is bounded, ordered newest-first, with encoded cursor', async () => {
    const { app, repository } = createApp(admin);
    for (let index = 0; index < 3; index += 1) {
      await repository.execute((tx) => tx.insertQueuedRun({
        id: randomUUID(),
        origin: 'MANUAL',
        scope: 'DATABASE',
        retentionClass: 'MANUAL',
        createdBy: admin.id,
        createdAt: new Date(Date.parse('2026-08-22T10:00:00Z') + index * 60_000),
      }));
    }
    const response = await app.inject({ method: 'GET', url: '/api/admin/backups?limit=2' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(new Date(body.items[0].createdAt).getTime()).toBeGreaterThan(new Date(body.items[1].createdAt).getTime());
    expect(typeof body.nextCursor).toBe('string');
    expect(body.items.every((item: { status: string }) => item.status === 'QUEUED')).toBe(true);

    const badLimit = await app.inject({ method: 'GET', url: '/api/admin/backups?limit=51' });
    expect(badLimit.statusCode).toBe(400);
    const badCursor = await app.inject({ method: 'GET', url: '/api/admin/backups?cursor=%3%3' });
    expect(badCursor.statusCode).toBe(400);
    const unknownQuery = await app.inject({ method: 'GET', url: '/api/admin/backups?status=ALL' });
    expect(unknownQuery.statusCode).toBe(400);
  });

  it('ADMIN: detail lookup validates ids and returns 404', async () => {
    const { app } = createApp(admin);
    const invalid = await app.inject({ method: 'GET', url: '/api/admin/backups/not-a-uuid' });
    expect(invalid.statusCode).toBe(404);
    const missing = await app.inject({ method: 'GET', url: `/api/admin/backups/${randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'BACKUP_NOT_FOUND' });
  });

  it('ADMIN: policy read/update with validation', async () => {
    const { app } = createApp(admin);
    const initial = await app.inject({ method: 'GET', url: '/api/admin/backup-policy' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ enabled: false, dailyRetention: 7, defaultScope: 'DATABASE' });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/admin/backup-policy',
      payload: policyPayload({ enabled: true, scheduleTimeLocal: '04:05', timezone: 'Europe/Istanbul' }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ enabled: true, scheduleTimeLocal: '04:05', timezone: 'Europe/Istanbul' });

    for (const bad of [
      policyPayload({ scheduleTimeLocal: '7:30' }),
      policyPayload({ timezone: 'Mars/Olympus' }),
      policyPayload({ dailyRetention: 'many' as never }),
      policyPayload({ defaultScope: 'ALL' as never }),
    ]) {
      const response = await app.inject({ method: 'PUT', url: '/api/admin/backup-policy', payload: bad });
      expect(response.statusCode).toBe(400);
    }

    const unknownField = await app.inject({
      method: 'PUT',
      url: '/api/admin/backup-policy',
      payload: { ...policyPayload(), cronExpression: '* * * * *' },
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it('ADMIN: overview exposes a safe next scheduled instant without scheduler math in the client', async () => {
    const { app, repository } = createApp(
      admin,
      undefined,
      undefined,
      () => new Date('2026-08-22T05:00:00.000Z'),
    );
    repository.policy = {
      ...repository.policy,
      enabled: true,
      scheduleTimeLocal: '04:05',
      timezone: 'UTC',
    };

    const response = await app.inject({ method: 'GET', url: '/api/admin/backup-overview' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      nextScheduledAt: '2026-08-23T04:05:00.000Z',
      scheduleTimezone: 'UTC',
      activeRun: null,
      lastVerifiedBackup: null,
      worker: null,
    });
  });

  it('ADMIN: overview returns active and verified summaries without remote object details', async () => {
    const { app, repository } = createApp(admin, undefined, undefined, () => new Date('2026-08-22T05:00:00.000Z'));
    const verified = await repository.execute((tx) => tx.insertQueuedRun({
      id: randomUUID(), origin: 'SCHEDULED', scope: 'DATABASE', retentionClass: 'DAILY',
      createdBy: admin.id, createdAt: new Date('2026-08-21T04:00:00.000Z'),
    }));
    Object.assign(verified, {
      status: 'SUCCESS', phase: 'CLEANUP', verifiedAt: new Date('2026-08-21T04:03:00.000Z'),
      completedAt: new Date('2026-08-21T04:03:00.000Z'), remoteKey: 'private/key',
      sizeBytes: 1024, sha256: 'a'.repeat(64),
    });
    await repository.execute((tx) => tx.insertQueuedRun({
      id: randomUUID(), origin: 'MANUAL', scope: 'FULL_DATA', retentionClass: 'MANUAL',
      createdBy: admin.id, createdAt: new Date('2026-08-22T04:00:00.000Z'),
    }));

    const response = await app.inject({ method: 'GET', url: '/api/admin/backup-overview' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.lastVerifiedBackup).toMatchObject({ id: verified.id, verifiedAt: '2026-08-21T04:03:00.000Z' });
    expect(body.activeRun).toMatchObject({ scope: 'FULL_DATA', status: 'QUEUED' });
    expect(body.lastVerifiedBackup).not.toHaveProperty('remoteKey');
    expect(body.lastVerifiedBackup).not.toHaveProperty('sha256');
  });

  it('ADMIN: storage state exposes safe configuration fields only', async () => {
    const { app } = createApp(admin);
    const response = await app.inject({ method: 'GET', url: '/api/admin/backup-storage' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: 'CLOUDFLARE_R2',
      bucketAlias: null,
      prefix: 'production/',
      enabled: false,
      lastConnectionTestAt: null,
      lastConnectionTestOk: null,
    });
  });

  it('ADMIN: storage state overlays only safe runtime configuration truth', async () => {
    const { app } = createApp(admin, undefined, {
      enabled: true,
      bucketAlias: 'Primary Backup Bucket',
      prefix: 'production/',
    });
    const response = await app.inject({ method: 'GET', url: '/api/admin/backup-storage' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: 'CLOUDFLARE_R2',
      bucketAlias: 'Primary Backup Bucket',
      prefix: 'production/',
      enabled: true,
      lastConnectionTestAt: null,
      lastConnectionTestOk: null,
    });
  });

  it('conflicts surface as canonical 409 responses', async () => {
    const { app } = createApp(admin);
    await app.inject({ method: 'POST', url: '/api/admin/backups', payload: { clientActionId: 'active-1' } });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      payload: { clientActionId: 'active-2' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'BACKUP_RUN_ACTIVE' });
  });
});

function policyPayload(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    scheduleTimeLocal: '02:30',
    timezone: 'UTC',
    dailyRetention: 7,
    weeklyRetention: 4,
    monthlyRetention: 6,
    defaultScope: 'DATABASE',
    ...overrides,
  };
}


describe('BR4 storage connection test route', () => {
  const admin = userWith('ADMIN');
  const manager = userWith('MANAGER');
  const staff = userWith('STAFF');

  it('ADMIN: successful probe persists safe state and returns no credentials', async () => {
    const { app, repository } = createApp(admin, async () => ({ ok: true }));
    const response = await app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; testedAt: string; failureClass?: string };
    expect(body.ok).toBe(true);
    expect(body.failureClass).toBeUndefined();
    expect(new Date(body.testedAt).toISOString()).toBe(body.testedAt);
    expect(JSON.stringify(body)).not.toMatch(/access|secret|key|credential/i);
    expect(repository.storage.lastConnectionTestOk).toBe(true);
    expect(repository.storage.lastConnectionTestAt).not.toBeNull();
  });

  it('ADMIN: failed probe persists ok=false with a safe failure class', async () => {
    const { app, repository } = createApp(admin, async () => ({ ok: false, errorClass: 'AUTH' }));
    const response = await app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; failureClass: string };
    expect(body.ok).toBe(false);
    expect(body.failureClass).toBe('AUTH');
    expect(repository.storage.lastConnectionTestOk).toBe(false);
    expect(repository.storage.lastConnectionTestAt).not.toBeNull();
  });

  it('ADMIN: unexpected probe errors persist a safe UNKNOWN failure', async () => {
    const { app, repository } = createApp(admin, async () => {
      throw new Error('raw SDK details that must not escape');
    });
    const response = await app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, failureClass: 'UNKNOWN' });
    expect(response.body).not.toContain('raw SDK details');
    expect(repository.storage.lastConnectionTestOk).toBe(false);
    expect(repository.storage.lastConnectionTestAt).not.toBeNull();
  });

  it('MANAGER and STAFF are forbidden', async () => {
    const managerApp = createApp(manager, async () => ({ ok: true }));
    const managerResponse = await managerApp.app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(managerResponse.statusCode).toBe(403);

    const staffApp = createApp(staff, async () => ({ ok: true }));
    const staffResponse = await staffApp.app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(staffResponse.statusCode).toBe(403);
  });

  it('unauthenticated requests are rejected', async () => {
    const { app } = createApp(null, async () => ({ ok: true }));
    const response = await app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(response.statusCode).toBe(401);
  });

  it('missing probe wiring yields BACKUP_STORAGE_UNAVAILABLE, not a fake success', async () => {
    const { app } = createApp(admin);
    const response = await app.inject({ method: 'POST', url: '/api/admin/backup-storage/test' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining('Yedekleme depolama yapılandırması'),
    });
  });
});
