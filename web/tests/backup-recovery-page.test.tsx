/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackupRecoveryPage } from '../src/settings/BackupRecoveryPage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const policy = {
  id: 'policy-1', enabled: true, scheduleTimeLocal: '04:05', timezone: 'UTC',
  dailyRetention: 7, weeklyRetention: 4, monthlyRetention: 6, defaultScope: 'DATABASE',
  updatedAt: '2026-08-22T00:00:00.000Z', updatedBy: 'admin-1',
};
const storage = {
  provider: 'CLOUDFLARE_R2', bucketAlias: 'Primary backups', prefix: 'production/',
  enabled: true, lastConnectionTestAt: '2026-08-22T03:00:00.000Z', lastConnectionTestOk: true,
};
const verifiedRun = {
  id: 'run-1', status: 'SUCCESS', phase: 'CLEANUP', origin: 'SCHEDULED', scope: 'DATABASE',
  retentionClass: 'DAILY', createdBy: 'admin-1', createdAt: '2026-08-22T04:00:00.000Z',
  startedAt: '2026-08-22T04:01:00.000Z', completedAt: '2026-08-22T04:03:00.000Z',
  formatVersion: 1, remoteKey: null, sizeBytes: 1024, sha256: null,
  verifiedAt: '2026-08-22T04:03:00.000Z', warningCode: 'CLEANUP_FAILED', warningSummary: 'Yerel temizlik tamamlanamadı.',
  failureCode: null, failureSummary: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch(override: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const overridden = override(url, init);
    if (overridden !== undefined) return overridden;
    if (url === '/api/admin/backup-overview') return Promise.resolve(response({
      lastVerifiedBackup: verifiedRun, activeRun: null,
      nextScheduledAt: '2026-08-23T04:05:00.000Z', scheduleTimezone: 'UTC', worker: null,
    }));
    if (url === '/api/admin/backup-policy') return Promise.resolve(response(policy));
    if (url === '/api/admin/backup-storage') return Promise.resolve(response(storage));
    if (url === '/api/health/backup') return Promise.resolve(response({
      status: 'ok', latestVerifiedAt: verifiedRun.verifiedAt, latestScheduledVerifiedAt: verifiedRun.verifiedAt,
      latestRunStatus: 'SUCCESS', latestScheduledRunStatus: 'SUCCESS', workerHeartbeatAt: null, schedulerLastTickAt: null,
    }));
    if (url.startsWith('/api/admin/backups?')) return Promise.resolve(response({ items: [verifiedRun], nextCursor: null }));
    if (url === '/api/admin/backups' && init?.method === 'POST') return Promise.resolve(response({ ...verifiedRun, status: 'QUEUED', phase: null, origin: 'MANUAL', retentionClass: 'MANUAL', verifiedAt: null }, 202));
    if (url === '/api/admin/backup-storage/test') return Promise.resolve(response({ ok: true, testedAt: '2026-08-22T04:10:00.000Z' }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function render(initialEntry = '/settings/data-management/backup-recovery') {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[initialEntry]}><BackupRecoveryPage /></MemoryRouter>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, root };
}

afterEach(() => vi.unstubAllGlobals());

describe('BackupRecoveryPage', () => {
  it('renders the four admin sections and preserves separate status dimensions', async () => {
    installFetch();
    const { container, root } = await render();
    expect(container.textContent).toContain('Yedekleme ve Kurtarma');
    expect(container.textContent).toContain('Son doğrulanmış yedek');
    expect(container.textContent).toContain('Sağlıklı');
    expect(container.textContent).toContain('Uyarı: Yerel temizlik tamamlanamadı.');
    expect(container.textContent).toContain('Yedekler');
    expect(container.textContent).toContain('Zamanlama');
    expect(container.textContent).toContain('Depolama');
    expect(container.textContent).not.toMatch(/Restore|Geri yükle|Geri Yükle|Sil/);
    await act(async () => root.unmount());
  });

  it('posts Backup Now once with clientActionId and acknowledges 202 as queued', async () => {
    const fetchMock = installFetch();
    const { container, root } = await render();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent?.includes('Şimdi yedekle'));
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/backups', expect.objectContaining({
      method: 'POST', body: expect.stringMatching(/clientActionId/),
    }));
    expect(container.textContent).toContain('Yedekleme isteği sıraya alındı.');
    expect(container.textContent).not.toContain('Yedekleme tamamlandı');
    await act(async () => root.unmount());
  });

  it('keeps the queued acknowledgement when the post-refresh read fails', async () => {
    let failRefresh = false;
    installFetch((url) => {
      if (failRefresh && url === '/api/admin/backup-overview') return Promise.reject(new Error('refresh unavailable'));
      return undefined;
    });
    const { container, root } = await render();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent?.includes('Şimdi yedekle'));
    failRefresh = true;
    await act(async () => button!.click());
    expect(container.textContent).toContain('Yedekleme isteği sıraya alındı.');
    expect(container.textContent).toContain('güncel durum yenilenemedi');
    expect(container.textContent).not.toContain('Yedekleme isteği sıraya alınamadı');
    await act(async () => root.unmount());
  });

  it('renders an R2 connection-test failure as an alert', async () => {
    let failStorageTest = false;
    installFetch((url) => {
      if (failStorageTest && url === '/api/admin/backup-storage/test') {
        return Promise.resolve(response({ ok: false, testedAt: '2026-08-22T04:10:00.000Z', failureClass: 'NETWORK' }));
      }
      return undefined;
    });
    const { container, root } = await render();
    const storageTab = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'Depolama');
    await act(async () => storageTab!.click());
    failStorageTest = true;
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent?.includes('Bağlantıyı test et'));
    await act(async () => button!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Depolama bağlantısı testi başarısız.');
    await act(async () => root.unmount());
  });

  it('uses a retry result instead of an empty state when history initially fails', async () => {
    installFetch((url) => {
      if (url.startsWith('/api/admin/backups?')) return Promise.reject(new Error('history unavailable'));
      return undefined;
    });
    const { container, root } = await render('/settings/data-management/backup-recovery?section=backups');
    expect(container.textContent).toContain('Yedek geçmişi alınamadı');
    expect(container.textContent).toContain('Tekrar dene');
    expect(container.textContent).not.toContain('Henüz yedek geçmişi yok');
    await act(async () => root.unmount());
  });

  it('fails closed when backup health is unavailable', async () => {
    installFetch((url) => {
      if (url === '/api/health/backup') return Promise.reject(new Error('health unavailable'));
      return undefined;
    });
    const { container, root } = await render();
    expect(container.textContent).toContain('Durum kullanılamıyor');
    await act(async () => root.unmount());
  });

  it('does not render credential fields or direct storage requests', async () => {
    const fetchMock = installFetch();
    const { container, root } = await render();
    const storageTab = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((link) => link.textContent === 'Depolama');
    expect(storageTab).toBeDefined();
    await act(async () => storageTab!.click());
    expect(container.querySelector('input[name*="secret" i]')).toBeNull();
    expect(container.querySelector('input[name*="access" i]')).toBeNull();
    expect(fetchMock.mock.calls.flatMap(([url]) => String(url))).not.toContain('r2');
    await act(async () => root.unmount());
  });
});
