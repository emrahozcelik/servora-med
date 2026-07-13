import type { Pool, PoolClient } from 'pg';

import type {
  AppendProductAuditInput,
  CreateProductRecord,
  Paginated,
  Product,
  ProductFilters,
  ProductRow,
  SetProductActiveRecord,
  UpdateProductRecord,
} from './types.js';
import { mapProduct } from './types.js';

const PRODUCT_COLUMNS = `id, organization_id, name, sku, brand, category, model, unit,
  default_price, is_active, version, created_at, updated_at`;

function boundedLimit(limit: number) {
  return Math.min(Math.max(limit, 1), 200);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

export interface ProductTransaction {
  lockProduct(organizationId: string, productId: string): Promise<Product | null>;
  createProduct(input: CreateProductRecord): Promise<Product>;
  updateProduct(input: UpdateProductRecord): Promise<Product | null>;
  setProductActive(input: SetProductActiveRecord): Promise<Product | null>;
  appendAudit(input: AppendProductAuditInput): Promise<void>;
}

export interface ProductRepository {
  listProducts(organizationId: string, filters: ProductFilters): Promise<Paginated<Product>>;
  getProduct(organizationId: string, productId: string): Promise<Product | null>;
  execute<T>(work: (tx: ProductTransaction) => Promise<T>): Promise<T>;
}

class PostgresProductTransaction implements ProductTransaction {
  constructor(private readonly client: PoolClient) {}

  async lockProduct(organizationId: string, productId: string) {
    const result = await this.client.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products
       WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [organizationId, productId],
    );
    return result.rows[0] ? mapProduct(result.rows[0]) : null;
  }

  async createProduct(input: CreateProductRecord) {
    const result = await this.client.query<ProductRow>(
      `INSERT INTO products
         (organization_id, name, sku, brand, category, model, unit, default_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${PRODUCT_COLUMNS}`,
      [input.organizationId, input.name, input.sku, input.brand, input.category,
        input.model, input.unit, input.referencePrice],
    );
    return mapProduct(result.rows[0]!);
  }

  async updateProduct(input: UpdateProductRecord) {
    const result = await this.client.query<ProductRow>(
      `UPDATE products
       SET name=$4, sku=$5, brand=$6, category=$7, model=$8, unit=$9,
         default_price=$10, version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 AND version=$3
       RETURNING ${PRODUCT_COLUMNS}`,
      [input.organizationId, input.productId, input.expectedVersion, input.name,
        input.sku, input.brand, input.category, input.model, input.unit, input.referencePrice],
    );
    return result.rows[0] ? mapProduct(result.rows[0]) : null;
  }

  async setProductActive(input: SetProductActiveRecord) {
    const result = await this.client.query<ProductRow>(
      `UPDATE products SET is_active=$4, version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 AND version=$3
       RETURNING ${PRODUCT_COLUMNS}`,
      [input.organizationId, input.productId, input.expectedVersion, input.isActive],
    );
    return result.rows[0] ? mapProduct(result.rows[0]) : null;
  }

  async appendAudit(input: AppendProductAuditInput) {
    await this.client.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.organizationId, input.actorUserId, 'PRODUCT', input.subjectId,
        input.eventType, input.oldValue, input.newValue, input.metadata],
    );
  }
}

export class PostgresProductRepository implements ProductRepository {
  constructor(private readonly pool: Pool) {}

  async listProducts(organizationId: string, filters: ProductFilters) {
    const limit = boundedLimit(filters.limit);
    const values: unknown[] = [organizationId];
    const where = ['organization_id=$1'];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };

    if (filters.status === 'active') where.push('is_active=TRUE');
    if (filters.status === 'inactive') where.push('is_active=FALSE');
    if (filters.q?.trim()) {
      const pattern = add(`%${escapeLikePattern(filters.q.trim())}%`);
      where.push(`(name ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(sku,'') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(brand,'') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(category,'') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(model,'') ILIKE ${pattern} ESCAPE '\\')`);
    }

    const condition = where.join(' AND ');
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM products WHERE ${condition}`,
      values,
    );
    const pageValues = [...values, limit, filters.offset];
    const items = await this.pool.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE ${condition}
       ORDER BY name, id LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    return {
      items: items.rows.map(mapProduct), total: Number(count.rows[0]?.total ?? 0),
      limit, offset: filters.offset,
    };
  }

  async getProduct(organizationId: string, productId: string) {
    const result = await this.pool.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products
       WHERE organization_id=$1 AND id=$2`,
      [organizationId, productId],
    );
    return result.rows[0] ? mapProduct(result.rows[0]) : null;
  }

  async execute<T>(work: (tx: ProductTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresProductTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
