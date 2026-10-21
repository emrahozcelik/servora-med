/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { DuplicateRegisterView } from '../src/DuplicateReviewRegister';
import { parseDuplicateRegisterPage } from '../src/services/duplicate-customers-api';
import { canAccessRoute } from '../src/shell/route-access';
import { matchRouteIdentity } from '../src/shell/route-identity';

const review = {
  id: '20000000-0000-4000-8000-000000000001', version: 2,
  reviewStatus: 'DISMISSED', effectiveStatus: 'DISMISSED', freshness: 'CURRENT', freshnessReason: null,
  currentDecision: { eventId: '30000000-0000-4000-8000-000000000001', seq: 2, status: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER', actorUserId: '40000000-0000-4000-8000-000000000001', decidedAt: '2026-10-20T10:00:00.000Z' },
  lastDecision: null,
};
const pair = { customerAId: '10000000-0000-4000-8000-000000000001', customerBId: '10000000-0000-4000-8000-000000000002' };
const row = (overrides: Record<string, unknown> = {}) => ({
  reviewId: review.id, pair, sourceAvailability: 'AVAILABLE',
  customerA: { id: pair.customerAId, name: 'Sentetik Klinik', status: 'active', city: 'İstanbul', district: 'Merkez' },
  customerB: { id: pair.customerBId, name: 'SENTETİK KLİNİK', status: 'inactive', city: null, district: null },
  matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [], comparisonStatus: 'READY', review,
  ...overrides,
});
const page = (items: unknown[], pageOverrides: Record<string, unknown> = {}) => ({
  asOf: '2026-10-20T10:00:00.000Z', matchingRuleVersion: 'crm-duplicate-v1', items,
  page: { nextCursor: null, exhausted: true, evaluatedReviews: items.length, returnedItems: items.length, ...pageOverrides },
});

it('READ-05: register parser accepts bounded pages and rejects unsafe unavailable rows', () => {
  const parsed = parseDuplicateRegisterPage(page([row()]));
  expect(parsed.items[0]!.customerA?.name).toBe('Sentetik Klinik');
  expect(() => parseDuplicateRegisterPage(page([row({ sourceAvailability: 'UNAVAILABLE', customerA: row().customerA, customerB: null, comparisonStatus: 'UNAVAILABLE' })]))).toThrow();
  expect(() => parseDuplicateRegisterPage(page([row()], { returnedItems: 2 }))).toThrow();
  expect(() => parseDuplicateRegisterPage(page([row()], { exhausted: false, nextCursor: null }))).toThrow();
  expect(() => parseDuplicateRegisterPage(page(Array.from({ length: 21 }, () => row())))).toThrow();
});

it('READ-05, UI-08: unavailable sources stay listed without headers and without a comparison link', () => {
  const data = parseDuplicateRegisterPage(page([row({
    sourceAvailability: 'UNAVAILABLE', customerA: null, customerB: null, matchingCodes: [], comparisonStatus: 'UNAVAILABLE',
    review: { ...review, effectiveStatus: 'UNAVAILABLE', freshness: 'STALE', freshnessReason: 'SOURCE_UNAVAILABLE' },
  })]));
  const html = renderToStaticMarkup(<MemoryRouter><DuplicateRegisterView data={data} error={null} busy={false} onReload={() => {}} onFirst={() => {}} onNext={() => {}} /></MemoryRouter>);
  expect(html).toContain('Kaynak müşteriler artık kullanılamıyor');
  expect(html).toContain('İnceleme kaydı');
  expect(html).toContain('Kaynak kullanılamıyor');
  expect(html).not.toContain('İncelemeyi aç');
  expect(html).not.toContain('Mükerrer olarak doğrula');
});

it('UI-02/09: available rows keep distinct A/B identities, safe decision fields and a keyboard link', () => {
  const data = parseDuplicateRegisterPage(page([row()]));
  const html = renderToStaticMarkup(<MemoryRouter><DuplicateRegisterView data={data} error={null} busy={false} onReload={() => {}} onFirst={() => {}} onNext={() => {}} /></MemoryRouter>);
  expect(html).toContain('Müşteri A'); expect(html).toContain('Müşteri B');
  expect(html).toContain('Sentetik Klinik'); expect(html).toContain('SENTETİK KLİNİK');
  expect(html).toContain('Ayrı müşteri');
  expect(html).toContain(`/customers/duplicate-review-pairs/${pair.customerAId}/${pair.customerBId}`);
  expect(html).not.toContain('Mükerrer olarak doğrula');
});

it('READ-03, UI-08: register distinguishes empty attention, continuation and read-only notice', () => {
  const render = (data: ReturnType<typeof parseDuplicateRegisterPage> | null, laterPage = false) =>
    renderToStaticMarkup(<MemoryRouter><DuplicateRegisterView data={data} error={null} busy={false} onReload={() => {}} onFirst={() => {}} onNext={() => {}} laterPage={laterPage} /></MemoryRouter>);
  expect(render(parseDuplicateRegisterPage(page([])))).toContain('İlgilenilmesi gereken inceleme kaydı yok');
  const continuation = render(parseDuplicateRegisterPage(page([], { exhausted: false, nextCursor: 'cursor' })));
  expect(continuation).toContain('Kayıtları sürdür');
  expect(continuation).not.toContain('İlgilenilmesi gereken inceleme kaydı yok');
  expect(render(null)).toContain('hiçbir müşteri kaydını değiştirmez');
});

it('UI-01: the register route is management-only and resolves its own identity', () => {
  const user = { role: 'MANAGER', capabilities: { duplicateCustomerComparison: true } } as const;
  expect(canAccessRoute('duplicateReviewRegister', user)).toBe(true);
  expect(canAccessRoute('duplicateReviewRegister', { ...user, role: 'STAFF' } as never)).toBe(false);
  expect(canAccessRoute('duplicateReviewRegister', { ...user, capabilities: {} } as never)).toBe(false);
  expect(matchRouteIdentity('/customers/duplicate-reviews')?.identity).toMatchObject({ id: 'duplicateReviewRegister', parentId: 'duplicateCustomers' });
});
