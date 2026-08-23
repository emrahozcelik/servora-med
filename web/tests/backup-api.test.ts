import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/services/api';
import {
  getBackupHealth,
  listBackups,
  parseBackupOverview,
  requestManualBackup,
} from '../src/services/backup-api';

afterEach(() => vi.unstubAllGlobals());

const run = {
  id: 'run-1', status: 'SUCCESS', phase: 'CLEANUP', origin: 'MANUAL', scope: 'DATABASE',
  retentionClass: 'MANUAL', createdBy: 'admin-1', createdAt: '2026-08-22T04:00:00.000Z',
  startedAt: '2026-08-22T04:01:00.000Z', completedAt: '2026-08-22T04:03:00.000Z',
  formatVersion: 1, remoteKey: 'private/key', sizeBytes: 1024, sha256: 'a'.repeat(64),
  verifiedAt: '2026-08-22T04:03:00.000Z', warningCode: null, warningSummary: null,
  failureCode: null, failureSummary: null,
};

describe('backup API client', () => {
  it('keeps the overview projection safe and separate from remote object details', () => {
    const parsed = parseBackupOverview({
      lastVerifiedBackup: { ...run }, activeRun: null,
      nextScheduledAt: '2026-08-23T04:05:00.000Z', scheduleTimezone: 'UTC', worker: null,
    });
    expect(parsed.lastVerifiedBackup).not.toHaveProperty('remoteKey');
    expect(parsed.lastVerifiedBackup).not.toHaveProperty('sha256');
    expect(parsed.nextScheduledAt).toBe('2026-08-23T04:05:00.000Z');
  });

  it('sends one bounded keyset request with limit and cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [run], nextCursor: 'next-1' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listBackups({ limit: 20, cursor: 'cursor-1' })).resolves.toMatchObject({ nextCursor: 'next-1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/backups?limit=20&cursor=cursor-1', expect.objectContaining({ credentials: 'include' }));
  });

  it('preserves the async manual request body and surfaces queued state', async () => {
    const queued = { ...run, status: 'QUEUED', phase: null, verifiedAt: null };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(run), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(queued), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    await expect(requestManualBackup({ clientActionId: 'action-1', scope: 'DATABASE' })).resolves.toMatchObject({ status: 'QUEUED' });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/backups', expect.objectContaining({
      method: 'POST', credentials: 'include',
      body: JSON.stringify({ clientActionId: 'action-1', scope: 'DATABASE' }),
    }));
  });

  it('does not turn unavailable public health into a client-side healthy state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(getBackupHealth()).resolves.toBeNull();
  });

  it('rejects malformed overview payloads', () => {
    expect(() => parseBackupOverview({ nextScheduledAt: null })).toThrow(ApiError);
  });
});
