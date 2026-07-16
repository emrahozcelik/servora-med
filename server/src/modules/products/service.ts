import { AppError } from '../../errors/index.js';
import {
  PRODUCT_FIELD_LABELS,
  PRODUCT_REFERENCE_PRICE_MAX,
  PRODUCT_TEXT_LIMITS,
  type ProductTextField,
} from './constraints.js';
import type { ProductRepository, ProductTransaction } from './repository.js';
import type {
  AppendProductAuditInput,
  Product,
  ProductActor,
  ProductFields,
  ProductFilters,
} from './types.js';

export type CreateProductInput = {
  name: string;
  sku?: string | null;
  brand?: string | null;
  category?: string | null;
  model?: string | null;
  unit?: string | null;
  referencePrice?: number | null;
};

export type UpdateProductInput = {
  expectedVersion: number;
  name?: string;
  sku?: string | null;
  brand?: string | null;
  category?: string | null;
  model?: string | null;
  unit?: string | null;
  referencePrice?: number | null;
};

const mutableFields = [
  'name', 'sku', 'brand', 'category', 'model', 'unit', 'referencePrice',
] as const;
type MutableField = (typeof mutableFields)[number];

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const productNotFound = () => new AppError('PRODUCT_NOT_FOUND', 404, 'Ürün bulunamadı.');
const validation = (message: string) => new AppError('VALIDATION_ERROR', 400, message);
const fieldValidation = (field: MutableField, message: string) => new AppError(
  'VALIDATION_ERROR', 400, message, { fieldErrors: { [field]: message } },
);
const versionConflict = (currentVersion?: number) => new AppError(
  'VERSION_CONFLICT', 409, 'Kayıt başka bir kullanıcı tarafından güncellendi.',
  currentVersion === undefined ? null : { currentVersion },
);

function requireWriter(actor: ProductActor) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw forbidden();
}

function requiredName(value: string) {
  const name = value.trim();
  if (!name) throw fieldValidation('name', 'Ürün adı zorunludur.');
  return boundedText('name', name);
}

function boundedText(field: ProductTextField, value: string) {
  const limit = PRODUCT_TEXT_LIMITS[field];
  if ([...value].length > limit) {
    throw fieldValidation(field, `${PRODUCT_FIELD_LABELS[field]} en fazla ${limit} karakter olabilir.`);
  }
  return value;
}

function optionalText(field: Exclude<ProductTextField, 'name'>, value: string | null) {
  const normalized = value?.trim() || null;
  return normalized === null ? null : boundedText(field, normalized);
}

function referencePrice(value: number | null) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw fieldValidation('referencePrice', 'Referans fiyat sıfır veya pozitif olmalıdır.');
  }
  if (value !== null && value > PRODUCT_REFERENCE_PRICE_MAX) {
    throw fieldValidation(
      'referencePrice',
      `Referans fiyat en fazla ${PRODUCT_REFERENCE_PRICE_MAX} olabilir.`,
    );
  }
  return value;
}

export function normalizeProductCreateInput(input: CreateProductInput): ProductFields {
  return {
    name: requiredName(input.name),
    sku: optionalText('sku', input.sku ?? null),
    brand: optionalText('brand', input.brand ?? null),
    category: optionalText('category', input.category ?? null),
    model: optionalText('model', input.model ?? null),
    unit: optionalText('unit', input.unit ?? null),
    referencePrice: referencePrice(input.referencePrice ?? null),
  };
}

function suppliedMutableFields(input: UpdateProductInput) {
  return mutableFields.filter((field) => Object.prototype.hasOwnProperty.call(input, field));
}

function normalizePatchField(field: MutableField, value: unknown) {
  if (field === 'name') return requiredName(value as string);
  if (field === 'referencePrice') return referencePrice(value as number | null);
  return optionalText(field, value as string | null);
}

function audit(
  actor: ProductActor,
  subjectId: string,
  eventType: AppendProductAuditInput['eventType'],
  oldValue: Record<string, unknown> | null,
  newValue: Record<string, unknown> | null,
  metadata: Record<string, unknown> = {},
): AppendProductAuditInput {
  return {
    organizationId: actor.organizationId,
    actorUserId: actor.id,
    subjectId,
    eventType,
    oldValue,
    newValue,
    metadata,
  };
}

export class ProductService {
  constructor(private readonly repository: ProductRepository) {}

  listProducts(actor: ProductActor, filters: ProductFilters) {
    return this.repository.listProducts(actor.organizationId, filters);
  }

  async getProduct(actor: ProductActor, productId: string) {
    return (await this.repository.getProduct(actor.organizationId, productId))
      ?? Promise.reject(productNotFound());
  }

  async createProduct(actor: ProductActor, input: CreateProductInput) {
    requireWriter(actor);
    const fields = normalizeProductCreateInput(input);
    return this.repository.execute(async (tx) => {
      const created = await tx.createProduct({ organizationId: actor.organizationId, ...fields });
      await tx.appendAudit(audit(
        actor,
        created.id,
        'PRODUCT_CREATED',
        null,
        { isActive: created.isActive },
      ));
      return created;
    });
  }

  async updateProduct(actor: ProductActor, productId: string, input: UpdateProductInput) {
    requireWriter(actor);
    const suppliedFields = suppliedMutableFields(input);
    if (suppliedFields.length === 0) {
      throw validation('En az bir ürün alanı gönderilmelidir.');
    }
    const patch = Object.fromEntries(
      suppliedFields.map((field) => [field, normalizePatchField(field, input[field])]),
    ) as Partial<ProductFields>;

    return this.repository.execute(async (tx) => {
      const current = await this.requireProduct(tx, actor, productId);
      if (current.version !== input.expectedVersion) throw versionConflict(current.version);
      const changedFields = suppliedFields.filter((field) => current[field] !== patch[field]);
      if (changedFields.length === 0) return current;

      const updated = await tx.updateProduct({
        organizationId: actor.organizationId,
        productId,
        expectedVersion: input.expectedVersion,
        ...this.fieldsFrom(current),
        ...patch,
      });
      if (!updated) throw versionConflict();
      await tx.appendAudit(audit(
        actor,
        productId,
        'PRODUCT_FIELDS_UPDATED',
        null,
        null,
        { changedFields },
      ));
      return updated;
    });
  }

  activateProduct(actor: ProductActor, productId: string, expectedVersion: number) {
    requireWriter(actor);
    return this.changeActive(actor, productId, expectedVersion, true);
  }

  deactivateProduct(actor: ProductActor, productId: string, expectedVersion: number) {
    requireWriter(actor);
    return this.changeActive(actor, productId, expectedVersion, false);
  }

  private changeActive(
    actor: ProductActor,
    productId: string,
    expectedVersion: number,
    isActive: boolean,
  ) {
    return this.repository.execute(async (tx) => {
      const current = await this.requireProduct(tx, actor, productId);
      if (current.version !== expectedVersion) throw versionConflict(current.version);
      if (current.isActive === isActive) {
        throw new AppError(
          'INVALID_PRODUCT_STATUS_TRANSITION',
          409,
          'Ürün durumu bu işlem için uygun değil.',
        );
      }
      const updated = await tx.setProductActive({
        organizationId: actor.organizationId,
        productId,
        expectedVersion,
        isActive,
      });
      if (!updated) throw versionConflict();
      await tx.appendAudit(audit(
        actor,
        productId,
        isActive ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED',
        { isActive: current.isActive },
        { isActive: updated.isActive },
      ));
      return updated;
    });
  }

  private requireProduct(tx: ProductTransaction, actor: ProductActor, productId: string) {
    return tx.lockProduct(actor.organizationId, productId)
      .then((current) => current ?? Promise.reject(productNotFound()));
  }

  private fieldsFrom(product: Product): ProductFields {
    return {
      name: product.name,
      sku: product.sku,
      brand: product.brand,
      category: product.category,
      model: product.model,
      unit: product.unit,
      referencePrice: product.referencePrice,
    };
  }
}
