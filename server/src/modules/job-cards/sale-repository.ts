import type { SqlExecutor } from '../../db/executor.js';
import type { JobCard } from './types.js';

export type SaleSource = Pick<JobCard, 'id' | 'organizationId' | 'type' | 'status' | 'version'
  | 'title' | 'customerId' | 'contactId' | 'assignedTo' | 'engagementKind'> & {
  dataClass: 'BUSINESS' | 'DEMO';
  metContactId: string | null;
};
export type SaleContactReference = {
  id: string; customerId: string; name: string; title: string | null; isActive: boolean;
};
export type SaleProductReference = {
  id: string; name: string; sku: string | null; brand: string | null;
  model: string | null; unit: string | null; isActive: boolean; dataClass: 'BUSINESS' | 'DEMO';
};
export type SaleDetails = {
  organizationId: string; jobCardId: string; soldAt: string;
  saleContactId: string | null; saleContactNameSnapshot: string | null; saleContactTitleSnapshot: string | null;
  sourceVisitVersion: number; sourceVisitTitleSnapshot: string; sourceCustomerNameSnapshot: string;
  sourcePlannedContactId: string | null; sourcePlannedContactNameSnapshot: string | null; sourcePlannedContactTitleSnapshot: string | null;
  sourceMetContactId: string | null; sourceMetContactNameSnapshot: string | null; sourceMetContactTitleSnapshot: string | null;
};
export type SaleItem = {
  id: string; organizationId: string; jobCardId: string; productId: string; quantity: string;
  productNameSnapshot: string; productSkuSnapshot: string | null; productBrandSnapshot: string | null;
  productModelSnapshot: string | null; unitSnapshot: string | null; sortOrder: number;
};
export type SaleSubmissionSnapshot = {
  sourceVisitId: string;
  originValid: boolean;
  soldAt: string;
  items: SaleItem[];
};

/** One SQL statement keeps readiness inputs in the same MVCC snapshot. */
export async function selectSaleSubmission(executor: SqlExecutor, organizationId: string, jobCardId: string) {
  const result = await executor.query<{
    sourceVisitId: string; originValid: boolean; soldAt: Date; items: SaleItem[];
  }>(
    `SELECT j.sale_source_visit_id AS "sourceVisitId",d.sold_at AS "soldAt",
       EXISTS(SELECT 1 FROM job_cards source
         WHERE source.organization_id=j.organization_id AND source.id=j.sale_source_visit_id
         AND source.type='SALES_MEETING') AS "originValid",
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'id',i.id,'organizationId',i.organization_id,'jobCardId',i.job_card_id,'productId',i.product_id,
         'quantity',i.quantity::text,'productNameSnapshot',i.product_name_snapshot,
         'productSkuSnapshot',i.product_sku_snapshot,'productBrandSnapshot',i.product_brand_snapshot,
         'productModelSnapshot',i.product_model_snapshot,'unitSnapshot',i.unit_snapshot,'sortOrder',i.sort_order
       ) ORDER BY i.sort_order,i.id) FROM job_card_sale_items i
         WHERE i.organization_id=j.organization_id AND i.job_card_id=j.id),'[]'::jsonb) AS items
     FROM job_cards j JOIN job_card_sale_details d
       ON d.organization_id=j.organization_id AND d.job_card_id=j.id
     WHERE j.organization_id=$1 AND j.id=$2 AND j.type='SALE'`, [organizationId, jobCardId],
  );
  const row = result.rows[0];
  return row ? { ...row, soldAt: row.soldAt.toISOString() } : null;
}

export interface SaleTransaction {
  getSource(organizationId: string, visitId: string, forUpdate?: boolean): Promise<SaleSource | null>;
  getCustomerForUpdate(organizationId: string, customerId: string): Promise<{
    id: string; name: string; status: string; dataClass: 'BUSINESS' | 'DEMO';
  } | null>;
  getContactsForShare(organizationId: string, contactIds: readonly string[]): Promise<SaleContactReference[]>;
  getProductsForShare(organizationId: string, productIds: readonly string[]): Promise<SaleProductReference[]>;
  createDetails(details: SaleDetails): Promise<void>;
  createItem(item: Omit<SaleItem, 'id'>): Promise<SaleItem>;
  getItems(organizationId: string, jobCardId: string): Promise<SaleItem[]>;
  updateQuantity(organizationId: string, jobCardId: string, itemId: string, quantity: string): Promise<void>;
  removeItem(organizationId: string, jobCardId: string, itemId: string): Promise<void>;
  getDetails(organizationId: string, jobCardId: string): Promise<{
    soldAt: string; saleContactId: string | null; saleContactNameSnapshot: string | null; saleContactTitleSnapshot: string | null;
  } | null>;
  correctDetails(organizationId: string, jobCardId: string, fields: {
    soldAt: string; saleContactId: string | null; saleContactNameSnapshot: string | null; saleContactTitleSnapshot: string | null;
  }): Promise<void>;
}

const ITEM_COLUMNS = `id, organization_id AS "organizationId", job_card_id AS "jobCardId",
  product_id AS "productId", quantity::text AS quantity, product_name_snapshot AS "productNameSnapshot",
  product_sku_snapshot AS "productSkuSnapshot", product_brand_snapshot AS "productBrandSnapshot",
  product_model_snapshot AS "productModelSnapshot", unit_snapshot AS "unitSnapshot", sort_order AS "sortOrder"`;

/** Sale-only SQL; the caller owns the existing critical-action transaction. */
export class PostgresSaleTransaction implements SaleTransaction {
  constructor(private readonly executor: SqlExecutor) {}

  async getDetails(organizationId: string, jobCardId: string) {
    const result = await this.executor.query<{ soldAt: Date; saleContactId: string | null;
      saleContactNameSnapshot: string | null; saleContactTitleSnapshot: string | null }>(
      `SELECT sold_at AS "soldAt",sale_contact_id AS "saleContactId",
        sale_contact_name_snapshot AS "saleContactNameSnapshot",sale_contact_title_snapshot AS "saleContactTitleSnapshot"
       FROM job_card_sale_details WHERE organization_id=$1 AND job_card_id=$2`, [organizationId, jobCardId]);
    const row = result.rows[0];
    return row ? { ...row, soldAt: row.soldAt.toISOString() } : null;
  }

  async correctDetails(organizationId: string, jobCardId: string, fields: {
    soldAt: string; saleContactId: string | null; saleContactNameSnapshot: string | null; saleContactTitleSnapshot: string | null;
  }) {
    await this.executor.query(`UPDATE job_card_sale_details SET sold_at=$3,sale_contact_id=$4,
      sale_contact_name_snapshot=$5,sale_contact_title_snapshot=$6,updated_at=NOW()
      WHERE organization_id=$1 AND job_card_id=$2`, [organizationId, jobCardId, fields.soldAt,
      fields.saleContactId, fields.saleContactNameSnapshot, fields.saleContactTitleSnapshot]);
  }

  async getItems(organizationId: string, jobCardId: string) {
    return (await this.executor.query<SaleItem>(`SELECT ${ITEM_COLUMNS} FROM job_card_sale_items
      WHERE organization_id=$1 AND job_card_id=$2 ORDER BY sort_order,id`, [organizationId, jobCardId])).rows;
  }

  async removeItem(organizationId: string, jobCardId: string, itemId: string) {
    await this.executor.query('DELETE FROM job_card_sale_items WHERE organization_id=$1 AND job_card_id=$2 AND id=$3',
      [organizationId, jobCardId, itemId]);
  }

  async updateQuantity(organizationId: string, jobCardId: string, itemId: string, quantity: string) {
    await this.executor.query(`UPDATE job_card_sale_items SET quantity=$4,updated_at=NOW()
      WHERE organization_id=$1 AND job_card_id=$2 AND id=$3`, [organizationId, jobCardId, itemId, quantity]);
  }

  async getSource(organizationId: string, visitId: string, forUpdate = true) {
    const result = await this.executor.query<SaleSource>(
      `SELECT j.id,j.organization_id AS "organizationId",j.type,j.status,j.version,j.title,
        j.customer_id AS "customerId",j.contact_id AS "contactId",j.assigned_to AS "assignedTo",
        j.engagement_kind AS "engagementKind",j.data_class AS "dataClass",m.met_contact_id AS "metContactId"
       FROM job_cards j LEFT JOIN job_card_meeting_details m
         ON m.organization_id=j.organization_id AND m.job_card_id=j.id
       WHERE j.organization_id=$1 AND j.id=$2${forUpdate ? ' FOR UPDATE OF j' : ''}`,
      [organizationId, visitId],
    );
    return result.rows[0] ?? null;
  }

  async getCustomerForUpdate(organizationId: string, customerId: string) {
    const result = await this.executor.query<{ id: string; name: string; status: string; dataClass: 'BUSINESS' | 'DEMO' }>(
      `SELECT id,name,status,data_class AS "dataClass" FROM customers
       WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [organizationId, customerId],
    );
    return result.rows[0] ?? null;
  }

  async getContactsForShare(organizationId: string, contactIds: readonly string[]) {
    if (contactIds.length === 0) return [];
    return (await this.executor.query<SaleContactReference>(
      `SELECT id,customer_id AS "customerId",name,title,is_active AS "isActive" FROM contacts
       WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, [organizationId, contactIds],
    )).rows;
  }

  async getProductsForShare(organizationId: string, productIds: readonly string[]) {
    return (await this.executor.query<SaleProductReference>(
      `SELECT id,name,sku,brand,model,unit,is_active AS "isActive",data_class AS "dataClass"
       FROM products WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
      [organizationId, productIds],
    )).rows;
  }

  async createDetails(d: SaleDetails) {
    await this.executor.query(
      `INSERT INTO job_card_sale_details (organization_id,job_card_id,sold_at,
        sale_contact_id,sale_contact_name_snapshot,sale_contact_title_snapshot,
        source_visit_version,source_visit_title_snapshot,source_customer_name_snapshot,
        source_planned_contact_id,source_planned_contact_name_snapshot,source_planned_contact_title_snapshot,
        source_met_contact_id,source_met_contact_name_snapshot,source_met_contact_title_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [d.organizationId,d.jobCardId,d.soldAt,d.saleContactId,d.saleContactNameSnapshot,d.saleContactTitleSnapshot,
        d.sourceVisitVersion,d.sourceVisitTitleSnapshot,d.sourceCustomerNameSnapshot,
        d.sourcePlannedContactId,d.sourcePlannedContactNameSnapshot,d.sourcePlannedContactTitleSnapshot,
        d.sourceMetContactId,d.sourceMetContactNameSnapshot,d.sourceMetContactTitleSnapshot],
    );
  }

  async createItem(i: Omit<SaleItem, 'id'>) {
    return (await this.executor.query<SaleItem>(
      `INSERT INTO job_card_sale_items (organization_id,job_card_id,product_id,quantity,
        product_name_snapshot,product_sku_snapshot,product_brand_snapshot,product_model_snapshot,unit_snapshot,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${ITEM_COLUMNS}`,
      [i.organizationId,i.jobCardId,i.productId,i.quantity,i.productNameSnapshot,i.productSkuSnapshot,
        i.productBrandSnapshot,i.productModelSnapshot,i.unitSnapshot,i.sortOrder],
    )).rows[0]!;
  }
}
