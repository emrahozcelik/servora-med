/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LatenessSummaryCard } from '../src/reports/LatenessSummaryCard';
import { getLatenessSummary } from '../src/reports/reports-api';
import type { OrganizationLatenessSummary } from '../src/reports/report-types';

vi.mock('../src/reports/reports-api', () => ({
  getLatenessSummary: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const range = { from: '2026-09-01', to: '2026-10-31', timezone: 'Europe/Istanbul' };

const summary: OrganizationLatenessSummary = {
  range,
  trackingStartedOn: '2026-09-21',
  generatedAt: '2026-11-02T09:15:00.000Z',
  totalIncidentCount: 6,
  staffResponsibility: { delayedJobCount: 4, incidentCount: 4 },
  operational: { delayedJobCount: 1, incidentCount: 1 },
  unknownAccountability: { delayedJobCount: 1, incidentCount: 1 },
  managementApprovalWait: {
    delayedJobCount: 1,
    incidentCount: 1,
    recovered: { count: 1, medianSeconds: 3_600, maxSeconds: 5_400 },
    open: { count: 1, maxElapsedSeconds: 172_800 },
  },
};

const empty: OrganizationLatenessSummary = {
  ...summary,
  totalIncidentCount: 0,
  staffResponsibility: { delayedJobCount: 0, incidentCount: 0 },
  operational: { delayedJobCount: 0, incidentCount: 0 },
  unknownAccountability: { delayedJobCount: 0, incidentCount: 0 },
  managementApprovalWait: {
    delayedJobCount: 0,
    incidentCount: 0,
    recovered: { count: 0, medianSeconds: null, maxSeconds: null },
    open: { count: 0, maxElapsedSeconds: null },
  },
};

describe('Organization lateness card', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(getLatenessSummary).mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows an honest loading state for the card only', async () => {
    vi.mocked(getLatenessSummary).mockReturnValue(new Promise<OrganizationLatenessSummary>(() => {}));
    await act(async () => root.render(<LatenessSummaryCard range={range} />));

    expect(container.querySelector('h2')?.textContent).toBe('Gecikme kayıtları');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('Gecikme kayıtları yükleniyor…');
    expect(getLatenessSummary).toHaveBeenCalledWith({
      from: '2026-09-01',
      to: '2026-10-31',
    });
  });

  it('keeps a local error with retry, then renders the reconciled groups', async () => {
    vi.mocked(getLatenessSummary)
      .mockRejectedValueOnce(new Error('Rapor servisi geçici olarak yanıt vermedi.'))
      .mockResolvedValueOnce(summary);

    await act(async () => root.render(<LatenessSummaryCard range={range} />));
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Rapor servisi geçici olarak yanıt vermedi.');
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Tekrar dene')!.click();
    });
    await act(async () => { await Promise.resolve(); });

    expect(getLatenessSummary).toHaveBeenCalledTimes(2);
    const text = container.textContent ?? '';
    expect(text).toContain('Personel sorumluluğunda');
    expect(text).toContain('4 kayıt · 4 iş');
    expect(text).toContain('Değişiklik talebiyle ilişkili');
    expect(text).toContain('1 kayıt · 1 iş');
    expect(text).toContain('Sorumlusu belirlenemeyen');
    expect(text).toContain('Yönetici onayı beklemesi');
    expect(text).toContain('Ortanca süre');
    expect(text).toContain('En uzun süre');
    expect(text).toContain('Devam eden en uzun süre');
    expect(text).toContain('2 gün');
    expect(text).toContain("Gecikme kayıtları 21 Eylül 2026'dan önce eksik olabilir.");
    expect(text).toContain('Durumlar ');
    expect(text).not.toMatch(/puan|sıralama|oranı/i);
  });

  it('reloads the card through Yenile', async () => {
    vi.mocked(getLatenessSummary).mockResolvedValue(summary);
    await act(async () => root.render(<LatenessSummaryCard range={range} />));
    await act(async () => { await Promise.resolve(); });

    const refresh = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Yenile')!;
    await act(async () => refresh.click());
    await act(async () => { await Promise.resolve(); });

    expect(getLatenessSummary).toHaveBeenCalledTimes(2);
  });

  it('shows only the period empty copy when the cohort is empty', async () => {
    vi.mocked(getLatenessSummary).mockResolvedValue(empty);
    await act(async () => root.render(<LatenessSummaryCard range={range} />));
    await act(async () => { await Promise.resolve(); });

    const text = container.textContent ?? '';
    expect(text).toContain('Bu dönemde gecikme kaydı yok.');
    expect(text).not.toContain('Personel sorumluluğunda');
    expect(text).not.toContain('Yönetici onayı beklemesi');
    expect(text).toContain("Gecikme kayıtları 21 Eylül 2026'dan önce eksik olabilir.");
  });
});
