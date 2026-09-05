import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  hashSessionToken,
  createSessionToken,
} from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import {
  InMemoryRealtimeEventBus,
} from '../src/modules/realtime/event-bus.js';
import {
  PostgresRealtimeEventTransaction,
  PostgresRealtimeEventRepository,
} from '../src/modules/realtime/repository.js';
import { RealtimeService } from '../src/modules/realtime/service.js';
import type { RealtimeEventInput } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const testConfig = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-in-realtime-test',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 5,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const,
  healthSchemaVersion: null,
  releaseSha: 'dev',
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2_000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8_000,
  webPush: {
    enabled: false,
    vapidSubject: null,
    vapidPublicKey: null,
    vapidPrivateKey: null,
  },
};

type StreamClient = {
  frames: string[];
  nextFrame(): Promise<string>;
  ended: Promise<void>;
  abort(): Promise<void>;
};

type Fixture = {
  pool: Pool;
  url: string;
  organizationId: string;
  otherOrganizationId: string;
  revokedUserId: string;
  sameOrganizationUserId: string;
  otherOrganizationUserId: string;
  jobCardId: string;
  otherJobCardId: string;
  revokedToken: string;
  realtime: RealtimeService;
  bus: InMemoryRealtimeEventBus;
};

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function openSse(url: string, rawToken: string): Promise<StreamClient> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { cookie: `servora_session=${rawToken}` },
    signal: controller.signal,
  });
  if (response.status !== 200 || !response.body) {
    controller.abort();
    throw new Error(`Expected SSE 200, received ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  const queuedWaiters: Array<{
    resolve: (frame: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  let buffer = '';
  let done = false;
  let nextFrameIndex = 0;
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });

  const pushFrame = (frame: string) => {
    frames.push(frame);
    const waiter = queuedWaiters.shift();
    if (waiter) {
      nextFrameIndex += 1;
      waiter.resolve(frame);
    }
  };

  void (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (true) {
          const separator = buffer.indexOf('\n\n');
          if (separator < 0) break;
          pushFrame(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const waiter of queuedWaiters.splice(0)) waiter.reject(error);
      }
    } finally {
      done = true;
      resolveEnded();
      for (const waiter of queuedWaiters.splice(0)) {
        waiter.reject(new Error('SSE stream ended before the next frame'));
      }
    }
  })();

  return {
    frames,
    nextFrame() {
      if (nextFrameIndex < frames.length) {
        const frame = frames[nextFrameIndex]!;
        nextFrameIndex += 1;
        return Promise.resolve(frame);
      }
      if (done) return Promise.reject(new Error('SSE stream has ended'));
      return new Promise<string>((resolve, reject) => {
        queuedWaiters.push({ resolve, reject });
      });
    },
    ended,
    async abort() {
      controller.abort();
      await ended;
    },
  };
}

async function createUser(pool: Pool, organizationId: string, name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'unused-test-hash', 'STAFF')
     RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`],
  )).rows[0]!.id;
}

async function createSession(pool: Pool, userId: string) {
  const token = createSessionToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token.tokenHash, new Date(Date.now() + 3_600_000)],
  );
  return token.rawToken;
}

async function createJobCard(pool: Pool, organizationId: string, userId: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title, assigned_to, created_by
     ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'Realtime acceptance job', $2, $2)
     RETURNING id`,
    [organizationId, userId],
  )).rows[0]!.id;
}

async function appendAndPublish(
  pool: Pool,
  bus: InMemoryRealtimeEventBus,
  jobCardId: string,
  input: RealtimeEventInput,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activity = await client.query<{ id: string }>(
      `INSERT INTO job_card_activity_logs (
         organization_id, job_card_id, event_type, client_action_id
       ) VALUES ($1, $2, 'JOB_FIELDS_UPDATED', $3)
       RETURNING id`,
      [input.organizationId, jobCardId, randomUUID()],
    );
    const event = await new PostgresRealtimeEventTransaction(client).append({
      ...input,
      sourceActivityId: activity.rows[0]!.id,
      entityId: jobCardId,
    });
    await client.query('COMMIT');
    bus.publish(event);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function expectUnauthorized(url: string, token: string) {
  const response = await fetch(url, {
    headers: { cookie: `servora_session=${token}` },
  });
  expect(response.status).toBe(401);
  await response.body?.cancel();
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `realtime_revoke_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    const migrationDirectory = new URL('../src/db/migrations/', import.meta.url);
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const migration of migrations) {
      await pool.query(await readFile(new URL(migration, migrationDirectory), 'utf8'));
    }

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Realtime revoke A') RETURNING id`,
    )).rows[0]!.id;
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Realtime revoke B') RETURNING id`,
    )).rows[0]!.id;
    const revokedUserId = await createUser(pool, organizationId, 'Revoked staff');
    const sameOrganizationUserId = await createUser(pool, organizationId, 'Unaffected staff');
    const otherOrganizationUserId = await createUser(pool, otherOrganizationId, 'Other organization staff');
    const jobCardId = await createJobCard(pool, organizationId, revokedUserId);
    const otherJobCardId = await createJobCard(pool, otherOrganizationId, otherOrganizationUserId);
    const revokedToken = await createSession(pool, revokedUserId);

    const bus = new InMemoryRealtimeEventBus();
    const realtime = new RealtimeService(
      new PostgresRealtimeEventRepository(pool),
      bus,
    );
    const appConfig = { ...testConfig, databaseUrl: databaseUrl! };
    app = await buildApp(appConfig, {
      authRepository: new PostgresAuthRepository(pool),
      realtimeService: realtime,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address');

    await run({
      pool,
      url: `http://127.0.0.1:${address.port}/api/realtime/events`,
      organizationId,
      otherOrganizationId,
      revokedUserId,
      sameOrganizationUserId,
      otherOrganizationUserId,
      jobCardId,
      otherJobCardId,
      revokedToken,
      realtime,
      bus,
    });
  } finally {
    await app?.close();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

describe.skipIf(!databaseUrl)('Realtime user access revocation (PostgreSQL/Fastify/SSE)', () => {
  it('closes only revoked user streams and rejects revoked or inactive reconnects', async () => {
    await withFixture(async (fixture) => {
      const first = await openSse(fixture.url, fixture.revokedToken);
      const second = await openSse(fixture.url, fixture.revokedToken);
      const sameOrganization = await openSse(
        fixture.url,
        await createSession(fixture.pool, fixture.sameOrganizationUserId),
      );
      const otherOrganization = await openSse(
        fixture.url,
        await createSession(fixture.pool, fixture.otherOrganizationUserId),
      );

      try {
        expect((await withTimeout(first.nextFrame(), 'first initial SSE frame'))).toContain('sync.required');
        expect((await withTimeout(second.nextFrame(), 'second initial SSE frame'))).toContain('sync.required');
        expect((await withTimeout(sameOrganization.nextFrame(), 'same-organization initial SSE frame'))).toContain('sync.required');
        expect((await withTimeout(otherOrganization.nextFrame(), 'other-organization initial SSE frame'))).toContain('sync.required');

        const authRepository = new PostgresAuthRepository(fixture.pool);
        await authRepository.revokeSession(
          hashSessionToken(fixture.revokedToken),
          new Date(),
        );
        await expectUnauthorized(fixture.url, fixture.revokedToken);

        await fixture.pool.query(
          'UPDATE sessions SET revoked_at = NULL WHERE user_id = $1',
          [fixture.revokedUserId],
        );
        await fixture.pool.query(
          'UPDATE users SET is_active = FALSE WHERE id = $1',
          [fixture.revokedUserId],
        );
        await expectUnauthorized(fixture.url, fixture.revokedToken);

        await appendAndPublish(fixture.pool, fixture.bus, fixture.jobCardId, {
          organizationId: fixture.organizationId,
          type: 'job.updated',
          entityType: 'job-card',
          entityId: randomUUID(),
          actorUserId: null,
          audience: { roles: [], userIds: [fixture.revokedUserId] },
          resourceKeys: ['job-board'],
          occurredAt: new Date(),
        });
        expect((await withTimeout(first.nextFrame(), 'open stream before explicit disconnect'))).toContain('job.updated');
        expect((await withTimeout(second.nextFrame(), 'second open stream before explicit disconnect'))).toContain('job.updated');
        expect(fixture.realtime.disconnectUser(
          fixture.organizationId,
          fixture.revokedUserId,
        )).toBe(2);
        await withTimeout(first.ended, 'first network stream EOF');
        await withTimeout(second.ended, 'second network stream EOF');
        const firstFramesAtClose = first.frames.length;
        const secondFramesAtClose = second.frames.length;
        expect(fixture.realtime.disconnectUser(
          fixture.organizationId,
          fixture.revokedUserId,
        )).toBe(0);

        await appendAndPublish(fixture.pool, fixture.bus, fixture.jobCardId, {
          organizationId: fixture.organizationId,
          type: 'job.updated',
          entityType: 'job-card',
          entityId: randomUUID(),
          actorUserId: null,
          audience: { roles: [], userIds: [fixture.sameOrganizationUserId] },
          resourceKeys: ['job-board'],
          occurredAt: new Date(),
        });
        await appendAndPublish(fixture.pool, fixture.bus, fixture.otherJobCardId, {
          organizationId: fixture.otherOrganizationId,
          type: 'job.updated',
          entityType: 'job-card',
          entityId: randomUUID(),
          actorUserId: null,
          audience: { roles: [], userIds: [fixture.otherOrganizationUserId] },
          resourceKeys: ['job-board'],
          occurredAt: new Date(),
        });

        expect((await withTimeout(sameOrganization.nextFrame(), 'same-organization event'))).toContain('job.updated');
        expect((await withTimeout(otherOrganization.nextFrame(), 'other-organization event'))).toContain('job.updated');
        expect(first.frames.length).toBe(firstFramesAtClose);
        expect(second.frames.length).toBe(secondFramesAtClose);
      } finally {
        await Promise.all([
          first.abort(),
          second.abort(),
          sameOrganization.abort(),
          otherOrganization.abort(),
        ]);
      }
    });
  });
});
