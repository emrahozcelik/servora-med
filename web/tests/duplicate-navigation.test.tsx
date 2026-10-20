/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DuplicateComparisonScreen } from '../src/DuplicateCustomers';
import type { CurrentUser } from '../src/services/api';
import { withRoute } from './route-test-helpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const manager: CurrentUser = {
  id: 'm1', organizationId: 'o1', name: 'M', email: 'm@b.c', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true, duplicateCustomerComparison: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const pairPath = '/customers/duplicate-review-pairs/a/b';
const customer = { id: 'a', name: 'Sentetik Eski Müşteri', status: 'active', city: null, district: null, customerType: 'clinic', taxNumber: null, phone: '+905321234567', email: null, address: null, version: 1, assignedStaffUserId: null, contacts: [{ id: 'c1', name: 'Sentetik İlgili Kişi', title: null, phone: null, email: null, isPrimary: true, isActive: true, version: 1 }] };
const comparison = { pair: { customerAId: 'a', customerBId: 'b' }, asOf: '2026-10-19T10:00:00.000Z', customerA: customer, customerB: { ...customer, id: 'b' }, evidence: { revision: 'synthetic', schemaVersion: 1, matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME'], warnings: [] }, review: { id: null, version: 0, reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW', freshness: 'NOT_APPLICABLE', freshnessReason: null, currentDecision: null, lastDecision: null }, allowedActions: [] };

const listState = { from: { pathname: '/customers/duplicate-candidates', search: '?cursor=abc&anchorCustomerId=a', hash: '' }, duplicateFocus: 'duplicate-a-b' };
let host: HTMLDivElement;
let root: Root;

async function mount(state?: unknown) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => {
    root.render(withRoute(pairPath, <DuplicateComparisonScreen user={manager} />, { user: manager, state }));
    await Promise.resolve();
  });
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

it('F08: comparison renders one canonical return link preserving list context', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  await mount(listState);
  const links = [...host.querySelectorAll('a')].filter((link) => !link.closest('.route-breadcrumb') && link.getAttribute('href')?.startsWith('/customers/duplicate-candidates'));
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('href')).toBe('/customers/duplicate-candidates?cursor=abc&anchorCustomerId=a');
  expect(host.textContent).not.toContain('Aday listesine dön');
});

it('F08: direct comparison deep-link falls back to the safe parent route', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  await mount();
  const links = [...host.querySelectorAll('a')].filter((link) => !link.closest('.route-breadcrumb') && link.getAttribute('href')?.startsWith('/customers/duplicate-candidates'));
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('href')).toBe('/customers/duplicate-candidates');
});

it('F09: missing pair renders the 404 not-found state, not a transient read error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: 'Karşılaştırılabilir müşteri çifti bulunamadı.',
    code: 'DUPLICATE_PAIR_NOT_FOUND',
  }), { status: 404, headers: { 'content-type': 'application/json' } })));
  await mount(listState);
  await settle();
  expect(host.querySelector('.servora-result-state h2')?.textContent).toBe('Karşılaştırılabilir müşteri çifti bulunamadı');
  expect(host.textContent).not.toContain('aday bulunmadığı anlamına gelmez');
  expect(host.querySelector('.ant-result-404')).not.toBeNull();
  const links = [...host.querySelectorAll('a')].filter((link) => !link.closest('.route-breadcrumb') && link.getAttribute('href')?.startsWith('/customers/duplicate-candidates'));
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('href')).toBe('/customers/duplicate-candidates?cursor=abc&anchorCustomerId=a');
});

it('F09: a 404 after a successful comparison clears the old customer and contact data', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify(comparison), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: 'Karşılaştırılabilir müşteri çifti bulunamadı.', code: 'DUPLICATE_PAIR_NOT_FOUND' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }));
  await mount(listState);
  await settle();
  expect(host.textContent).toContain('Sentetik Eski Müşteri');
  expect(host.textContent).toContain('Sentetik İlgili Kişi');
  const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Yenile');
  await act(async () => { refresh?.click(); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  expect(host.textContent).not.toContain('Sentetik Eski Müşteri');
  expect(host.textContent).not.toContain('Sentetik İlgili Kişi');
  expect(host.querySelector('.servora-result-state h2')?.textContent).toBe('Karşılaştırılabilir müşteri çifti bulunamadı');
  expect(host.querySelector('.ant-result-404')).not.toBeNull();
});
