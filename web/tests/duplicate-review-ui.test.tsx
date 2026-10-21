/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DuplicateReviewPanel } from '../src/DuplicateReviewPanel';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import type { CurrentUser } from '../src/services/api';
import { readDuplicateAttempt, writeDuplicateAttempt } from '../src/duplicate-review-attempt';

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
  expect(window.sessionStorage.length).toBe(0);
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

it('F11: an uncertain submitted attempt blocks new commands through changed GET and reload, but still permits exact replay', async () => {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/history')) return new Response(JSON.stringify(history), { status: 200 });
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length === 1) throw new TypeError('lost response');
    return new Response(JSON.stringify(receipt), { status: 200 });
  }));
  await render(pending);
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
  await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); });
  await confirmDialog();
  const saved = window.sessionStorage.getItem(window.sessionStorage.key(0)!)!;
  expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { root.unmount(); }); host.remove();
  await render(terminal);
  expect((button('Yeniden incele') as HTMLButtonElement).disabled).toBe(true);
  expect(button('Güncel kanıtı inceledim; yeni istek oluştur')).toBeNull();
  expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toBe(saved);
  expect(button('Özgün isteği tekrar dene')).not.toBeNull();
  await act(async () => { click(button('Özgün isteği tekrar dene')); await flush(); });
  expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]);
  expect(window.sessionStorage.length).toBe(0);
});

it('F17: reload before confirmation cannot restore a POST retry, and storage failure prevents submission', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await render(pending);
  async function prepare() {
    await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
    await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { click(button('Mükerrer olarak doğrula')); });
  }
  await prepare();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(window.sessionStorage.length).toBe(0);
  await act(async () => { root.unmount(); }); host.remove();
  await render(pending);
  expect(button('Özgün isteği tekrar dene')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await prepare();
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  try {
    await confirmDialog();
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('İşlem gönderilmedi');
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  } finally { write.mockRestore(); }
});

it('F12/A12-S3: draft keeps focus for witness-only refresh and requires explicit inspection after semantic evidence changes', async () => {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(receipt), { status: 200 });
  }));
  await render(pending);
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
  const select = host.querySelector('select') as HTMLSelectElement;
  await act(async () => { select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); select.focus(); });
  async function refresh(data: typeof pending) {
    await act(async () => { root.render(<ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={data as never} onRefresh={vi.fn()} /></MemoryRouter></ServoraAntProvider>); });
  }
  await refresh({ ...pending, customerA: { ...customer, version: 2 } });
  expect(document.activeElement).toBe(select); expect(select.value).toBe('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(false);
  const changed = { ...pending, evidence: { ...evidence, revision: 'ev1.synthetic.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } };
  await refresh(changed);
  expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
  expect(select.value).toBe('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(posts).toHaveLength(0);
  await act(async () => { click(button('Güncel kanıtı inceledim')); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); });
  await confirmDialog();
  expect(posts[0]).toMatchObject({ expectedEvidenceRevision: changed.evidence.revision, expectedReviewVersion: 0 });
});

it('F19: Retry-After survives reload and blocks every command control until exact retry is allowed', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length > 1) return new Response(JSON.stringify(receipt), { status: 200 });
    return new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', error: 'Kota dolu' }), { status: 429, headers: { 'Retry-After': '30' } });
  }));
  try {
    await render(pending);
    await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
    await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { click(button('Mükerrer olarak doğrula')); });
    await confirmDialog();
    expect(posts).toHaveLength(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect((button('Özgün isteği tekrar dene') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { root.unmount(); }); host.remove();
    await render(pending);
    expect((button('Özgün isteği tekrar dene') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { click(button('Özgün isteği tekrar dene')); await vi.advanceTimersByTimeAsync(29_999); });
    expect(posts).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { click(button('Özgün isteği tekrar dene')); await flush(); });
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]);
  } finally { vi.useRealTimers(); }
});

it('F15: immutable receipt success is separate from pending, failed and successful current GET reconciliation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 })));
  let resolve!: (ok: boolean) => void;
  const refresh = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
  await render(pending, refresh as never);
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
  await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); });
  await confirmDialog();
  expect(host.textContent).toContain('İnceleme kararı kaydedildi');
  expect(host.textContent).not.toContain('Güncel durum yüklendi');
  expect(host.textContent).toContain('Güncel durum doğrulanıyor');
  await act(async () => { resolve(false); await flush(); });
  expect(host.textContent).toContain('Güncel durum doğrulanamadı');
  expect(host.textContent).not.toContain('Güncel durum yüklendi');
  await act(async () => { click(button('Güncel durumu doğrula')); });
  await act(async () => { resolve(true); await flush(); });
  expect(host.textContent).toContain('Güncel durum yüklendi');
});

it('F11/UI-04: storage is actor/org/pair-bound, does not expire unresolved requests or accept overwrite', () => {
  const frozen = { version: 1 as const, kind: 'REOPEN' as const, clientActionId: 'original', expectedReviewVersion: 1, expectedEvidenceRevision: evidence.revision, matchingRuleVersion: evidence.matchingRuleVersion, createdAt: 0 };
  writeDuplicateAttempt(user.organizationId, user.id, 'a', 'b', frozen);
  expect(readDuplicateAttempt(user.organizationId, user.id, 'b', 'a')).toEqual(frozen);
  expect(readDuplicateAttempt(user.organizationId, 'another-actor', 'a', 'b')).toBeNull();
  expect(readDuplicateAttempt('another-org', user.id, 'a', 'b')).toBeNull();
  expect(() => writeDuplicateAttempt(user.organizationId, user.id, 'a', 'b', { ...frozen, clientActionId: 'replacement' })).toThrow('İşlem gönderilmedi');
  expect(readDuplicateAttempt(user.organizationId, user.id, 'a', 'b')).toEqual(frozen);
});

it('F12/UI-07: a concurrent manager review version change cannot rebind an unsent draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(history), { status: 200 })));
  await render(pending);
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
  await act(async () => { const select = host.querySelector('select') as HTMLSelectElement; select.value = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const changed = { ...pending, review: { ...pending.review, id: 'review-1', version: 2, freshness: 'CURRENT', lastDecision: terminal.review.lastDecision } };
  await act(async () => { root.render(<ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={changed as never} onRefresh={vi.fn()} /></MemoryRouter></ServoraAntProvider>); });
  expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
  expect(button('Güncel kanıtı inceledim')).not.toBeNull();
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
});

it('UI-09: cancelling reopen restores keyboard focus to its persistent trigger', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(history), { status: 200 })));
  await render(terminal);
  const trigger = button('Yeniden incele') as HTMLButtonElement;
  await act(async () => { trigger.focus(); trigger.click(); });
  await act(async () => { click(button('Vazgeç')); await flush(); });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.isConnected).toBe(true); expect(trigger.disabled).toBe(false);
});

it.each([500, 503, 'invalid'] as const)('F11/UI-06: POST %s retains the original payload through reload without generating another UUID', async (status) => {
  const frozen = { version: 1 as const, kind: 'DECIDE' as const, clientActionId: 'confirmed-original-action', expectedReviewVersion: 0,
    expectedEvidenceRevision: evidence.revision, matchingRuleVersion: evidence.matchingRuleVersion,
    decision: 'CONFIRMED_DUPLICATE' as const, reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' as const, createdAt: 0 };
  writeDuplicateAttempt(user.organizationId, user.id, 'a', 'b', frozen);
  const posts: unknown[] = []; const uuid = vi.spyOn(crypto, 'randomUUID');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    if (posts.length > 1) return new Response(JSON.stringify(receipt), { status: 200 });
    return status === 'invalid' ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify({ error: 'Synthetic uncertain outcome', code: 'INTERNAL_ERROR' }), { status });
  }));
  try {
    await render(pending);
    await act(async () => { click(button('Özgün isteği tekrar dene')); await flush(); });
    expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
    expect(readDuplicateAttempt(user.organizationId, user.id, 'a', 'b')).toEqual(frozen);
    await act(async () => { root.unmount(); }); host.remove();
    await render(pending);
    await act(async () => { click(button('Özgün isteği tekrar dene')); await flush(); });
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(uuid).not.toHaveBeenCalled();
  } finally { uuid.mockRestore(); }
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

async function prepareRecoveryDecision() {
  await act(async () => { (host.querySelector('input[value="CONFIRMED_DUPLICATE"]') as HTMLInputElement).click(); });
  await act(async () => { const select=host.querySelector('select') as HTMLSelectElement; select.value='SAME_OPERATIONAL_CUSTOMER_VERIFIED';select.dispatchEvent(new Event('change',{bubbles:true})); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); }); await confirmDialog();
}
it('Conflict recovery: failed conflict reconciliation must keep renewed inspection disabled', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:'EVIDENCE_CHANGED',error:'Synthetic conflict'}),{status:409})));
  const refresh=vi.fn().mockResolvedValue(false); await render(pending,refresh); await prepareRecoveryDecision();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(button('Güncel kanıtı inceledim')).toBeTruthy();
  expect((button('Güncel kanıtı inceledim') as HTMLButtonElement).disabled).toBe(true);
});

it('Definitive source recovery: definitive POST source 404 must not remain an uncertain submitted attempt', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:'DUPLICATE_PAIR_NOT_FOUND',error:'Synthetic deleted source'}),{status:404})));
  await render(pending,vi.fn().mockResolvedValue(false)); await prepareRecoveryDecision();
  expect(readDuplicateAttempt(user.organizationId,user.id,'a','b')).toBeNull();
});

it('Evidence overflow recovery: definitive POST 422 clears the attempt and requires successful current GET', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'EVIDENCE_LIMIT_EXCEEDED', error: 'Synthetic evidence overflow' }), { status: 422 })));
  const refresh = vi.fn().mockResolvedValue(false);
  await render(pending, refresh); await prepareRecoveryDecision();
  expect(readDuplicateAttempt(user.organizationId, user.id, 'a', 'b')).toBeNull();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(button('Özgün isteği tekrar dene')).toBeNull();
  expect((button('Güncel kanıtı inceledim') as HTMLButtonElement).disabled).toBe(true);
  expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
});

it('Conflict recovery: pending and failed GET cannot acknowledge; successful GET still requires explicit inspection and a fresh confirmed intent', async () => {
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return posts.length === 1
      ? new Response(JSON.stringify({ code: 'EVIDENCE_CHANGED', error: 'Synthetic conflict' }), { status: 409 })
      : new Response(JSON.stringify(receipt), { status: 200 });
  }));
  let resolveRefresh!: (value: boolean) => void;
  const refresh = vi.fn().mockReturnValueOnce(new Promise<boolean>(resolve => { resolveRefresh = resolve; })).mockResolvedValue(false);
  await render(pending, refresh); await prepareRecoveryDecision();
  expect((button('Güncel kanıtı inceledim') as HTMLButtonElement).disabled).toBe(true);
  expect(posts).toHaveLength(1);
  await act(async () => { resolveRefresh(false); }); await flush();
  expect(host.textContent).not.toContain('İşlem makbuzu kaydedildi');
  expect((button('Güncel kanıtı inceledim') as HTMLButtonElement).disabled).toBe(true);
  click(button('Güncel kanıtı inceledim')); await flush(); expect(posts).toHaveLength(1);
  let resolveRetry!: (value: boolean) => void;
  refresh.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveRetry = resolve; }));
  await act(async () => { click(button('Güncel durumu doğrula')); });
  const fresh = { ...pending, evidence: { ...pending.evidence, revision: 'ev1.synthetic.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } };
  await act(async () => { root.render(<ServoraAntProvider><MemoryRouter><DuplicateReviewPanel user={user} aId="a" bId="b" data={fresh} onRefresh={refresh} /></MemoryRouter></ServoraAntProvider>); resolveRetry(true); }); await flush();
  expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { click(button('Güncel kanıtı inceledim')); });
  await act(async () => { click(button('Mükerrer olarak doğrula')); });
  expect(posts).toHaveLength(1);
  await confirmDialog();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.clientActionId).not.toBe(posts[0]!.clientActionId);
  expect(posts[1]!.expectedEvidenceRevision).toBe(fresh.evidence.revision);
});

it.each([[404, 'DUPLICATE_PAIR_NOT_FOUND'], [422, 'EVIDENCE_LIMIT_EXCEEDED']] as const)('Definitive recovery: REOPEN %s/%s clears only the known no-commit attempt and blocks stale retry/new intent', async (status, code) => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Response(JSON.stringify({ code, error: 'Synthetic no-commit outcome' }), { status })
    : new Response(JSON.stringify(history), { status: 200 })));
  const refresh = vi.fn().mockResolvedValue(false);
  await render(terminal, refresh);
  await act(async () => { click(button('Yeniden incele')); }); await confirmDialog();
  expect(readDuplicateAttempt(user.organizationId, user.id, 'a', 'b')).toBeNull();
  expect(button('Yeniden inceleme isteğini tekrar dene')).toBeNull();
  expect((button('Yeniden incele') as HTMLButtonElement).disabled).toBe(true);
  expect((button('Güncel kanıtı inceledim') as HTMLButtonElement).disabled).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it.each([[401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'], [404, 'UNKNOWN_NOT_FOUND'], [422, 'UNKNOWN_VALIDATION'], [503, 'EVIDENCE_LIMIT_EXCEEDED']] as const)(
  'Definitive source recovery: HTTP %s/%s cannot prove a prior uncertain command did not commit', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code, error: 'Synthetic access failure' }), { status })));
    await render(pending); await prepareRecoveryDecision();
    const stored = readDuplicateAttempt(user.organizationId, user.id, 'a', 'b');
    expect(stored?.clientActionId).toBeTruthy();
    expect(button('Özgün isteği tekrar dene')).not.toBeNull();
    expect((button('Mükerrer olarak doğrula') as HTMLButtonElement).disabled).toBe(true);
  },
);
