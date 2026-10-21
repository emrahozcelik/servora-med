/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DuplicateReviewPanel } from '../src/DuplicateReviewPanel';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { DuplicateComparison, DuplicateHistoryPage } from '../src/services/duplicate-customers-api';
import { useDuplicateRead } from '../src/useDuplicateRead';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const user: CurrentUser = {
  id: 'history-manager', organizationId: 'history-org', name: 'Synthetic Manager', email: 'history@example.invalid',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true, duplicateCustomerComparison: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const customer = { id: 'a', name: 'Sentetik Klinik', status: 'active', city: null, district: null, customerType: 'clinic',
  taxNumber: null, phone: null, email: null, address: null, version: 1, assignedStaffUserId: null, contacts: [] };
function comparison(version = 21, reviewId = 'history-review'): DuplicateComparison {
  const decision = { eventId: `${reviewId}-${version}`, seq: version, status: 'DISMISSED' as const,
    reasonCode: 'DISTINCT_CUSTOMER' as const, actorUserId: user.id, decidedAt: '2026-10-20T10:00:00Z' };
  return {
    pair: { customerAId: 'a', customerBId: 'b' }, asOf: '2026-10-20T10:00:00Z', customerA: customer, customerB: { ...customer, id: 'b' },
    evidence: { revision: 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME'], warnings: [] },
    review: { id: reviewId, version, reviewStatus: 'DISMISSED', effectiveStatus: 'DISMISSED', freshness: 'CURRENT', freshnessReason: null, currentDecision: decision, lastDecision: decision },
    allowedActions: ['REOPEN'],
  };
}
function history(upperSeq: number, seqs: number[], nextCursor: string | null = null, reviewId = 'history-review'): DuplicateHistoryPage {
  return { reviewId, upperSeq, nextCursor, items: seqs.map(seq => ({ eventId: `${reviewId}-${seq}`, seq,
    eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER', actorUserId: user.id,
    occurredAt: '2026-10-20T10:00:00Z', matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME'], warnings: [] })) };
}
const response = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let host: HTMLDivElement; let root: Root;
let actor = 0;
beforeEach(() => { user.id = `history-manager-${++actor}`; });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
async function render(data = comparison()) {
  if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => { root.render(<ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={data} onRefresh={async () => true} /></MemoryRouter></ServoraAntProvider>); });
  await flush();
}
function button(text: string) { return [...host.querySelectorAll('button')].find(el => el.textContent?.trim() === text)!; }
const historyText = () => host.querySelector('.duplicate-history')?.textContent ?? '';
const historySeqs = () => [...host.querySelectorAll('.duplicate-history-list li > p:first-of-type')].map(el => Number(el.textContent?.match(/Sıra (\d+)$/)?.[1]));
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); host = undefined as never; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([200, 429, 503])('F20: late second-page HTTP %s cannot overwrite or pause a fresh version generation', async (status) => {
  const old = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, Array.from({ length: 20 }, (_, i) => 21 - i), 'old-cursor')))
    .mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(history(22, Array.from({ length: 20 }, (_, i) => 22 - i), 'fresh-cursor')))
    .mockResolvedValueOnce(response(history(22, [2, 1])));
  vi.stubGlobal('fetch', fetch);
  await render();
  await act(async () => { button('Daha eski kararlar').click(); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await render(comparison(22));
  expect(historySeqs()).toEqual(Array.from({ length: 20 }, (_, i) => 22 - i));
  expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
  await act(async () => { old.resolve(status === 200 ? response(history(21, [1])) : response({ code: status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'REVIEW_TEMPORARILY_UNAVAILABLE', error: 'Stale history failure' }, status, { 'Retry-After': '60' })); });
  await flush();
  expect(historySeqs()).toEqual(Array.from({ length: 20 }, (_, i) => 22 - i));
  expect(host.querySelectorAll('.duplicate-history-list li')).toHaveLength(20);
  expect(historyText()).not.toContain('Stale history failure');
  await act(async () => { button('Daha eski kararlar').click(); }); await flush();
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(new URL(fetch.mock.calls[3]![0], 'https://example.invalid').searchParams.get('cursor')).toBe('fresh-cursor');
  expect(historySeqs()).toEqual(Array.from({ length: 22 }, (_, i) => 22 - i));
});

it('F20: a stale initial response cannot replace a different review or update after unmount', async () => {
  const old = deferred<Response>(); const unmounted = deferred<Response>();
  const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(history(31, [31], 'new-review-cursor', 'second-review'))).mockReturnValueOnce(unmounted.promise).mockResolvedValueOnce(response(history(32, [32], null, 'third-review')));
  vi.stubGlobal('fetch', fetch);
  await render(); await render(comparison(31, 'second-review'));
  expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  await act(async () => { old.resolve(response(history(21, [21]))); }); await flush();
  expect(historySeqs()).toEqual([31]);
  await act(async () => { button('Daha eski kararlar').click(); });
  await act(async () => { root.unmount(); });
  expect(fetch.mock.calls[2]![1].signal.aborted).toBe(true);
  await act(async () => { unmounted.resolve(response({ code: 'RATE_LIMIT_EXCEEDED', error: 'Unmounted quota' }, 429, { 'Retry-After': '60' })); }); await flush();
  root = createRoot(host); await render(comparison(32, 'third-review'));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(historySeqs()).toEqual([32]);
});

it('F20: concurrent more coalesces and overlapping pages preserve immutable descending order without duplicates', async () => {
  const next = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, Array.from({ length: 20 }, (_, i) => 21 - i), 'signed.upper21.before2'))).mockReturnValueOnce(next.promise);
  vi.stubGlobal('fetch', fetch); await render();
  await act(async () => { const more = button('Daha eski kararlar'); more.click(); more.click(); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new URL(fetch.mock.calls[1]![0], 'https://example.invalid').searchParams.get('cursor')).toBe('signed.upper21.before2');
  await act(async () => { next.resolve(response(history(21, [2, 1]))); }); await flush();
  expect(historySeqs()).toEqual(Array.from({ length: 21 }, (_, i) => 21 - i));
  expect(button('Daha eski kararlar')).toBeUndefined();
});

it('F21: initial history 429 displays Retry-After and pauses comparison in the same DETAIL scope', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(response({ code: 'RATE_LIMIT_EXCEEDED', error: 'Synthetic history quota' }, 429, { 'Retry-After': '5' }));
  const comparisonLoad = vi.fn().mockResolvedValue({ current: true });
  let reload = async () => false;
  function Harness() {
    const read = useDuplicateRead('history-comparison', comparisonLoad, true, `CRM_DUPLICATE_DETAIL:v1:${user.organizationId}:${user.id}`);
    reload = read.reload;
    return <ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={comparison()} onRefresh={async () => true} /></MemoryRouter></ServoraAntProvider>;
  }
  vi.stubGlobal('fetch', fetch);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<Harness />); }); await flush();
  expect(historyText()).toContain('5 saniye');
  expect(comparisonLoad).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await reload(); });
  expect(comparisonLoad).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('F21: late comparison 200 and changed page generations cannot erase the shared DETAIL wait', async () => {
  vi.useFakeTimers();
  const late = deferred<{ current: boolean }>();
  const comparisonLoad = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue({ current: true });
  const fetch = vi.fn().mockResolvedValueOnce(response({ code: 'RATE_LIMIT_EXCEEDED', error: 'Synthetic shared quota' }, 429, { 'Retry-After': '65' }))
    .mockResolvedValue(response(history(22, [22])));
  let reload = async () => false; let changePage = () => {};
  function Harness() {
    const [key, setKey] = useState(21); changePage = () => setKey(22);
    const read = useDuplicateRead(`comparison:${key}`, comparisonLoad, true, `CRM_DUPLICATE_DETAIL:v1:${user.organizationId}:${user.id}`);
    reload = read.reload;
    return <ServoraAntProvider><MemoryRouter><output data-comparison-wait>{read.retryAt ?? 'ready'}</output><DuplicateReviewPanel user={user} aId="a" bId="b" data={comparison(key)} onRefresh={async () => true} /></MemoryRouter></ServoraAntProvider>;
  }
  vi.stubGlobal('fetch', fetch); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<Harness />); }); await flush();
  const until = host.querySelector('[data-comparison-wait]')?.textContent;
  expect(until).not.toBe('ready');
  await act(async () => { late.resolve({ current: true }); }); await flush();
  expect(host.querySelector('[data-comparison-wait]')?.textContent).toBe(until);
  await act(async () => { changePage(); }); await flush();
  expect(historyText()).toContain('65 saniye');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await reload(); });
  expect(comparisonLoad).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); await flush();
  expect(comparisonLoad).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(2);
  expect(historySeqs()).toEqual([22]);
});

it('F21: pagination 429 retains labelled history and retries the identical cursor only after expiry', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, Array.from({ length: 20 }, (_, i) => 21 - i), 'signed.upper21.before2')))
    .mockResolvedValueOnce(response({ code: 'RATE_LIMIT_EXCEEDED', error: 'Synthetic page quota' }, 429, { 'Retry-After': '65' }))
    .mockResolvedValueOnce(response(history(21, [1])));
  vi.stubGlobal('fetch', fetch); await render();
  await act(async () => { button('Daha eski kararlar').click(); }); await flush();
  expect(historySeqs()).toHaveLength(20); expect(historyText()).toContain('güncelliği doğrulanamadı');
  expect(button('Daha eski kararlar').disabled).toBe(true); expect(button('Geçmişi tekrar dene').disabled).toBe(true);
  await act(async () => { button('Geçmişi tekrar dene').click(); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(64_999); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flush();
  expect(fetch).toHaveBeenCalledTimes(3); expect(fetch.mock.calls[2]![0]).toBe(fetch.mock.calls[1]![0]);
  expect(historySeqs()).toEqual(Array.from({ length: 21 }, (_, i) => 21 - i));
  expect(historyText()).not.toContain('güncelliği doğrulanamadı');
});

it.each([401, 403, 404, 503])('F21: history HTTP %s clears definitive access loss or labels retained temporary data with retry', async (status) => {
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, [21], 'older-cursor')))
    .mockResolvedValueOnce(response({ code: status === 503 ? 'REVIEW_TEMPORARILY_UNAVAILABLE' : 'FORBIDDEN', error: 'Synthetic history unavailable' }, status))
    .mockResolvedValueOnce(response(history(21, [20])));
  vi.stubGlobal('fetch', fetch); await render();
  await act(async () => { button('Daha eski kararlar').click(); }); await flush();
  expect(historyText()).toContain('Synthetic history unavailable');
  if (status !== 503) {
    expect(historySeqs()).toEqual([]); expect(button('Daha eski kararlar')).toBeUndefined(); expect(button('Geçmişi tekrar dene')).toBeUndefined();
  } else {
    expect(historySeqs()).toEqual([21]); expect(historyText()).toContain('güncelliği doğrulanamadı');
    await act(async () => { button('Geçmişi tekrar dene').click(); }); await flush();
    expect(fetch.mock.calls[2]![0]).toBe(fetch.mock.calls[1]![0]); expect(historySeqs()).toEqual([21, 20]);
  }
});

it('F21: hidden scope has no polling/retry timers and resumes once when visible; unmount removes timers', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const quota = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Synthetic hidden quota'); quota.retryAfterSeconds = 5;
  const load = vi.fn().mockRejectedValueOnce(quota).mockResolvedValue('current');
  let reload = async () => false;
  function Harness() { const read = useDuplicateRead('hidden-history', load, true, `CRM_DUPLICATE_DETAIL:v1:${user.organizationId}:${user.id}`); reload = read.reload; return <p>{read.data}</p>; }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
  expect(load).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue('hidden');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await reload(); });
  expect(load).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); await flush();
  expect(load).toHaveBeenCalledTimes(2); expect(host.textContent).toBe('current');
  await act(async () => { root.unmount(); }); root = undefined as never;
  expect(vi.getTimerCount()).toBe(0); expect(await reload()).toBe(false);
});

it('History cursor recovery: expired history cursor must restart with a fresh first-page request', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, Array.from({ length: 20 }, (_, i) => 21-i), 'expired-cursor')))
    .mockResolvedValueOnce(response({ code: 'CURSOR_RESTART_REQUIRED', error: 'Expired history cursor' }, 409))
    .mockResolvedValue(response(history(22, Array.from({ length: 20 }, (_, i) => 22-i), 'fresh-cursor')));
  vi.stubGlobal('fetch', fetch); await render();
  await act(async () => { button('Daha eski kararlar').click(); }); await flush();
  expect(historySeqs()).toEqual([]);
  await act(async () => { button('Geçmişi tekrar dene').click(); }); await flush();
  expect(new URL(fetch.mock.calls[2]![0], 'https://example.invalid').searchParams.has('cursor')).toBe(false);
  expect(historySeqs()).toEqual(Array.from({ length: 20 }, (_, i) => 22-i));
});

it('History cursor recovery: a failed fresh page never resurrects the discarded immutable window', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, Array.from({ length: 20 }, (_, i) => 21-i), 'expired-cursor')))
    .mockResolvedValueOnce(response({ code: 'CURSOR_RESTART_REQUIRED', error: 'Expired history cursor' }, 409))
    .mockResolvedValueOnce(response({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE', error: 'Fresh first page unavailable' }, 503))
    .mockResolvedValue(response(history(22, [22], null)));
  vi.stubGlobal('fetch', fetch); await render();
  await act(async () => { button('Daha eski kararlar').click(); }); await flush();
  expect(historySeqs()).toEqual([]);
  await act(async () => { button('Geçmişi tekrar dene').click(); }); await flush();
  expect(historySeqs()).toEqual([]); expect(historyText()).toContain('Fresh first page unavailable');
  await act(async () => { button('Geçmişi tekrar dene').click(); }); await flush();
  expect(historySeqs()).toEqual([22]);
  for (const call of fetch.mock.calls.slice(2)) expect(new URL(call[0], 'https://example.invalid').searchParams.has('cursor')).toBe(false);
});

it('History cursor recovery: a shared DETAIL 429 cannot resurrect a discarded cursor window', async () => {
  vi.useFakeTimers();
  const quota = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Synthetic shared detail quota'); quota.retryAfterSeconds = 5;
  const comparisonLoad = vi.fn().mockResolvedValueOnce({ ready: true }).mockRejectedValueOnce(quota).mockResolvedValue({ ready: true });
  const fetch = vi.fn().mockResolvedValueOnce(response(history(21, Array.from({ length: 20 }, (_, i) => 21-i), 'expired-cursor')))
    .mockResolvedValueOnce(response({ code: 'CURSOR_RESTART_REQUIRED', error: 'Expired history cursor' }, 409))
    .mockResolvedValue(response(history(22, [22])));
  vi.stubGlobal('fetch', fetch);
  let reloadComparison = async () => false;
  function Harness() {
    const read = useDuplicateRead('cursor-cooldown-comparison', comparisonLoad, true, `CRM_DUPLICATE_DETAIL:v1:${user.organizationId}:${user.id}`);
    reloadComparison = read.reload;
    return <ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={comparison()} onRefresh={async () => true} /></MemoryRouter></ServoraAntProvider>;
  }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<Harness />); }); await flush();
  await act(async () => { button('Daha eski kararlar').click(); }); await flush();
  expect(historySeqs()).toEqual([]);
  await act(async () => { await reloadComparison(); }); await flush();
  expect(historySeqs()).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); await flush();
  expect(historySeqs()).toEqual([22]);
  expect(new URL(fetch.mock.calls[2]![0], 'https://example.invalid').searchParams.has('cursor')).toBe(false);
});
