/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { DuplicateCandidateView } from '../src/DuplicateCustomers';
import type { DuplicatePage } from '../src/services/duplicate-customers-api';
import { useDuplicateRead } from '../src/useDuplicateRead';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const customerA = { id: 'a', name: 'SYNTHETIC OLD CUSTOMER', status: 'active' as const, city: null, district: null };
const customerB = { ...customerA, id: 'b' };
const readyPage: DuplicatePage = {
  scope: { dataClass: 'BUSINESS', includesInactive: true, anchorCustomerId: null },
  asOf: '2026-10-19T10:00:00.000Z',
  matchingRuleVersion: 'crm-duplicate-v1',
  coverage: 'COMPLETE_SOURCE',
  rawPairCount: '1',
  largestNameGroupSize: 2,
  largestPhoneGroupSize: 2,
  items: [{
    pair: { customerAId: 'a', customerBId: 'b' },
    customerA,
    customerB,
    matchingCodes: ['SAME_NAME'],
    warnings: [],
    comparisonStatus: 'READY',
  }],
  page: { nextCursor: null, exhausted: true, evaluatedPairs: 1, returnedItems: 1 },
};

function pageWith(comparisonStatus: DuplicatePage['items'][number]['comparisonStatus']): DuplicatePage {
  return { ...readyPage, items: [{ ...readyPage.items[0]!, comparisonStatus }] };
}

async function mount(comparisonStatus: DuplicatePage['items'][number]['comparisonStatus']) {
  const load = vi.fn().mockResolvedValue(pageWith(comparisonStatus));
  let reload = () => {};
  function Harness() {
    const state = useDuplicateRead(`f06-${comparisonStatus}`, load, true, `test:list:f06-${comparisonStatus}`); reload = state.reload;
    return <MemoryRouter><DuplicateCandidateView {...state} onReload={reload} onFirst={reload} onNext={() => {}} /></MemoryRouter>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
  return { host, root };
}

it.each(['OVER_BUDGET', 'UNVERIFIABLE'] as const)('F06: %s keeps reasons but has no comparison link', async (comparisonStatus) => {
  const { host, root } = await mount(comparisonStatus);
  try {
    expect(host.textContent).toContain('SYNTHETIC OLD CUSTOMER');
    expect(host.textContent).toContain('İsim aynı');
    expect(host.textContent).toContain('Kanıt bütünü doğrulanamadığı için bu çiftte karşılaştırma açılamaz');
    expect(host.querySelector('a[href*="duplicate-review-pairs"]')).toBeNull();
    expect(host.textContent).not.toContain('İki müşteriyi karşılaştır');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('F06: READY still exposes the comparison link', async () => {
  const { host, root } = await mount('READY');
  try {
    const link = host.querySelector('a[href*="duplicate-review-pairs"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('İki müşteriyi karşılaştır');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
