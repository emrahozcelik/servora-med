/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DuplicateReviewPanel } from '../src/DuplicateReviewPanel';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import type { CurrentUser } from '../src/services/api';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const user: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Manager', email: 'm@example.invalid', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true, duplicateCustomerComparison: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const pair = { customerAId: 'a', customerBId: 'b' };
const customer = {
  id: 'a', name: 'Sentetik Klinik', status: 'active', city: null, district: null, customerType: 'clinic',
  taxNumber: null, phone: '+905321234567', email: null, address: null, version: 1,
  assignedStaffUserId: null, contacts: [],
};
const evidence = { revision: 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME_AND_PHONE'] as const, warnings: [] as const };
const pending = {
  pair, asOf: '2026-10-20T10:00:00.000Z', customerA: customer, customerB: { ...customer, id: 'b', status: 'inactive' },
  evidence, review: { id: null, version: 0, reviewStatus: 'PENDING_REVIEW' as const, effectiveStatus: 'PENDING_REVIEW' as const,
    freshness: 'NOT_APPLICABLE' as const, freshnessReason: null, currentDecision: null, lastDecision: null },
  allowedActions: ['DECIDE' as const],
};
const terminal = {
  ...pending,
  review: { id: 'review-1', version: 1, reviewStatus: 'DISMISSED' as const, effectiveStatus: 'DISMISSED' as const,
    freshness: 'CURRENT' as const, freshnessReason: null,
    currentDecision: { eventId: 'event-1', seq: 1, status: 'DISMISSED' as const, reasonCode: 'DISTINCT_CUSTOMER' as const, actorUserId: 'manager-1', decidedAt: '2026-10-19T10:00:00.000Z' },
    lastDecision: { eventId: 'event-1', seq: 1, status: 'DISMISSED' as const, reasonCode: 'DISTINCT_CUSTOMER' as const, actorUserId: 'manager-1', decidedAt: '2026-10-19T10:00:00.000Z' } },
  allowedActions: ['REOPEN' as const],
};
const receipt = {
  reviewId: 'review-1', pair, reviewVersion: 1, eventId: 'event-1', eventKind: 'DECISION_RECORDED',
  resultingStatus: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED',
  actorUserId: 'manager-1', occurredAt: '2026-10-20T10:00:00.000Z',
};
const history = { reviewId: 'review-1', upperSeq: 1, items: [{ eventId: 'event-1', seq: 1, eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER', actorUserId: 'manager-1', occurredAt: '2026-10-19T10:00:00.000Z', matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME'], warnings: [] }], nextCursor: null };

let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

async function render(data: typeof pending | typeof terminal, onRefresh = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => {
    root.render(<ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={data as never} onRefresh={onRefresh} /></MemoryRouter></ServoraAntProvider>);
    await Promise.resolve();
  });
  return onRefresh;
}
function click(el: Element | null) { if (!el) throw new Error('element not found'); (el as HTMLElement).click(); }
function button(text: string) { return [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === text) ?? null; }
async function confirmDialog() { await flush(); click(button('Kararı kaydet') ?? button('Yeniden incelemeye aç')); await flush(); }

it('UI-03/UI-04: requires an explicit reason, freezes the attempt and records the decision only after confirmation', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/history')) return new Response(JSON.stringify(history), { status: 200 });
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ expectedReviewVersion: 0, expectedEvidenceRevision: evidence.revision, decision: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' });
    expect(body.clientActionId).toMatch(/^[0-9a-f-]{36}$/);
    return new Response(JSON.stringify(receipt), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const refresh = await render(pending);
  const confirmRadio = host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement;
  await act(async () => { confirmRadio.click(); await Promise.resolve(); });
  const submitBeforeReason = button('Mükerrer olarak doğrula') as HTMLButtonElement | null;
  expect(submitBeforeReason?.disabled).toBe(true);
  await act(async () => { click(submitBeforeReason); await Promise.resolve(); });
  expect(fetch).not.toHaveBeenCalled();
  const reason = host.querySelector('select') as HTMLSelectElement;
  await act(async () => { reason.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; reason.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); await Promise.resolve(); });
  expect(host.textContent).toContain('Müşteriler birleştirilmez');
  expect(window.sessionStorage.length).toBe(1);
  await confirmDialog();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('İnceleme kararı kaydedildi');
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('UI-06: a lost response keeps the exact frozen attempt and retries the same action id', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/history')) return new Response(JSON.stringify(history), { status: 200 });
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (fail) { fail = false; throw new TypeError('network dropped'); }
    return new Response(JSON.stringify(receipt), { status: 200 });
  }));
  await render(pending);
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); await Promise.resolve(); });
  await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); await Promise.resolve(); });
  await confirmDialog();
  expect(host.textContent).toContain('Aynı istek korunuyor');
  expect(button('Özgün isteği tekrar dene')).not.toBeNull();
  const saved = JSON.parse(window.sessionStorage.getItem(window.sessionStorage.key(0)!)!);
  expect(saved.clientActionId).toBe(calls[0]!.body.clientActionId);
  await act(async () => { click(button('Özgün isteği tekrar dene')); await flush(); });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body.clientActionId).toBe(calls[0]!.body.clientActionId);
  expect(host.textContent).toContain('İnceleme kararı kaydedildi');
});

it('UI-05/UI-07: changed evidence marks a frozen attempt stale and requires renewed inspection without rebinding', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(history), { status: 200 })));
  await render(pending);
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); await Promise.resolve(); });
  await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); await Promise.resolve(); });
  await act(async () => { root.render(<ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={{ ...pending, evidence: { ...evidence, revision: 'ev1.synthetic.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } } as never} onRefresh={vi.fn()} /></MemoryRouter></ServoraAntProvider>); await flush(); });
  expect(host.textContent).toContain('Kanıt veya inceleme sürümü değişti');
  expect(button('Güncel kanıtı inceledim; yeni istek oluştur')).not.toBeNull();
  await act(async () => { click(button('Güncel kanıtı inceledim; yeni istek oluştur')); await flush(); });
  expect(host.textContent).not.toContain('Kanıt veya inceleme sürümü değişti');
  expect(window.sessionStorage.length).toBe(0);
});

it('UI-03/CMD-04: reopen is an explicit confirmed command and history is visible without raw audit data', async () => {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/history')) return new Response(JSON.stringify(history), { status: 200 });
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ...receipt, eventId: 'event-2', eventKind: 'REVIEW_REOPENED', reviewVersion: 2, resultingStatus: 'PENDING_REVIEW', reasonCode: 'RECHECK_REQUESTED' }), { status: 200 });
  }));
  await render(terminal);
  await flush();
  expect(host.textContent).toContain('Karar geçmişi');
  expect(host.textContent).toContain('Ayrı müşteri');
  expect(host.textContent).not.toContain('evidenceDigest');
  await act(async () => { click(button('Yeniden incele')); await Promise.resolve(); });
  expect(host.textContent).toContain('Eski karar silinmez');
  await confirmDialog();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ expectedReviewVersion: 1, expectedEvidenceRevision: evidence.revision });
  expect(host.textContent).toContain('İnceleme yeniden açıldı');
});
