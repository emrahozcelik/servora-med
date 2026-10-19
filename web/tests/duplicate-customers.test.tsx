/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { DuplicateCandidateView, DuplicateComparisonView } from '../src/DuplicateCustomers';
import { canAccessRoute } from '../src/shell/route-access';
import { matchRouteIdentity } from '../src/shell/route-identity';

it('READ-04, UI-01: distinguishes exhausted empty, continuation, error and read-only loading', () => {
  const render = (props: Partial<Parameters<typeof DuplicateCandidateView>[0]>) => renderToStaticMarkup(<MemoryRouter><DuplicateCandidateView data={null} error={null} busy={false} onReload={() => {}} onFirst={() => {}} onNext={() => {}} {...props} /></MemoryRouter>);
  expect(render({ busy: true })).toContain('Adaylar yükleniyor');
  const page = { scope: { dataClass: 'BUSINESS', includesInactive: true, anchorCustomerId: null }, asOf: '2026-10-19T10:00:00.000Z', matchingRuleVersion: 'crm-duplicate-v1', coverage: 'COMPLETE_SOURCE', rawPairCount: '0', largestNameGroupSize: 0, largestPhoneGroupSize: 0, items: [], page: { nextCursor: null, exhausted: true, evaluatedPairs: 0, returnedItems: 0 } } as const;
  expect(render({ data: page })).toContain('Bu kapsamda aday bulunamadı');
  const continuation = render({ data: { ...page, page: { ...page.page, nextCursor: 'cursor', exhausted: false } } });
  expect(continuation).toContain('Taramayı sürdür');
  expect(continuation).not.toContain('Bu kapsamda aday bulunamadı');
  expect(render({ error: new Error('Bağlantı kesildi') })).not.toContain('Bu kapsamda aday bulunamadı');
  expect(render({})).toContain('Salt okunur');
  expect(render({})).not.toContain('Mükerrer olarak doğrula');
});

it('UI-01: grants duplicate routes only to enabled managers and resolves their own route identity', () => {
  const user = { role: 'MANAGER', capabilities: { duplicateCustomerComparison: true } } as const;
  expect(canAccessRoute('duplicateCustomers', user)).toBe(true);
  expect(canAccessRoute('duplicateComparison', { ...user, role: 'STAFF' } as never)).toBe(false);
  expect(canAccessRoute('duplicateCustomers', { ...user, capabilities: {} } as never)).toBe(false);
  expect(matchRouteIdentity('/customers/duplicate-candidates')?.identity.id).toBe('duplicateCustomers');
});

it('UI-02/09: comparison keeps distinct A/B values per field and exposes no review commands', () => {
  const customer = { id: 'a', name: 'Uzun Sentetik Türkçe Klinik', status: 'active', city: null, district: null, address: null, customerType: 'clinic', taxNumber: null, phone: '+905321234567', email: null, version: 1, assignedStaffUserId: null, contacts: [] };
  const data = { pair: { customerAId: 'a', customerBId: 'b' }, customerA: customer, customerB: { ...customer, id: 'b', status: 'inactive' }, asOf: '2026-10-19T10:00:00.000Z', evidence: { revision: 'synthetic', matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [] } } as never;
  const html = renderToStaticMarkup(<MemoryRouter><DuplicateComparisonView data={data} /></MemoryRouter>);
  expect(html).toContain('Müşteri A'); expect(html).toContain('Müşteri B');
  expect(html).toContain('Alan: Telefon'); expect(html).toContain('Eşleşen bilgi');
  expect(html).toContain('Salt okunur'); expect(html).not.toContain('Mükerrer olarak doğrula');
  expect(html).toContain('/customers/a'); expect(html).toContain('/customers/b');
});
