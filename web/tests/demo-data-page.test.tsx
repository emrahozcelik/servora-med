/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type CurrentUser } from '../src/services/api';
import { DemoDataPage } from '../src/settings/DemoDataPage';
import type {
  DemoDataset,
  DemoDatasetPreview,
  DemoDatasetPurgeResponse,
} from '../src/services/demo-data-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const demoDataApi = vi.hoisted(() => ({
  listDemoDatasets: vi.fn(),
  previewDemoDataset: vi.fn(),
  purgeDemoDataset: vi.fn(),
  createDemoDataset: vi.fn(),
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
};

const affectedCounts = {
  users: 2, staffProfiles: 1, customers: 1, contacts: 1, products: 1, jobCards: 2,
  deliveryItems: 1, notes: 1, confidentialNotes: 0, activities: 3, followUps: 0,
  calendarEvents: 1, conversations: 0, messages: 0, notifications: 1, reminders: 0,
  realtimeEvents: 1,
};

const adminUser: CurrentUser = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@test.local',
  role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false, demoDatasetCreation: true },
  support: { displayLabel: 'Sistem yöneticiniz', email: null, helpUrl: null },
};
const managerUser: CurrentUser = {
  ...adminUser,
  role: 'MANAGER',
  capabilities: { ...adminUser.capabilities, demoDatasetCreation: false },
};
const staffUser: CurrentUser = {
  ...adminUser,
  role: 'STAFF',
  capabilities: { ...adminUser.capabilities, demoDatasetCreation: false },
};
const adminNoCapability: CurrentUser = {
  ...adminUser,
  capabilities: { ...adminUser.capabilities, demoDatasetCreation: false },
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

function purgeReceipt(
  dataset: DemoDataset = activeDataset,
  operationId = '33333333-3333-4333-8333-333333333333',
): DemoDatasetPurgeResponse {
  return {
    operationId,
    status: 'COMPLETED',
    datasetId: dataset.id,
    datasetKey: dataset.datasetKey,
    seedVersion: dataset.seedVersion,
    planHash: 'a'.repeat(64),
    affectedCounts,
    retained: { auditActorDetaches: 0 },
    completedAt: '2026-08-24T11:00:00.000Z',
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
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('DemoDataPage disposable lifecycle', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    demoDataApi.listDemoDatasets.mockReset();
    demoDataApi.previewDemoDataset.mockReset();
    demoDataApi.purgeDemoDataset.mockReset();
    demoDataApi.createDemoDataset.mockReset();
    demoDataApi.listDemoDatasets.mockResolvedValue([activeDataset]);
    demoDataApi.previewDemoDataset.mockResolvedValue(preview());
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  async function renderPage(user: CurrentUser = adminUser) {
    await act(async () => {
      root.render(<MemoryRouter><DemoDataPage user={user} /></MemoryRouter>);
    });
    await settle();
  }

  function button(text: string) {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((candidate) => candidate.textContent === text);
  }

  async function confirmPurge() {
    const trigger = button('Demo verilerini sil');
    expect(trigger).toBeDefined();
    await act(async () => { trigger!.click(); });
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const confirm = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button'))
      .find((candidate) => candidate.textContent === 'Demo verilerini sil');
    expect(confirm).toBeDefined();
    await act(async () => { confirm!.click(); });
    return dialog!;
  }

  it('renders only active datasets and never exposes history or tombstones', async () => {
    await renderPage();

    expect(host.textContent).toContain(activeDataset.datasetKey);
    expect(host.textContent).toContain('Aktif');
    expect(host.textContent).not.toContain('Kaldırıldı');
    expect(host.textContent).not.toContain('Geçmiş');
    expect(host.textContent).not.toContain('PURGED');
    expect(demoDataApi.previewDemoDataset).toHaveBeenCalledWith(activeDataset.id);
  });

  it('opens confirmation with the approved count snapshot before posting', async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID');
    await renderPage();

    await act(async () => { button('Demo verilerini sil')!.click(); });
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Bu işlem geri alınamaz.');
    expect(dialog?.textContent).toContain(activeDataset.datasetKey);
    expect(dialog?.textContent).toContain('JobCard kayıtları: 2');
    expect(demoDataApi.purgeDemoDataset).not.toHaveBeenCalled();
    expect(randomUuid).not.toHaveBeenCalled();
  });

  it('creates one purge request and locks the destructive surface while pending', async () => {
    const pending = deferred<DemoDatasetPurgeResponse>();
    const clientActionId = '44444444-4444-4444-8444-444444444444';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(clientActionId);
    demoDataApi.purgeDemoDataset.mockReturnValue(pending.promise);

    await renderPage();
    const dialog = await confirmPurge();

    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(1);
    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledWith(activeDataset.id, {
      clientActionId,
      planHash: 'a'.repeat(64),
    }, {
      datasetKey: activeDataset.datasetKey,
      seedVersion: activeDataset.seedVersion,
    });
    expect(host.querySelector<HTMLButtonElement>('.demo-data-dataset-row')?.disabled).toBe(true);
    expect(dialog.getAttribute('aria-busy')).toBe('true');

    pending.resolve(purgeReceipt());
    await settle();
  });

  it('retries the exact same purge request after an ambiguous response and clears the registry UI', async () => {
    const clientActionId = '55555555-5555-4555-8555-555555555555';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(clientActionId);
    demoDataApi.purgeDemoDataset
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'network', true))
      .mockResolvedValueOnce(purgeReceipt());
    demoDataApi.listDemoDatasets.mockResolvedValueOnce([activeDataset]).mockResolvedValueOnce([]);

    await renderPage();
    await confirmPurge();
    await settle();

    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(2);
    expect(demoDataApi.purgeDemoDataset.mock.calls[0]).toEqual(demoDataApi.purgeDemoDataset.mock.calls[1]);
    expect(host.textContent).toContain('Demo verileri silindi.');
    expect(host.textContent).toContain('JobCard kayıtları: 2');
    expect(host.textContent).toContain('Demo veri kümesi yok');
    expect(host.textContent).not.toContain('Kaldırıldı');
    expect(host.textContent).not.toContain('Geçmiş');
  });

  it('requires a recheck when the same request remains in progress, then completes with that request id', async () => {
    const clientActionId = '66666666-6666-4666-8666-666666666666';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(clientActionId);
    const inProgress = new ApiError(409, 'DEMO_DATASET_PURGE_IN_PROGRESS', 'in progress');
    demoDataApi.purgeDemoDataset
      .mockRejectedValueOnce(inProgress)
      .mockRejectedValueOnce(inProgress)
      .mockResolvedValueOnce(purgeReceipt());
    demoDataApi.listDemoDatasets.mockResolvedValueOnce([activeDataset]).mockResolvedValueOnce([]);

    await renderPage();
    await confirmPurge();
    await settle();
    expect(host.textContent).toContain('Durumu yeniden kontrol et');
    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(2);

    await act(async () => { button('Durumu yeniden kontrol et')!.click(); });
    await settle();

    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(3);
    expect(demoDataApi.purgeDemoDataset.mock.calls[0]).toEqual(demoDataApi.purgeDemoDataset.mock.calls[2]);
    expect(host.textContent).toContain('Demo verileri silindi.');
  });

  it('fails closed for known blockers and unknown blocker vocabulary', async () => {
    demoDataApi.previewDemoDataset.mockResolvedValue(preview({
      safeToPurge: false,
      blockers: [{
        code: 'FUTURE_UNKNOWN_BLOCKER',
        message: 'RAW_FUTURE_MESSAGE',
        sourceType: 'FUTURE_SOURCE', sourceId: 'internal-id', relatedType: null, relatedId: null,
      }],
    }));

    await renderPage();

    expect(host.textContent).toContain('Silme güvenliği doğrulanamadı. İşlem kapalı tutuldu.');
    expect(host.textContent).not.toContain('FUTURE_UNKNOWN_BLOCKER');
    expect(host.textContent).not.toContain('RAW_FUTURE_MESSAGE');
    expect(button('Demo verilerini sil')).toBeUndefined();
  });

  it('does not claim unchanged data for an unknown mutation error', async () => {
    demoDataApi.purgeDemoDataset.mockRejectedValue(new ApiError(409, 'UNKNOWN_PURGE_REJECTION', 'raw'));

    await renderPage();
    await confirmPurge();
    await settle();

    expect(host.textContent).toContain('Sunucu durumu doğrulanmadan yeni bir silme işlemi başlatılamaz.');
    expect(host.textContent).not.toContain('Veriler değiştirilmedi.');
    expect(host.textContent).not.toContain('raw');
  });

  it('keeps the Demo UI usable for create, purge, recreate, purge, recreate', async () => {
    const datasetB: DemoDataset = { ...activeDataset, id: '22222222-2222-4222-8222-222222222222', datasetKey: 'servora-demo-b' };
    const datasetC: DemoDataset = { ...activeDataset, id: '33333333-3333-4333-8333-333333333333', datasetKey: 'servora-demo-c' };
    demoDataApi.listDemoDatasets
      .mockReset()
      .mockResolvedValueOnce([activeDataset])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([datasetB])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([datasetC]);
    demoDataApi.previewDemoDataset.mockImplementation((datasetId: string) => Promise.resolve(
      preview({ dataset: datasetId === datasetB.id ? datasetB : datasetId === datasetC.id ? datasetC : activeDataset }),
    ));
    demoDataApi.purgeDemoDataset
      .mockResolvedValueOnce(purgeReceipt(activeDataset, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .mockResolvedValueOnce(purgeReceipt(datasetB, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    demoDataApi.createDemoDataset
      .mockResolvedValueOnce({ dataset: datasetB, counts: { users: 3, customers: 5, products: 5, jobCards: 8 }, replayed: false })
      .mockResolvedValueOnce({ dataset: datasetC, counts: { users: 3, customers: 5, products: 5, jobCards: 8 }, replayed: false });

    await renderPage();
    await confirmPurge();
    await settle();
    expect(host.textContent).toContain('Demo veri kümesi yok');

    for (const dataset of [datasetB, datasetC]) {
      const createTrigger = button('Demo verisi oluştur');
      expect(createTrigger).toBeDefined();
      await act(async () => { createTrigger!.click(); });
      const createDialog = host.querySelector('[role="dialog"]');
      expect(createDialog).not.toBeNull();
      const createConfirm = Array.from(createDialog!.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.textContent === 'Oluştur');
      expect(createConfirm).toBeDefined();
      await act(async () => { createConfirm!.click(); });
      await settle();

      expect(host.textContent).toContain(dataset.datasetKey);
      expect(button('Demo verilerini sil')).toBeDefined();
      if (dataset !== datasetC) {
        await confirmPurge();
        await settle();
        expect(host.textContent).toContain('Demo veri kümesi yok');
      }
    }

    expect(demoDataApi.createDemoDataset).toHaveBeenCalledTimes(2);
    expect(demoDataApi.purgeDemoDataset).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(datasetC.datasetKey);
  });
});

describe('DemoDataPage creation boundaries', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    demoDataApi.listDemoDatasets.mockReset();
    demoDataApi.previewDemoDataset.mockReset();
    demoDataApi.purgeDemoDataset.mockReset();
    demoDataApi.createDemoDataset.mockReset();
    demoDataApi.previewDemoDataset.mockResolvedValue(preview());
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });

  async function renderCreation(user: CurrentUser, datasets: DemoDataset[] = []) {
    demoDataApi.listDemoDatasets.mockResolvedValue(datasets);
    await act(async () => {
      root.render(<MemoryRouter><DemoDataPage user={user} /></MemoryRouter>);
    });
    await settle();
  }

  it('shows creation only for an Admin with the capability and no active dataset', async () => {
    await renderCreation(adminUser);
    expect(host.textContent).toContain('Demo verisi oluştur');
    expect(host.textContent).toContain('3 demo personel');
  });

  it('hides creation when the capability is disabled or the role is not Admin', async () => {
    await renderCreation(adminNoCapability);
    expect(host.textContent).toContain('Demo verisi oluşturma bu ortamda etkin değil.');
    expect(Array.from(host.querySelectorAll('button')).some((item) => item.textContent === 'Demo verisi oluştur')).toBe(false);

    await act(async () => { root.unmount(); });
    host.remove();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await renderCreation(managerUser);
    expect(Array.from(host.querySelectorAll('button')).some((item) => item.textContent === 'Demo verisi oluştur')).toBe(false);

    await act(async () => { root.unmount(); });
    host.remove();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await renderCreation(staffUser);
    expect(Array.from(host.querySelectorAll('button')).some((item) => item.textContent === 'Demo verisi oluştur')).toBe(false);
  });

  it('disables creation while one active dataset exists', async () => {
    await renderCreation(adminUser, [activeDataset]);
    const createButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent === 'Demo verisi oluştur');
    expect(createButton?.disabled).toBe(true);
    expect(host.textContent).toContain('Zaten etkin bir demo veri seti bulunuyor.');
  });

  it('opens the create confirmation without posting before approval', async () => {
    await renderCreation(adminUser);
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((item) => item.textContent === 'Demo verisi oluştur');
    await act(async () => { trigger!.click(); });
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Demo verisi oluşturulsun mu?');
    expect(demoDataApi.createDemoDataset).not.toHaveBeenCalled();
  });
});
