/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoDataPage } from '../src/settings/DemoDataPage';
import { ApiError } from '../src/services/api';
import type {
  DemoDataset,
  DemoDatasetPreview,
  DemoDatasetPurgeResponse,
} from '../src/services/demo-data-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const demoDataApi = vi.hoisted(() => ({
  listDemoDatasets: vi.fn(),
  getDemoDataset: vi.fn(),
  previewDemoDataset: vi.fn(),
  purgeDemoDataset: vi.fn(),
}));

vi.mock('../src/services/demo-data-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/demo-data-api')>()),
  ...demoDataApi,
}));

const activeDataset: DemoDataset = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org-1',
  datasetKey: 'servora-demo-active',
  seedVersion: 'r1',
  status: 'ACTIVE',
  createdAt: '2026-08-24T10:00:00.000Z',
  createdBy: 'admin-1',
  purgedAt: null,
};

const purgedDataset: DemoDataset = {
  ...activeDataset,
  id: '22222222-2222-4222-8222-222222222222',
  datasetKey: 'servora-demo-purged',
  status: 'PURGED',
  purgedAt: '2026-08-24T11:00:00.000Z',
};

const affectedCounts = {
  users: 2, staffProfiles: 1, customers: 1, contacts: 1, products: 1, jobCards: 2,
  deliveryItems: 1, notes: 1, confidentialNotes: 0, activities: 3, followUps: 0,
  calendarEvents: 1, conversations: 0, messages: 0, notifications: 1, reminders: 0,
  realtimeEvents: 1,
};

function preview(overrides: Partial<DemoDatasetPreview> = {}): DemoDatasetPreview {
  return {
    dataset: activeDataset,
    organization: { id: 'org-1', name: 'Dünya Dental' },
    affectedCounts,
    blockers: [],
    safeToPurge: true,
    planHash: 'a'.repeat(64),
    ...overrides,
  };
}

function purgeReceipt(): DemoDatasetPurgeResponse {
  const completedDataset: DemoDataset = {
    ...activeDataset,
    status: 'PURGED',
    purgedAt: '2026-08-24T11:00:00.000Z',
  };
  return {
    operationId: '33333333-3333-4333-8333-333333333333',
    status: 'COMPLETED',
    dataset: completedDataset,
    datasetKey: activeDataset.datasetKey,
    seedVersion: activeDataset.seedVersion,
    planHash: 'a'.repeat(64),
    affectedCounts,
    retained: { auditActorDetaches: 0, datasetCreatorDetached: false },
    completedAt: completedDataset.purgedAt!,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('DemoDataPage destructive purge flow', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    demoDataApi.listDemoDatasets.mockReset();
    demoDataApi.getDemoDataset.mockReset();
    demoDataApi.previewDemoDataset.mockReset();
    demoDataApi.purgeDemoDataset.mockReset();
    vi.restoreAllMocks();
    demoDataApi.previewDemoDataset.mockResolvedValue(preview());
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  async function renderPage() {
    await act(async () => {
      root.render(<MemoryRouter><DemoDataPage /></MemoryRouter>);
    });
    await settle();
  }

  it('selects the first active dataset and never previews a purged tombstone', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([purgedDataset, activeDataset]);

    await renderPage();

    const selected = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    expect(selected?.textContent).toContain(activeDataset.datasetKey);
    expect(demoDataApi.previewDemoDataset).toHaveBeenCalledTimes(1);
    expect(demoDataApi.previewDemoDataset).toHaveBeenCalledWith(activeDataset.id);
    expect(host.textContent).toContain('Kaldırıldı');
    expect(host.textContent).not.toContain('Arşivlenmiş');
  });

  it('localizes blockers without exposing raw codes, messages, ids, or plan hashes', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.previewDemoDataset.mockResolvedValue(preview({
      safeToPurge: false,
      blockers: [{
        code: 'DEMO_USER_TO_BUSINESS_JOB',
        message: 'RAW_BACKEND_MESSAGE',
        sourceType: 'USER',
        sourceId: 'internal-user-id',
        relatedType: 'JOB_CARD',
        relatedId: 'internal-job-id',
      }],
    }));

    await renderPage();

    expect(host.textContent).toContain('Demo içeriği gerçek iş verileriyle bağlantılı.');
    expect(host.textContent).not.toContain('DEMO_USER_TO_BUSINESS_JOB');
    expect(host.textContent).not.toContain('RAW_BACKEND_MESSAGE');
    expect(host.textContent).not.toContain('internal-user-id');
    expect(host.textContent).not.toContain('internal-job-id');
    expect(host.textContent).not.toContain('a'.repeat(64));
  });

  it('opens a destructive confirmation with the approved count snapshot before posting', async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID');
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);

    await renderPage();

    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır');
    expect(trigger).not.toBeUndefined();
    await act(async () => { trigger!.click(); });

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Bu işlem geri alınamaz.');
    expect(dialog?.textContent).toContain(activeDataset.datasetKey);
    expect(dialog?.textContent).toContain('JobCard kayıtları: 2');
    expect(demoDataApi.purgeDemoDataset).not.toHaveBeenCalled();
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it('creates one client action on first confirm and locks the purge surface while pending', async () => {
    const pending = deferred<DemoDatasetPurgeResponse>();
    const clientActionId = '44444444-4444-4444-8444-444444444444';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(clientActionId);
    demoDataApi.listDemoDatasets
      .mockResolvedValueOnce([activeDataset])
      .mockResolvedValue([purgeReceipt().dataset]);
    demoDataApi.purgeDemoDataset.mockReturnValue(pending.promise);

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;

    await act(async () => {
      confirm.click();
      confirm.click();
    });

    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(1);
    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledWith(activeDataset.id, {
      clientActionId,
      planHash: 'a'.repeat(64),
    }, {
      datasetKey: activeDataset.datasetKey,
      seedVersion: activeDataset.seedVersion,
    });
    expect(host.querySelector<HTMLButtonElement>('.demo-data-dataset-row')?.disabled).toBe(true);
    expect(trigger.disabled).toBe(true);
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).every((button) => button.disabled)).toBe(true);

    pending.resolve(purgeReceipt());
    await settle();
  });

  it('labels a known transactional blocker as unchanged and hides the destructive action', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      409,
      'DEMO_DATASET_PURGE_BLOCKED',
      'RAW_BACKEND_BLOCKER',
      false,
      { blockerCodes: ['PURGE_ACTOR_IN_DATASET'], blockerCount: 1 },
    ));

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('İşlem yapılmadı. Veriler değiştirilmedi.');
    expect(host.textContent).toContain('Bu demo veri kümesinin parçası olan hesapla kaldırma işlemi yapılamaz.');
    expect(host.textContent).not.toContain('RAW_BACKEND_BLOCKER');
    expect(Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Demo verilerini kaldır')).toHaveLength(0);
  });

  it('treats a lost mutation response as ambiguous and recovers success from a purged tombstone', async () => {
    const reconciliation = deferred<DemoDataset>();
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      0,
      'NETWORK_ERROR',
      'Sunucuya ulaşılamadı.',
      true,
    ));
    demoDataApi.getDemoDataset.mockReturnValue(reconciliation.promise);

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('İşlemin sonucu doğrulanamadı. Güncel durum kontrol ediliyor.');
    expect(host.textContent).not.toContain('Veriler değiştirilmedi.');
    expect(demoDataApi.getDemoDataset).toHaveBeenCalledWith(activeDataset.id);

    reconciliation.resolve(purgeReceipt().dataset);
    await settle();

    expect(host.textContent).toContain('Demo verileri kaldırıldı.');
    expect(host.textContent).toContain('Kaldırıldı');
  });

  it('requires an IN_PROGRESS state recheck before offering same-attempt retry', async () => {
    const clientActionId = '55555555-5555-4555-8555-555555555555';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(clientActionId);
    demoDataApi.listDemoDatasets
      .mockResolvedValueOnce([activeDataset])
      .mockResolvedValue([purgeReceipt().dataset]);
    demoDataApi.getDemoDataset.mockResolvedValue(activeDataset);
    demoDataApi.purgeDemoDataset
      .mockRejectedValueOnce(new ApiError(
        409,
        'DEMO_DATASET_PURGE_IN_PROGRESS',
        'RAW_IN_PROGRESS',
      ))
      .mockResolvedValueOnce(purgeReceipt());

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    let dialog = host.querySelector('[role="dialog"]')!;
    let confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('Durumu yeniden kontrol et');
    expect(host.textContent).not.toContain('Aynı işlemi yeniden dene');
    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(1);
    expect(demoDataApi.previewDemoDataset).toHaveBeenCalledTimes(2);

    const recheck = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Durumu yeniden kontrol et')!;
    await act(async () => { recheck.click(); });
    await settle();

    expect(host.textContent).toContain('Aynı işlemi yeniden dene');
    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(1);
    expect(demoDataApi.previewDemoDataset).toHaveBeenCalledTimes(3);

    const retry = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Aynı işlemi yeniden dene')!;
    await act(async () => { retry.click(); });
    dialog = host.querySelector('[role="dialog"]')!;
    confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(2);
    expect(demoDataApi.purgeDemoDataset).toHaveBeenLastCalledWith(activeDataset.id, {
      clientActionId,
      planHash: 'a'.repeat(64),
    }, {
      datasetKey: activeDataset.datasetKey,
      seedVersion: activeDataset.seedVersion,
    });
  });

  it('discards a stale attempt, states that nothing changed, and requires a new preview approval', async () => {
    const refreshedPreview = preview({ planHash: 'b'.repeat(64) });
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.previewDemoDataset
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(refreshedPreview);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      409,
      'DEMO_DATASET_PLAN_STALE',
      'RAW_STALE_MESSAGE',
    ));

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('İşlem yapılmadı. Veriler değiştirilmedi.');
    expect(host.textContent).toContain('Güncel planı yeniden inceleyip onaylayın.');
    expect(host.textContent).not.toContain('RAW_STALE_MESSAGE');
    expect(demoDataApi.previewDemoDataset).toHaveBeenCalledTimes(2);
    expect(Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Demo verilerini kaldır')).toHaveLength(1);
  });

  it('does not treat ALREADY_PURGED as success until GET confirms the tombstone', async () => {
    const reconciliation = deferred<DemoDataset>();
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      409,
      'DEMO_DATASET_ALREADY_PURGED',
      'RAW_ALREADY_PURGED',
    ));
    demoDataApi.getDemoDataset.mockReturnValue(reconciliation.promise);

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).not.toContain('Demo verileri kaldırıldı.');
    expect(demoDataApi.getDemoDataset).toHaveBeenCalledWith(activeDataset.id);

    reconciliation.resolve(purgeReceipt().dataset);
    await settle();

    expect(host.textContent).toContain('Demo verileri daha önce kaldırılmış.');
    expect(host.textContent).not.toContain('RAW_ALREADY_PURGED');
  });

  it('fails closed on an unexpected dependency without exposing backend diagnostics', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      409,
      'DEMO_DATASET_UNEXPECTED_DEPENDENCY',
      'RAW_DATABASE_CONSTRAINT',
    ));

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('İşlem yapılmadı. Veriler değiştirilmedi.');
    expect(host.textContent).toContain('Beklenmeyen bir veri bağımlılığı bulundu.');
    expect(host.textContent).not.toContain('RAW_DATABASE_CONSTRAINT');
    expect(Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Demo verilerini kaldır')).toHaveLength(0);
  });

  it('fails closed on an unknown mutation error without claiming that data is unchanged', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      409,
      'UNKNOWN_PURGE_REJECTION',
      'RAW_UNKNOWN_MESSAGE',
    ));

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('İşlem tamamlanamadı. Sunucu durumu doğrulanmadan yeni bir kaldırma işlemi başlatılamaz.');
    expect(host.textContent).not.toContain('Veriler değiştirilmedi.');
    expect(host.textContent).not.toContain('RAW_UNKNOWN_MESSAGE');
  });

  it('renders a purged tombstone as neutral history without preview or destructive controls', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([purgedDataset]);

    await renderPage();

    expect(host.textContent).toContain('Demo veri kümesi kaldırıldı');
    expect(host.textContent).toContain('Bu geçmiş kaydı yeniden kaldırılamaz.');
    expect(demoDataApi.previewDemoDataset).not.toHaveBeenCalled();
    expect(Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Demo verilerini kaldır')).toHaveLength(0);
  });

  it('treats an INVALID_RESPONSE after mutation as ambiguous and reconciles before retry', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.getDemoDataset.mockResolvedValue(activeDataset);
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(
      0,
      'INVALID_RESPONSE',
      'RAW_INVALID_RESPONSE',
    ));

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('Aynı işlemi yeniden dene');
    expect(host.textContent).not.toContain('Veriler değiştirilmedi.');
    expect(host.textContent).not.toContain('RAW_INVALID_RESPONSE');
    expect(demoDataApi.getDemoDataset).toHaveBeenCalledWith(activeDataset.id);
  });

  it('maps an unknown preview blocker to one generic fail-closed message', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.previewDemoDataset.mockResolvedValue(preview({
      safeToPurge: false,
      blockers: [{
        code: 'FUTURE_UNKNOWN_BLOCKER',
        message: 'RAW_FUTURE_MESSAGE',
        sourceType: 'FUTURE_SOURCE',
        sourceId: 'future-source-id',
        relatedType: null,
        relatedId: null,
      }],
    }));

    await renderPage();

    expect(host.textContent).toContain('Kaldırma güvenliği doğrulanamadı. İşlem kapalı tutuldu.');
    expect(host.textContent).not.toContain('FUTURE_UNKNOWN_BLOCKER');
    expect(host.textContent).not.toContain('RAW_FUTURE_MESSAGE');
    expect(Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent === 'Demo verilerini kaldır')).toHaveLength(0);
  });

  it('does not expose backend diagnostics when preview loading fails', async () => {
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.previewDemoDataset.mockRejectedValue(new ApiError(
      500,
      'INTERNAL_ERROR',
      'RAW_PREVIEW_DIAGNOSTIC',
    ));

    await renderPage();

    expect(host.textContent).toContain('Demo veri kümesinin güvenlik önizlemesi alınamadı.');
    expect(host.textContent).not.toContain('RAW_PREVIEW_DIAGNOSTIC');
  });

  it('keeps a valid completed receipt successful when the list refresh fails', async () => {
    demoDataApi.listDemoDatasets
      .mockResolvedValueOnce([activeDataset])
      .mockRejectedValueOnce(new Error('refresh failed'));
    demoDataApi.purgeDemoDataset.mockResolvedValue(purgeReceipt());

    await renderPage();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { trigger.click(); });
    const dialog = host.querySelector('[role="dialog"]')!;
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Demo verilerini kaldır')!;
    await act(async () => { confirm.click(); });
    await settle();

    expect(host.textContent).toContain('Demo verileri kaldırıldı.');
    expect(host.textContent).toContain('Veri kümesi listesi yenilenemedi.');
    expect(host.textContent).toContain('JobCard kayıtları: 2');
    expect(host.textContent).toContain('Kaldırıldı');
  });
});
