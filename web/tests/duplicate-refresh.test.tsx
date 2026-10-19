/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { useDuplicateRead } from '../src/useDuplicateRead';
import { DuplicateCandidateView } from '../src/DuplicateCustomers';
import { ApiError } from '../src/services/api';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const a = { id: 'a', name: 'SYNTHETIC OLD CUSTOMER', status: 'active', city: null, district: null };
const page = { scope: { dataClass: 'BUSINESS', includesInactive: true, anchorCustomerId: null }, asOf: '2026-10-19T10:00:00.000Z', matchingRuleVersion: 'crm-duplicate-v1', coverage: 'COMPLETE_SOURCE', rawPairCount: '1', largestNameGroupSize: 2, largestPhoneGroupSize: 2,
  items: [{ pair: { customerAId: 'a', customerBId: 'b' }, customerA: a, customerB: { ...a, id: 'b' }, matchingCodes: ['SAME_NAME'], warnings: [], comparisonStatus: 'READY' }],
  page: { nextCursor: null, exhausted: true, evaluatedPairs: 1, returnedItems: 1 } };

it.each([503, 401, 403, 404])('UI-08: refresh HTTP %s labels retained data stale and discards it after access loss', async (status) => {
  const load = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new ApiError(status, status === 403 ? 'FORBIDDEN' : 'REVIEW_TEMPORARILY_UNAVAILABLE', 'Synthetic refresh failed'));
  let reload = () => {};
  function Harness() {
    const state = useDuplicateRead('same-scope', load);
    reload = state.reload;
    return <MemoryRouter><DuplicateCandidateView {...state} onReload={reload} onFirst={reload} onNext={() => {}} /></MemoryRouter>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    expect(host.textContent).toContain('SYNTHETIC OLD CUSTOMER');
    await act(async () => { reload(); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Synthetic refresh failed');
    if ([401, 403, 404].includes(status)) expect(host.textContent).not.toContain('SYNTHETIC OLD CUSTOMER');
    else {
      expect(host.textContent).toContain('SYNTHETIC OLD CUSTOMER');
      expect(host.textContent).toContain('güncellikleri doğrulanamadı');
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it('UI-08: retained results remain labelled while a retry is pending', async () => {
  let resolveRetry!: (value: typeof page) => void;
  const load = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('Offline')).mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
  let reload = () => {};
  function Harness() {
    const state = useDuplicateRead('retry-scope', load); reload = state.reload;
    return <MemoryRouter><DuplicateCandidateView {...state} onReload={reload} onFirst={reload} onNext={() => {}} /></MemoryRouter>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { reload(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('güncellikleri doğrulanamadı');
    await act(async () => { reload(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('güncellikleri doğrulanamadı');
    await act(async () => { resolveRetry(page); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('RATE-05: 429 retains labelled data, respects Retry-After and recovers', async () => {
  vi.useFakeTimers();
  const quota = new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Synthetic quota', true);
  quota.retryAfterSeconds = 5;
  const load = vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(quota).mockResolvedValue(page);
  let reload = () => {};
  function Harness() {
    const state = useDuplicateRead('quota-scope', load); reload = state.reload;
    return <MemoryRouter><DuplicateCandidateView {...state} onReload={reload} onFirst={reload} onNext={() => {}} /></MemoryRouter>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { reload(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('güncellikleri doğrulanamadı');
    await act(async () => { reload(); await vi.advanceTimersByTimeAsync(4_999); reload(); });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); reload(); });
    expect(load).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('SYNTHETIC OLD CUSTOMER');
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); }
});
