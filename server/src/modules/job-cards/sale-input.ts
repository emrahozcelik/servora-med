import { boundedTrimmedString, isoInstant, optionalBoundedString, requireActionId, uuidString, validation } from './validation.js';

export const MAX_SALE_ITEMS = 25;

function record(value: unknown, fields: readonly string[], field = 'body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation(field);
  if (Object.keys(value).some((key) => !fields.includes(key))) throw validation(field);
  return value as Record<string, unknown>;
}

export function parseSaleQuantityPatch(value: unknown) {
  const input = record(value, ['clientActionId', 'expectedVersion', 'quantity']);
  return { clientActionId: requireActionId(input.clientActionId),
    expectedVersion: saleVersion(input.expectedVersion), quantity: saleQuantity(input.quantity) };
}

export function parseSaleRemoval(value: unknown) {
  const input = record(value, ['clientActionId', 'expectedVersion']);
  return { clientActionId: requireActionId(input.clientActionId), expectedVersion: saleVersion(input.expectedVersion) };
}

export function parseSaleAddition(value: unknown) {
  const input = record(value, ['clientActionId', 'expectedVersion', 'productId', 'quantity']);
  return { clientActionId: requireActionId(input.clientActionId), expectedVersion: saleVersion(input.expectedVersion),
    productId: uuidString(input.productId, 'productId').toLowerCase(), quantity: saleQuantity(input.quantity) };
}

export function parseSaleDetailsPatch(value: unknown) {
  const input = record(value, ['clientActionId', 'expectedVersion', 'soldAt', 'saleContactId']);
  const fields: { soldAt?: string; saleContactId?: string | null } = {};
  if (Object.hasOwn(input, 'soldAt')) fields.soldAt = isoInstant(input.soldAt, 'soldAt');
  if (Object.hasOwn(input, 'saleContactId')) {
    fields.saleContactId = input.saleContactId === null ? null : uuidString(input.saleContactId, 'saleContactId').toLowerCase();
  }
  if (Object.keys(fields).length === 0) throw validation('body');
  return { clientActionId: requireActionId(input.clientActionId), expectedVersion: saleVersion(input.expectedVersion), fields };
}

export function saleVersion(value: unknown, field = 'expectedVersion'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 1 || value > 2_147_483_647) throw validation(field);
  return value;
}

export function saleQuantity(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 1 || value > 999_999_999) throw validation('quantity');
  // Keep the v1 request-hash representation for replay of pre-SALE-QTY-001 receipts.
  // Public readers present counts separately; this is not a measurement unit.
  return value.toFixed(3);
}

export type SaleFromVisitCreateInput = {
  clientActionId: string;
  expectedSourceVersion: number;
  title: string;
  description: string | null;
  soldAt: string;
  saleContactId: string | null;
  items: Array<{ productId: string; quantity: string }>;
};

export function parseSaleFromVisitCreateInput(value: unknown): SaleFromVisitCreateInput {
  const input = record(value, [
    'clientActionId', 'expectedSourceVersion', 'title', 'description', 'soldAt', 'saleContactId', 'items',
  ]);
  if (!Array.isArray(input.items) || input.items.length < 1
    || input.items.length > MAX_SALE_ITEMS) throw validation('items');
  const items = input.items.map((value) => {
    const item = record(value, ['productId', 'quantity'], 'items');
    return { productId: uuidString(item.productId, 'productId').toLowerCase(), quantity: saleQuantity(item.quantity) };
  });
  if (new Set(items.map((item) => item.productId)).size !== items.length) throw validation('items');
  return {
    clientActionId: requireActionId(input.clientActionId),
    expectedSourceVersion: saleVersion(input.expectedSourceVersion, 'expectedSourceVersion'),
    title: boundedTrimmedString(input.title, 'title', 1, 255),
    description: optionalBoundedString(input.description, 'description', 4000),
    soldAt: isoInstant(input.soldAt, 'soldAt'),
    saleContactId: input.saleContactId == null ? null : uuidString(input.saleContactId, 'saleContactId').toLowerCase(),
    items,
  };
}
