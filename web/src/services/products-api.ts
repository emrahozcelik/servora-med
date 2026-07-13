import {
  boolean, items, json, nullableString, number, object, request, string,
} from './api';

export type Product = {
  id: string; organizationId: string; name: string; sku: string | null;
  brand: string | null; category: string | null; model: string | null;
  unit: string | null; referencePrice: number | null; isActive: boolean;
  version: number; createdAt: string; updatedAt: string;
};
export type ProductFilters = {
  q?: string; status?: 'active' | 'inactive' | 'all'; limit?: number; offset?: number;
};
export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };

type MutableProductFields = {
  name?: string; sku?: string | null; brand?: string | null; category?: string | null;
  model?: string | null; unit?: string | null; referencePrice?: number | null;
};
export type CreateProductInput = MutableProductFields & { name: string };
export type UpdateProductInput = MutableProductFields & { expectedVersion: number };

const MUTABLE_FIELDS = [
  'name', 'sku', 'brand', 'category', 'model', 'unit', 'referencePrice',
] as const;
const FILTER_FIELDS = ['q', 'status', 'limit', 'offset'] as const;

function projectMutableFields(input: MutableProductFields): MutableProductFields {
  const source = input as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of MUTABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) projected[field] = source[field];
  }
  return projected as MutableProductFields;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return number(value, field);
}

function parseProduct(value: unknown): Product {
  const v = object(value);
  return {
    id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    name: string(v.name, 'name'), sku: nullableString(v.sku, 'sku'),
    brand: nullableString(v.brand, 'brand'), category: nullableString(v.category, 'category'),
    model: nullableString(v.model, 'model'), unit: nullableString(v.unit, 'unit'),
    referencePrice: nullableNumber(v.referencePrice, 'referencePrice'),
    isActive: boolean(v.isActive, 'isActive'), version: number(v.version, 'version'),
    createdAt: string(v.createdAt, 'createdAt'), updatedAt: string(v.updatedAt, 'updatedAt'),
  };
}

function parsePage(value: unknown): Paginated<Product> {
  const v = object(value);
  return {
    items: items(v).map(parseProduct), total: number(v.total, 'total'),
    limit: number(v.limit, 'limit'), offset: number(v.offset, 'offset'),
  };
}

function query(filters: ProductFilters) {
  const params = new URLSearchParams();
  for (const key of FILTER_FIELDS) {
    const value = filters[key];
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

const productPath = (id: string) => `/api/products/${encodeURIComponent(id)}`;

export const listProducts = async (filters: ProductFilters = {}) =>
  parsePage(await request(`/api/products${query(filters)}`));
export const getProduct = async (id: string) => parseProduct(await request(productPath(id)));
export const createProduct = async (input: CreateProductInput) =>
  parseProduct(await request('/api/products', json('POST', projectMutableFields(input))));
export const updateProduct = async (id: string, input: UpdateProductInput) =>
  parseProduct(await request(productPath(id), json('PATCH', {
    expectedVersion: input.expectedVersion, ...projectMutableFields(input),
  })));
export const activateProduct = async (id: string, expectedVersion: number) =>
  parseProduct(await request(`${productPath(id)}/activate`, json('POST', { expectedVersion })));
export const deactivateProduct = async (id: string, expectedVersion: number) =>
  parseProduct(await request(`${productPath(id)}/deactivate`, json('POST', { expectedVersion })));
