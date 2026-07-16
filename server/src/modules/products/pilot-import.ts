import { AppError } from '../../errors/index.js';
import {
  normalizeProductCreateInput,
  type CreateProductInput,
} from './service.js';
import type { ProductFields } from './types.js';

const DOCUMENT_FIELDS = ['version', 'description', 'fieldGuide', 'categories', 'products'] as const;
const PRODUCT_FIELDS = [
  'name', 'sku', 'brand', 'category', 'model', 'unit', 'referencePrice', 'isActive',
] as const;

type PilotProduct = ProductFields & { isActive: true };
export type PilotProductDocument = {
  version: 1;
  categories: string[];
  products: PilotProduct[];
};
export type ExistingPilotProduct = PilotProduct & { id: string };
export type PilotProductMergePlan = {
  sourceCount: number;
  matched: Array<{ source: PilotProduct; existing: ExistingPilotProduct }>;
  inserts: PilotProduct[];
};

function invalid(message: string): never {
  throw new AppError('PILOT_PRODUCT_IMPORT_INVALID', 400, message);
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} nesne olmalıdır.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) invalid(`${label} desteklenmeyen ${unknown} alanını içeriyor.`);
}

function nullableText(value: unknown, field: string) {
  if (value !== null && typeof value !== 'string') invalid(`${field} metin veya null olmalıdır.`);
}

function parseProduct(value: unknown, categories: Set<string>, index: number): PilotProduct {
  const raw = record(value, `products[${index}]`);
  exactKeys(raw, PRODUCT_FIELDS, `products[${index}]`);
  if (typeof raw.name !== 'string') invalid(`products[${index}].name metin olmalıdır.`);
  for (const field of ['sku', 'brand', 'category', 'model', 'unit'] as const) {
    nullableText(raw[field], `products[${index}].${field}`);
  }
  if (raw.referencePrice !== null && typeof raw.referencePrice !== 'number') {
    invalid(`products[${index}].referencePrice sayı veya null olmalıdır.`);
  }
  if (raw.isActive !== undefined && raw.isActive !== true) {
    invalid(`products[${index}].isActive yalnız true olabilir.`);
  }
  let fields: ProductFields;
  try {
    fields = normalizeProductCreateInput(raw as unknown as CreateProductInput);
  } catch (error) {
    invalid(error instanceof Error ? error.message : `products[${index}] geçersizdir.`);
  }
  if (fields.category !== null && !categories.has(fields.category)) {
    invalid(`products[${index}].category kategori rehberinde bulunmuyor.`);
  }
  return { ...fields, isActive: true };
}

export function parsePilotProductDocument(value: unknown): PilotProductDocument {
  const raw = record(value, 'Belge');
  exactKeys(raw, DOCUMENT_FIELDS, 'Belge');
  if (raw.version !== 1) invalid('Yalnız pilot ürün belge sürümü 1 desteklenir.');
  if (!Array.isArray(raw.categories) || !Array.isArray(raw.products)) {
    invalid('categories ve products dizi olmalıdır.');
  }
  if (typeof raw.description !== 'string' || !raw.fieldGuide
    || typeof raw.fieldGuide !== 'object' || Array.isArray(raw.fieldGuide)) {
    invalid('description ve fieldGuide zorunludur.');
  }
  const categories = raw.categories.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) invalid(`categories[${index}] geçersizdir.`);
    return entry.trim();
  });
  if (new Set(categories).size !== categories.length) invalid('Kategori rehberi tekrar içeremez.');
  const products = raw.products.map((entry, index) => parseProduct(entry, new Set(categories), index));
  const keys = new Set<string>();
  for (const product of products) {
    const key = product.sku === null ? `NAME:${product.name}` : `SKU:${product.sku}`;
    if (keys.has(key)) invalid(`Kaynak ürün anahtarı tekrar ediyor: ${key}`);
    keys.add(key);
  }
  return { version: 1, categories, products };
}

function sameProduct(source: PilotProduct, existing: ExistingPilotProduct) {
  return source.name === existing.name && source.sku === existing.sku
    && source.brand === existing.brand && source.category === existing.category
    && source.model === existing.model && source.unit === existing.unit
    && source.referencePrice === existing.referencePrice
    && source.isActive === existing.isActive;
}

export function planPilotProductMerge(
  source: PilotProductDocument,
  existing: ExistingPilotProduct[],
): PilotProductMergePlan {
  const matched: PilotProductMergePlan['matched'] = [];
  const inserts: PilotProduct[] = [];
  for (const product of source.products) {
    const candidates = existing.filter((candidate) => product.sku !== null
      ? candidate.sku === product.sku
      : candidate.sku === null && candidate.name === product.name);
    if (candidates.length > 1) {
      throw new AppError(
        'PILOT_PRODUCT_IMPORT_AMBIGUOUS', 409,
        `Birden fazla ürün eşleşti: ${product.sku ?? product.name}`,
      );
    }
    const candidate = candidates[0];
    if (!candidate) { inserts.push(product); continue; }
    if (!sameProduct(product, candidate)) {
      throw new AppError(
        'PILOT_PRODUCT_IMPORT_CONFLICT', 409,
        `Mevcut ürün kaynakla farklı: ${product.sku ?? product.name}`,
      );
    }
    matched.push({ source: product, existing: candidate });
  }
  return { sourceCount: source.products.length, matched, inserts };
}
