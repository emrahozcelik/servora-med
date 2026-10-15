import type { SqlExecutor } from '../../db/executor.js';
import type { JobCardActor, JobCardStatus, Paginated } from './types.js';
import type { PageQuery } from './repository.js';
import type { SaleSource } from './sale-repository.js';
import { assertSaleSourceEligible } from './sale-policy.js';

export type SaleContactSnapshot = { id: string; name: string; title: string | null };
export type SaleSourceProjection = { access: 'RESTRICTED'; kind: 'SALE_FROM_VISIT' } | {
  access: 'FULL'; kind: 'SALE_FROM_VISIT'; id: string; title: string; status: JobCardStatus;
  versionAtCreation: number; titleSnapshot: string; customerNameSnapshot: string;
  plannedContact: SaleContactSnapshot | null; metContact: SaleContactSnapshot | null;
};
export type SaleLineProjection = {
  id: string; productId: string; quantity: string; name: string; sku: string | null;
  brand: string | null; model: string | null; unit: string | null;
};
export type SaleDetailsProjection = {
  jobCardId: string; jobCardVersion: number; soldAt: string;
  saleContact: SaleContactSnapshot | null; sourceVisit: SaleSourceProjection; items: SaleLineProjection[];
};
export type SaleLink = { access: 'RESTRICTED' } | {
  access: 'FULL'; id: string; title: string; status: JobCardStatus;
};
export type SaleCreateContext = {
  sourceVisitId: string; sourceVersion: number; eligible: boolean;
  blockedReason: 'SOURCE_NOT_ELIGIBLE' | 'REFERENCE_NOT_ELIGIBLE' | 'ACTIVE_SALE_EXISTS' | null;
  customer: { id: string; name: string } | null; assignee: { id: string; name: string };
  plannedContact: SaleContactSnapshot | null; metContact: SaleContactSnapshot | null;
  activeSale: SaleLink | null;
};
export interface SaleReadPort {
  details(actor: JobCardActor, id: string): Promise<SaleDetailsProjection | null>;
  context(actor: JobCardActor, id: string): Promise<SaleCreateContext | null>;
  related(actor: JobCardActor, id: string, page: PageQuery): Promise<Paginated<Exclude<SaleLink, { access: 'RESTRICTED' }>> | null>;
}

/** Authorization and projection share one MVCC statement; no unlocked identity lookup. */
export class PostgresSaleReader implements SaleReadPort {
  constructor(private readonly executor: SqlExecutor) {}

  async context(actor: JobCardActor, id: string): Promise<SaleCreateContext | null> {
    const result = await this.executor.query<SaleSource & {
      customer: SaleCreateContext['customer']; assignee: SaleCreateContext['assignee'];
      plannedContact: SaleContactSnapshot | null; metContact: SaleContactSnapshot | null;
      activeSale: SaleLink | null; referencesEligible: boolean;
    }>(`SELECT j.id,j.organization_id AS "organizationId",j.type,j.status,j.version,j.title,
        j.customer_id AS "customerId",j.contact_id AS "contactId",j.assigned_to AS "assignedTo",
        j.engagement_kind AS "engagementKind",j.data_class AS "dataClass",m.met_contact_id AS "metContactId",
        CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'name',c.name) END AS customer,
        jsonb_build_object('id',u.id,'name',u.name) AS assignee,
        CASE WHEN planned.id IS NULL THEN NULL ELSE jsonb_build_object('id',planned.id,'name',planned.name,'title',planned.title) END AS "plannedContact",
        CASE WHEN met.id IS NULL THEN NULL ELSE jsonb_build_object('id',met.id,'name',met.name,'title',met.title) END AS "metContact",
        COALESCE(c.status<>'inactive' AND c.data_class='BUSINESS' AND u.is_active AND u.role='STAFF'
          AND current_actor.is_active AND current_actor.role=$4
          AND (planned.id IS NULL OR planned.customer_id=c.id) AND (met.id IS NULL OR met.customer_id=c.id), FALSE) AS "referencesEligible",
        (SELECT CASE WHEN $3::uuid IS NOT NULL AND sale.assigned_to<>$3
          THEN jsonb_build_object('access','RESTRICTED') ELSE jsonb_build_object(
            'access','FULL','id',sale.id,'title',sale.title,'status',sale.status) END
         FROM job_cards sale WHERE sale.organization_id=j.organization_id AND sale.sale_source_visit_id=j.id
           AND sale.type='SALE' AND sale.status IN ('NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')) AS "activeSale"
       FROM job_cards j
       JOIN users u ON u.organization_id=j.organization_id AND u.id=j.assigned_to
       JOIN users current_actor ON current_actor.organization_id=j.organization_id AND current_actor.id=$5
       LEFT JOIN customers c ON c.organization_id=j.organization_id AND c.id=j.customer_id
       LEFT JOIN job_card_meeting_details m ON m.organization_id=j.organization_id AND m.job_card_id=j.id
       LEFT JOIN contacts planned ON planned.organization_id=j.organization_id AND planned.id=j.contact_id
       LEFT JOIN contacts met ON met.organization_id=j.organization_id AND met.id=m.met_contact_id
       WHERE j.organization_id=$1 AND j.id=$2 AND j.type='SALES_MEETING' AND ($3::uuid IS NULL OR j.assigned_to=$3)`,
      [actor.organizationId,id,actor.role === 'STAFF' ? actor.id : null,actor.role,actor.id]);
    const row = result.rows[0];
    if (!row) return null;
    let blockedReason: SaleCreateContext['blockedReason'] = null;
    try { assertSaleSourceEligible(row); } catch { blockedReason = 'SOURCE_NOT_ELIGIBLE'; }
    if (blockedReason === null && !row.referencesEligible) blockedReason = 'REFERENCE_NOT_ELIGIBLE';
    if (row.activeSale) blockedReason = 'ACTIVE_SALE_EXISTS';
    return { sourceVisitId: row.id, sourceVersion: row.version, eligible: blockedReason === null,
      blockedReason, customer: row.customer, assignee: row.assignee,
      plannedContact: row.plannedContact, metContact: row.metContact, activeSale: row.activeSale };
  }

  async related(actor: JobCardActor, id: string, page: PageQuery) {
    const result = await this.executor.query<{
      items: Exclude<SaleLink, { access: 'RESTRICTED' }>[]; total: number;
    }>(`WITH source AS (SELECT id,organization_id FROM job_cards
        WHERE organization_id=$1 AND id=$2 AND type='SALES_MEETING' AND ($3::uuid IS NULL OR assigned_to=$3)),
      visible AS (SELECT sale.id,sale.title,sale.status,sale.created_at FROM job_cards sale
        JOIN source ON sale.organization_id=source.organization_id AND sale.sale_source_visit_id=source.id
        WHERE sale.type='SALE' AND ($3::uuid IS NULL OR sale.assigned_to=$3))
      SELECT (SELECT count(*)::int FROM visible) AS total,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('access','FULL','id',p.id,'title',p.title,'status',p.status)
          ORDER BY p.created_at DESC,p.id DESC) FROM
          (SELECT * FROM visible ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5) p),'[]'::jsonb) AS items
      FROM source`, [actor.organizationId,id,actor.role === 'STAFF' ? actor.id : null,page.limit,page.offset]);
    const row = result.rows[0];
    return row ? { ...row, limit: page.limit, offset: page.offset } : null;
  }

  async details(actor: JobCardActor, id: string) {
    const result = await this.executor.query<SaleDetailsProjection>(
      `SELECT j.id AS "jobCardId", j.version AS "jobCardVersion",
        to_char(d.sold_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "soldAt",
        CASE WHEN d.sale_contact_id IS NULL THEN NULL ELSE jsonb_build_object(
          'id',d.sale_contact_id,'name',d.sale_contact_name_snapshot,'title',d.sale_contact_title_snapshot)
        END AS "saleContact",
        CASE WHEN source.id IS NULL OR ($3::uuid IS NOT NULL AND source.assigned_to<>$3)
          THEN jsonb_build_object('access','RESTRICTED','kind','SALE_FROM_VISIT')
          ELSE jsonb_build_object('access','FULL','kind','SALE_FROM_VISIT','id',source.id,
            'title',source.title,'status',source.status,'versionAtCreation',d.source_visit_version,
            'titleSnapshot',d.source_visit_title_snapshot,'customerNameSnapshot',d.source_customer_name_snapshot,
            'plannedContact',CASE WHEN d.source_planned_contact_id IS NULL THEN NULL ELSE jsonb_build_object(
              'id',d.source_planned_contact_id,'name',d.source_planned_contact_name_snapshot,'title',d.source_planned_contact_title_snapshot) END,
            'metContact',CASE WHEN d.source_met_contact_id IS NULL THEN NULL ELSE jsonb_build_object(
              'id',d.source_met_contact_id,'name',d.source_met_contact_name_snapshot,'title',d.source_met_contact_title_snapshot) END)
        END AS "sourceVisit",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'productId',i.product_id,
          'quantity',trim_scale(i.quantity)::text,'name',i.product_name_snapshot,'sku',i.product_sku_snapshot,
          'brand',i.product_brand_snapshot,'model',i.product_model_snapshot,'unit',i.unit_snapshot)
          ORDER BY i.sort_order,i.id) FROM job_card_sale_items i
          WHERE i.organization_id=j.organization_id AND i.job_card_id=j.id),'[]'::jsonb) AS items
       FROM job_cards j JOIN job_card_sale_details d ON d.organization_id=j.organization_id AND d.job_card_id=j.id
       LEFT JOIN job_cards source ON source.organization_id=j.organization_id AND source.id=j.sale_source_visit_id
       WHERE j.organization_id=$1 AND j.id=$2 AND j.type='SALE' AND ($3::uuid IS NULL OR j.assigned_to=$3)`,
      [actor.organizationId, id, actor.role === 'STAFF' ? actor.id : null],
    );
    return result.rows[0] ?? null;
  }
}
