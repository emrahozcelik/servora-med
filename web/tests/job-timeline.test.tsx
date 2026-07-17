/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobTimeline } from '../src/jobs/JobTimeline';
import { ApiError } from '../src/services/api';
import type { JobCardActivity, Paginated } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function page(items: JobCardActivity[]): Paginated<JobCardActivity> {
  return { items, total: items.length, limit: 50, offset: 0 };
}

describe('safe JobCard timeline', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it('renders actor names and known details without raw audit fields', async () => {
    const activity: JobCardActivity = {
      id: 'a1', jobCardId: 'job-1', eventType: 'JOB_STARTED',
      actor: { id: 'staff-1', name: 'Ayşe Personel' },
      details: { kind: 'STATUS_TRANSITION', fromStatus: 'PLANNED', toStatus: 'IN_PROGRESS', reason: null },
      createdAt: '2026-07-14T08:00:00.000Z',
    };
    await act(async () => root.render(<JobTimeline jobId="job-1" load={vi.fn().mockResolvedValue(page([activity]))} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('İş başlatıldı');
    expect(host.textContent).toContain('Ayşe Personel');
    expect(host.textContent).toContain('Planlandı → Devam ediyor');
    expect(host.textContent).not.toMatch(/JOB_STARTED|oldValue|metadata|clientActionId/);
  });

  it('uses a safe unknown-event fallback and only emits a non-sensitive development diagnostic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activity: JobCardActivity = {
      id: 'a2', jobCardId: 'job-1', eventType: 'FUTURE_EVENT', actor: null,
      details: { kind: 'NONE' }, createdAt: '2026-07-14T08:00:00.000Z',
    };
    await act(async () => root.render(<JobTimeline jobId="job-1" load={vi.fn().mockResolvedValue(page([activity]))} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('İş kaydında bir işlem yapıldı');
    expect(host.textContent).not.toContain('FUTURE_EVENT');
    if (import.meta.env.DEV) expect(warn).toHaveBeenCalledWith('Unknown JobCard activity event', { eventType: 'FUTURE_EVENT' });
  });

  it('presents safe meeting field names without values', async () => {
    const activity: JobCardActivity = { id: 'a3', jobCardId: 'job-1',
      eventType: 'MEETING_DETAILS_UPDATED', actor: { id: 'staff-1', name: 'Ayşe' },
      details: { kind: 'MEETING_DETAILS', changedFields: ['outcome', 'meetingSummary'] },
      createdAt: '2026-07-14T08:00:00.000Z' };
    await act(async () => root.render(<JobTimeline jobId="job-1"
      load={vi.fn().mockResolvedValue(page([activity]))} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Görüşme sonucu güncellendi');
    expect(host.textContent).toContain('Sonuç, Görüşme özeti');
    expect(host.textContent).not.toContain('meetingSummary');
  });

  it('keeps timeline failures local and retryable', async () => {
    const load = vi.fn().mockRejectedValueOnce(new ApiError(503, 'TEMPORARY', 'Geçmiş yüklenemedi.', true)).mockResolvedValueOnce(page([]));
    await act(async () => root.render(<JobTimeline jobId="job-1" load={load} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Geçmiş yüklenemedi.');
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Henüz işlem geçmişi yok');
  });

  it('returns to and reloads the first page when its refresh key changes', async () => {
    const activity: JobCardActivity = { id: 'a1', jobCardId: 'job-1', eventType: 'JOB_CREATED', actor: null,
      details: { kind: 'NONE' }, createdAt: '2026-07-14T08:00:00.000Z' };
    const load = vi.fn().mockImplementation(async (_jobId: string, query: { limit: number; offset: number }) => ({
      items: [activity], total: 75, limit: query.limit, offset: query.offset,
    }));
    await act(async () => { root.render(<JobTimeline jobId="job-1" refreshKey={0} load={load} />); await Promise.resolve(); });
    const next = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki')!;
    await act(async () => { next.click(); await Promise.resolve(); });
    expect(load).toHaveBeenLastCalledWith('job-1', { limit: 50, offset: 50 });

    await act(async () => { root.render(<JobTimeline jobId="job-1" refreshKey={1} load={load} />); await Promise.resolve(); await Promise.resolve(); });
    expect(load).toHaveBeenLastCalledWith('job-1', { limit: 50, offset: 0 });
  });
});
