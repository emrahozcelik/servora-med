import type { UserRole } from '../auth/types.js';

export type Product = {
  id: string;
  organizationId: string;
  name: string;
  sku: string | null;
  brand: string | null;
  category: string | null;
  model: string | null;
  unit: string | null;
  referencePrice: number | null;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductRow = {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  brand: string | null;
  category: string | null;
  model: string | null;
  unit: string | null;
  default_price: string | number | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export function mapProduct(row: ProductRow): Product {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    sku: row.sku, brand: row.brand, category: row.category, model: row.model,
    unit: row.unit, referencePrice: row.default_price === null ? null : Number(row.default_price),
    isActive: row.is_active, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export type Paginated<T> = { items: T[]; total: number; limit: number; offset: number };

export type ProductFilters = {
  q: string | null;
  status: 'active' | 'inactive' | 'all';
  limit: number;
  offset: number;
};

export type ProductActor = { id: string; organizationId: string; role: UserRole };

export type ProductFields = Pick<Product,
  'name' | 'sku' | 'brand' | 'category' | 'model' | 'unit' | 'referencePrice'>;

export type CreateProductRecord = ProductFields & { organizationId: string };

export type UpdateProductRecord = CreateProductRecord & {
  productId: string;
  expectedVersion: number;
};

export type SetProductActiveRecord = {
  organizationId: string;
  productId: string;
  expectedVersion: number;
  isActive: boolean;
};

export const PRODUCT_AUDIT_EVENTS = [
  'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED', 'PRODUCT_ACTIVATED',
  'PRODUCT_DEACTIVATED', 'PRODUCT_DELETED',
] as const;
export type ProductAuditEvent = (typeof PRODUCT_AUDIT_EVENTS)[number];

export type AppendProductAuditInput = {
  organizationId: string;
  actorUserId: string;
  subjectId: string;
  eventType: ProductAuditEvent;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};
