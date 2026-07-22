import { createECDH, createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  fingerprintPushEndpoint,
  fingerprintPushSubscription,
  fingerprintVapidPublicKey,
  PostgresWebPushRepository,
  PostgresWebPushTransaction,
} from '../src/modules/web-push/repository.js';

describe('Web Push fingerprints', () => {
  it('hashes the canonical endpoint and subscription tuple deterministically', () => {
    const endpoint = 'https://fcm.googleapis.com/push/example';
    const p256dh = 'public-key';
    const auth = 'auth-secret';

    expect(fingerprintPushEndpoint(endpoint)).toBe(
      createHash('sha256').update(endpoint, 'utf8').digest('hex'),
    );
    expect(fingerprintPushSubscription({ endpoint, p256dh, auth })).toBe(
      createHash('sha256')
        .update(`${endpoint}\n${p256dh}\n${auth}`, 'utf8')
        .digest('hex'),
    );
  });

  it('hashes decoded VAPID public-key bytes rather than its encoded text', () => {
    const privateKey = Buffer.alloc(32, 0);
    privateKey[31] = 1;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    const publicKey = ecdh.getPublicKey();

    expect(fingerprintVapidPublicKey(publicKey.toString('base64url'))).toBe(
      createHash('sha256').update(publicKey).digest('hex'),
    );
  });
});

const subscriptionRow = {
  id: 'subscription-1',
  organization_id: 'organization-1',
  recipient_user_id: 'user-1',
  session_id: 'session-1',
  endpoint: 'https://fcm.googleapis.com/push/example',
  endpoint_hash: 'a'.repeat(64),
  p256dh: 'public-key',
  auth: 'auth-secret',
  expiration_time: null,
  vapid_public_key_fingerprint: 'b'.repeat(64),
  created_at: new Date('2026-07-22T08:00:00.000Z'),
  updated_at: new Date('2026-07-22T08:00:00.000Z'),
  disabled_at: null,
  disabled_reason: null,
  last_success_at: null,
  last_failure_at: null,
  consecutive_failures: 0,
};

describe('Postgres Web Push repository', () => {
  it('finds only the current recipient session and derives its safe fingerprint', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [subscriptionRow] });
    const repository = new PostgresWebPushRepository({ query } as never);

    const result = await repository.findCurrentSession({
      organizationId: 'organization-1',
      userId: 'user-1',
      sessionId: 'session-1',
    });

    expect(query.mock.calls[0]?.[0]).toMatch(/organization_id = \$1[\s\S]*recipient_user_id = \$2[\s\S]*session_id = \$3/i);
    expect(query.mock.calls[0]?.[1]).toEqual([
      'organization-1',
      'user-1',
      'session-1',
    ]);
    expect(result).toMatchObject({
      id: 'subscription-1',
      subscriptionFingerprint: fingerprintPushSubscription({
        endpoint: subscriptionRow.endpoint,
        p256dh: subscriptionRow.p256dh,
        auth: subscriptionRow.auth,
      }),
    });
  });

  it('disables idempotently only inside organization, recipient, and session scope', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [
          {
            ...subscriptionRow,
            disabled_at: new Date('2026-07-22T09:00:00.000Z'),
            disabled_reason: 'USER_DISABLED',
          },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const repository = new PostgresWebPushRepository({
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    } as never);
    const at = new Date('2026-07-22T09:00:00.000Z');

    await expect(repository.disable({
      organizationId: 'organization-1',
      userId: 'user-1',
      sessionId: 'session-1',
    }, 'subscription-1', 'USER_DISABLED', at)).resolves.toMatchObject({
      disabledReason: 'USER_DISABLED',
    });

    expect(client.query.mock.calls[1]?.[0]).toMatch(/disabled_at = COALESCE\(disabled_at, \$5\)[\s\S]*organization_id = \$1[\s\S]*recipient_user_id = \$2[\s\S]*session_id = \$3[\s\S]*id = \$4/i);
    expect(client.query.mock.calls[1]?.[1]).toEqual([
      'organization-1', 'user-1', 'session-1', 'subscription-1', at,
      'USER_DISABLED',
    ]);
    expect(client.query.mock.calls[2]?.[0]).toMatch(
      /UPDATE web_push_deliveries[\s\S]*state = 'ABANDONED'/i,
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('locks endpoint ownership and inserts one current-session subscription', async () => {
    const inserted = {
      ...subscriptionRow,
      endpoint_hash: fingerprintPushEndpoint(subscriptionRow.endpoint),
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [inserted] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const repository = new PostgresWebPushRepository({
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    } as never);

    await expect(repository.upsert({
      organizationId: 'organization-1',
      userId: 'user-1',
      sessionId: 'session-1',
      endpoint: subscriptionRow.endpoint,
      p256dh: subscriptionRow.p256dh,
      auth: subscriptionRow.auth,
      expirationTime: null,
      vapidPublicKeyFingerprint: 'b'.repeat(64),
      now: new Date('2026-07-22T08:00:00.000Z'),
    })).resolves.toMatchObject({ id: 'subscription-1' });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/pg_advisory_xact_lock/i),
      expect.stringMatching(/FROM web_push_subscriptions[\s\S]*endpoint_hash = \$1[\s\S]*FOR UPDATE/i),
      expect.stringMatching(/FROM web_push_subscriptions[\s\S]*session_id = \$3[\s\S]*FOR UPDATE/i),
      expect.stringMatching(/INSERT INTO web_push_subscriptions/i),
      'COMMIT',
    ]);
    expect(client.query.mock.calls[1]?.[1]).toEqual([
      fingerprintPushEndpoint(subscriptionRow.endpoint),
    ]);
    expect(client.query.mock.calls[2]?.[1]).toEqual([
      fingerprintPushEndpoint(subscriptionRow.endpoint),
    ]);
  });

  it('disables inactive-session subscriptions and abandons their pending work transactionally', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'subscription-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const repository = new PostgresWebPushRepository({
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(client),
    } as never);

    await expect(repository.cleanupInactiveSessions(
      new Date('2026-07-22T10:00:00.000Z'),
    )).resolves.toBe(1);

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/UPDATE web_push_subscriptions[\s\S]*JOIN|UPDATE web_push_subscriptions[\s\S]*FROM sessions/i),
      expect.stringMatching(/UPDATE web_push_deliveries[\s\S]*ABANDONED/i),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('Postgres Web Push transaction', () => {
  it('appends delivery work only for exact notifications with active recipients and sessions', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'delivery-1' }] });
    const transaction = new PostgresWebPushTransaction({ query } as never);
    const at = new Date('2026-07-22T11:00:00.000Z');

    await expect(transaction.appendDeliveries({
      organizationId: 'organization-1',
      notificationIds: ['notification-1', 'notification-2'],
      at,
    })).resolves.toEqual(['delivery-1']);

    expect(query.mock.calls[0]?.[0]).toMatch(
      /INSERT INTO web_push_deliveries[\s\S]*JOIN web_push_subscriptions[\s\S]*JOIN users[\s\S]*JOIN sessions[\s\S]*ON CONFLICT \(notification_id, subscription_id\) DO NOTHING/i,
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      'organization-1',
      ['notification-1', 'notification-2'],
      at,
    ]);
  });

  it('does not query when there are no notification rows to project', async () => {
    const query = vi.fn();
    const transaction = new PostgresWebPushTransaction({ query } as never);

    await expect(transaction.appendDeliveries({
      organizationId: 'organization-1',
      notificationIds: [],
      at: new Date('2026-07-22T11:00:00.000Z'),
    })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
