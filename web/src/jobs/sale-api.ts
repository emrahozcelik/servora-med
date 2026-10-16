import { ApiError, boolean, json, nullableString, number, object, request, string } from '../services/api';
import { JOB_CARD_STATUSES, parseSaleQuantity, type JobCardStatus, type Paginated } from './jobs-api';

export type SaleContact = { id: string; name: string; title: string | null };
export type SaleLink = { access: 'RESTRICTED' } | { access: 'FULL'; id: string; title: string; status: JobCardStatus };
export type SaleSource = { access: 'RESTRICTED'; kind: 'SALE_FROM_VISIT' } | {
  access: 'FULL'; kind: 'SALE_FROM_VISIT'; id: string; title: string; status: JobCardStatus;
  versionAtCreation: number; titleSnapshot: string; customerNameSnapshot: string;
  plannedContact: SaleContact | null; metContact: SaleContact | null;
};
export type SaleDetails = {
  jobCardId: string; jobCardVersion: number; soldAt: string; saleContact: SaleContact | null;
  sourceVisit: SaleSource;
  items: Array<{ id: string; productId: string; name: string; sku: string | null;
    brand: string | null; model: string | null; unit: string | null; quantity: string }>;
};
function invalid(): never { throw new ApiError(0, 'INVALID_RESPONSE', 'Satış yanıtı geçersiz.'); }
function exact(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).some((key) => !keys.includes(key))) invalid();
  return row;
}
function status(value: unknown): JobCardStatus {
  if (typeof value !== 'string' || !(JOB_CARD_STATUSES as readonly string[]).includes(value)) invalid();
  return value as JobCardStatus;
}
function integer(value: unknown, minimum = 0) {
  const n = number(value, 'count');
  if (!Number.isSafeInteger(n) || n < minimum) invalid();
  return n;
}
function contact(value: unknown): SaleContact | null {
  if (value === null) return null;
  const row = exact(value, ['id', 'name', 'title']);
  return { id: string(row.id, 'contact.id'), name: string(row.name, 'contact.name'),
    title: nullableString(row.title, 'contact.title') };
}
function link(value: unknown): SaleLink {
  const row = object(value);
  if (row.access === 'RESTRICTED') { exact(row, ['access']); return { access: 'RESTRICTED' }; }
  if (row.access !== 'FULL') invalid();
  exact(row, ['access', 'id', 'title', 'status']);
  return { access: 'FULL', id: string(row.id, 'id'), title: string(row.title, 'title'), status: status(row.status) };
}
export function parseSaleDetails(value: unknown): SaleDetails {
  const row = exact(value, ['jobCardId', 'jobCardVersion', 'soldAt', 'saleContact', 'sourceVisit', 'items']);
  const source = object(row.sourceVisit);
  let sourceVisit: SaleSource;
  if (source.access === 'RESTRICTED') {
    exact(source, ['access', 'kind']);
    if (source.kind !== 'SALE_FROM_VISIT') invalid();
    sourceVisit = { access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' };
  } else {
    exact(source, ['access', 'kind', 'id', 'title', 'status', 'versionAtCreation', 'titleSnapshot',
      'customerNameSnapshot', 'plannedContact', 'metContact']);
    if (source.access !== 'FULL' || source.kind !== 'SALE_FROM_VISIT') invalid();
    sourceVisit = { access: 'FULL', kind: 'SALE_FROM_VISIT', id: string(source.id, 'source.id'),
      title: string(source.title, 'source.title'), status: status(source.status),
      versionAtCreation: integer(source.versionAtCreation, 1), titleSnapshot: string(source.titleSnapshot, 'source.titleSnapshot'),
      customerNameSnapshot: string(source.customerNameSnapshot, 'source.customerNameSnapshot'),
      plannedContact: contact(source.plannedContact), metContact: contact(source.metContact) };
  }
  const soldAt = string(row.soldAt, 'soldAt');
  if (!Number.isFinite(Date.parse(soldAt)) || new Date(soldAt).toISOString() !== soldAt) invalid();
  if (!Array.isArray(row.items) || row.items.length > 25) invalid();
  const items = row.items.map((value) => {
    const item = exact(value, ['id', 'productId', 'name', 'sku', 'brand', 'model', 'unit', 'quantity']);
    return { id: string(item.id, 'item.id'), productId: string(item.productId, 'productId'),
      name: string(item.name, 'name'), sku: nullableString(item.sku, 'sku'), brand: nullableString(item.brand, 'brand'),
      model: nullableString(item.model, 'model'), unit: nullableString(item.unit, 'unit'), quantity: parseSaleQuantity(item.quantity) };
  });
  if (new Set(items.map((item) => item.productId)).size !== items.length) invalid();
  return { jobCardId: string(row.jobCardId, 'jobCardId'), jobCardVersion: integer(row.jobCardVersion, 1),
    soldAt, saleContact: contact(row.saleContact), sourceVisit, items };
}
const salePath = (id: string) => '/api/job-cards/' + encodeURIComponent(id);
export async function getSaleDetails(id: string) {
  return parseSaleDetails(await request(salePath(id) + '/sale-details?includeSaleCapability=true'));
}
export async function listRelatedSales(id: string, offset = 0): Promise<Paginated<Exclude<SaleLink, { access: 'RESTRICTED' }>>> {
  const row = exact(await request(salePath(id) + '/sales?limit=20&offset=' + offset + '&includeSaleCapability=true'),
    ['items', 'total', 'limit', 'offset']);
  if (!Array.isArray(row.items)) invalid();
  const items = row.items.map(link);
  if (items.some((item) => item.access !== 'FULL')) invalid();
  return { items: items as Exclude<SaleLink, { access: 'RESTRICTED' }>[], total: integer(row.total),
    limit: integer(row.limit, 1), offset: integer(row.offset) };
}
export async function getSaleCreateContext(id: string) {
  const row = exact(await request(salePath(id) + '/sale-create-context?includeSaleCapability=true'),
    ['sourceVisitId', 'sourceVersion', 'eligible', 'blockedReason', 'customer', 'assignee', 'plannedContact', 'metContact', 'activeSale']);
  const identity = (value: unknown) => {
    const v = exact(value, ['id', 'name']); return { id: string(v.id, 'id'), name: string(v.name, 'name') };
  };
  const blockedReason = nullableString(row.blockedReason, 'blockedReason');
  if (blockedReason !== null && !['SOURCE_NOT_ELIGIBLE', 'REFERENCE_NOT_ELIGIBLE', 'ACTIVE_SALE_EXISTS'].includes(blockedReason)) invalid();
  return { sourceVisitId: string(row.sourceVisitId, 'sourceVisitId'), sourceVersion: integer(row.sourceVersion, 1),
    eligible: boolean(row.eligible, 'eligible'), blockedReason,
    customer: row.customer === null ? null : identity(row.customer), assignee: identity(row.assignee),
    plannedContact: contact(row.plannedContact), metContact: contact(row.metContact),
    activeSale: row.activeSale === null ? null : link(row.activeSale) };
}

export type SaleCreateContext = Awaited<ReturnType<typeof getSaleCreateContext>>;
export type SaleReceipt = { jobCardId: string; version: number };
export type SaleCreateInput = {
  clientActionId: string; expectedSourceVersion: number; title: string;
  description: string | null; soldAt: string; saleContactId: string | null;
  items: Array<{ productId: string; quantity: number }>;
};
export type SaleCorrection =
  | { kind: 'details'; input: { clientActionId: string; expectedVersion: number; soldAt?: string; saleContactId?: string | null } }
  | { kind: 'add'; input: { clientActionId: string; expectedVersion: number; productId: string; quantity: number } }
  | { kind: 'quantity'; itemId: string; input: { clientActionId: string; expectedVersion: number; quantity: number } }
  | { kind: 'remove'; itemId: string; input: { clientActionId: string; expectedVersion: number } };
function receipt(value: unknown): SaleReceipt {
  const row = exact(value, ['jobCardId', 'version']);
  return { jobCardId: string(row.jobCardId, 'jobCardId'), version: integer(row.version, 1) };
}
export async function createSaleFromVisit(id: string, input: SaleCreateInput) {
  return receipt(await request(salePath(id) + '/sales?includeSaleCapability=true', json('POST', input)));
}
export async function correctSale(id: string, attempt: SaleCorrection) {
  const suffix = attempt.kind === 'details' ? '/sale-details' : '/sale-items'
    + (attempt.kind === 'quantity' || attempt.kind === 'remove' ? '/' + encodeURIComponent(attempt.itemId) : '');
  return receipt(await request(salePath(id) + suffix + '?includeSaleCapability=true',
    json(attempt.kind === 'add' ? 'POST' : attempt.kind === 'remove' ? 'DELETE' : 'PATCH', attempt.input)));
}
