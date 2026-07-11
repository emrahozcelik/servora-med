import type { DeliveryItem, JobCard, JobCardActivityEvent, JobCardAssignee, JobCardPriority, JobCardStatus } from './types.js';
import type { Pool, PoolClient } from 'pg';

export type CriticalActionClaim = {
  organizationId: string;
  userId: string;
  clientActionId: string;
  operationKey: string;
};

export type TransitionInput = {
  organizationId: string;
  jobCardId: string;
  expectedVersion: number;
  status: JobCardStatus;
  occurredAt: Date;
  actorId?: string;
  note?: string | null;
  revisionReason?: string | null;
};

export type ActivityInput = {
  organizationId: string;
  jobCardId: string;
  actorId: string;
  event: JobCardActivityEvent;
  clientActionId?: string;
  oldValue?: unknown;
  newValue?: unknown;
};

export type CreateJobCardRecord = {
  organizationId: string; type: JobCard['type']; title: string; description: string | null;
  customerId: string | null; assignedTo: string; createdBy: string;
  priority: JobCardPriority; dueDate: string | null;
};

export type JobCardListScope = { organizationId: string; assignedTo?: string };
export type UpdateJobCardFields = Partial<Pick<
  JobCard, 'title' | 'description' | 'customerId' | 'assignedTo' | 'priority' | 'dueDate'
>>;
export type UpdateJobCardInput = {
  organizationId: string; jobCardId: string; expectedVersion: number; fields: UpdateJobCardFields;
};
export type ProductReference = {
  id: string; organizationId: string; name: string; sku: string; model: string | null;
  unit: string; isActive: boolean;
};
export type DeliveryItemRecord = DeliveryItem & {
  id: string; organizationId: string; jobCardId: string; unit: string;
  productNameSnapshot: string; productSkuSnapshot: string | null; productModelSnapshot: string | null;
  lotNo: string | null; serialNo: string | null; expiryDate: string | null; deliveryNote: string | null;
};
export type SubmissionDeliveryItem = DeliveryItemRecord & { productActive: boolean };
export type ActivityRecord = {
  id: string; jobCardId: string; actorId: string | null; eventType: string;
  oldValue: unknown; newValue: unknown; metadata: unknown; clientActionId: string | null; createdAt: Date;
};

export interface JobCardTransaction {
  getJobForUpdate(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  transitionWithVersion(input: TransitionInput): Promise<JobCard | null>;
  appendActivity(input: ActivityInput): Promise<void>;
  getAssignee(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  customerExists(organizationId: string, customerId: string): Promise<boolean>;
  createJobCard(input: CreateJobCardRecord): Promise<JobCard>;
  updateFieldsWithVersion(input: UpdateJobCardInput): Promise<JobCard | null>;
  getProduct(organizationId: string, productId: string): Promise<ProductReference | null>;
  getDeliveryItemForUpdate(organizationId: string, jobCardId: string, itemId: string): Promise<DeliveryItemRecord | null>;
  createDeliveryItem(input: Omit<DeliveryItemRecord, 'id'>): Promise<DeliveryItemRecord>;
  updateDeliveryItem(itemId: string, input: Omit<DeliveryItemRecord, 'id'>): Promise<DeliveryItemRecord>;
  deleteDeliveryItem(itemId: string): Promise<void>;
  bumpVersion(organizationId: string, jobCardId: string, expectedVersion: number): Promise<JobCard | null>;
  getSubmissionDeliveryItems(organizationId: string, jobCardId: string): Promise<SubmissionDeliveryItem[]>;
}

export type CriticalActionResult<T> =
  | { kind: 'completed'; response: T }
  | { kind: 'replay'; response: T }
  | { kind: 'processing' };

export interface JobCardRepository {
  executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (transaction: JobCardTransaction) => Promise<T>,
  ): Promise<CriticalActionResult<T>>;
  listJobCards(scope: JobCardListScope): Promise<JobCard[]>;
  findJobCard(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  executeTransaction<T>(work: (transaction: JobCardTransaction) => Promise<T>): Promise<T>;
  listDeliveryItems(organizationId: string, jobCardId: string): Promise<DeliveryItemRecord[]>;
  listActivity(organizationId: string, jobCardId: string): Promise<ActivityRecord[]>;
}

type JobCardRow = {
  id: string; organization_id: string; type: JobCard['type']; status: JobCardStatus;
  version: number; title: string; description: string | null; customer_id: string | null;
  assigned_to: string; created_by: string; priority: JobCardPriority; due_date: string | null;
};
type DeliveryRow = {
  id: string; organization_id: string; job_card_id: string; product_id: string;
  delivery_purpose: DeliveryItem['deliveryPurpose']; delivered_at: Date; quantity: string;
  unit: string; product_name_snapshot: string; product_sku_snapshot: string | null;
  product_model_snapshot: string | null; lot_no: string | null; serial_no: string | null;
  expiry_date: string | null; delivery_note: string | null;
};
const DELIVERY_COLUMNS = `id, organization_id, job_card_id, product_id, delivery_purpose,
  delivered_at, quantity, unit, product_name_snapshot, product_sku_snapshot,
  product_model_snapshot, lot_no, serial_no, expiry_date, delivery_note`;
function mapDelivery(row: DeliveryRow): DeliveryItemRecord {
  return { id: row.id, organizationId: row.organization_id, jobCardId: row.job_card_id,
    productId: row.product_id, deliveryPurpose: row.delivery_purpose, deliveredAt: row.delivered_at,
    quantity: Number(row.quantity), unit: row.unit, productNameSnapshot: row.product_name_snapshot,
    productSkuSnapshot: row.product_sku_snapshot, productModelSnapshot: row.product_model_snapshot,
    lotNo: row.lot_no, serialNo: row.serial_no, expiryDate: row.expiry_date, deliveryNote: row.delivery_note };
}

function mapJobCard(row: JobCardRow): JobCard {
  return {
    id: row.id, organizationId: row.organization_id, type: row.type, status: row.status,
    version: row.version, title: row.title, description: row.description,
    customerId: row.customer_id, assignedTo: row.assigned_to, createdBy: row.created_by,
    priority: row.priority, dueDate: row.due_date,
  };
}

class PostgresJobCardTransaction implements JobCardTransaction {
  constructor(private readonly client: PoolClient) {}

  async getJobForUpdate(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardRow>(
      `SELECT id, organization_id, type, status, version, title, description, customer_id,
              assigned_to, created_by, priority, due_date
       FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async transitionWithVersion(input: TransitionInput) {
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards
       SET status = $4::varchar(30),
           version = version + 1,
           started_at = CASE WHEN $4 = 'IN_PROGRESS' THEN $5 ELSE started_at END,
           staff_completed_at = CASE WHEN $4 = 'WAITING_APPROVAL' THEN $5 ELSE staff_completed_at END,
           staff_completed_by = CASE WHEN $4 = 'WAITING_APPROVAL' THEN $6 ELSE staff_completed_by END,
           staff_completion_note = CASE WHEN $4 = 'WAITING_APPROVAL' THEN $7 ELSE staff_completion_note END,
           manager_approved_at = CASE WHEN $4 = 'COMPLETED' THEN $5 ELSE manager_approved_at END,
           manager_approved_by = CASE WHEN $4 = 'COMPLETED' THEN $6 ELSE manager_approved_by END,
           manager_approval_note = CASE WHEN $4 = 'COMPLETED' THEN $7 ELSE manager_approval_note END,
           revision_requested_at = CASE WHEN $4 = 'REVISION_REQUESTED' THEN $5 ELSE revision_requested_at END,
           revision_requested_by = CASE WHEN $4 = 'REVISION_REQUESTED' THEN $6 ELSE revision_requested_by END,
           revision_reason = CASE WHEN $4 = 'REVISION_REQUESTED' THEN $8 ELSE revision_reason END,
           updated_at = $5
       WHERE organization_id = $1 AND id = $2 AND version = $3
       RETURNING id, organization_id, type, status, version, title, description, customer_id,
                 assigned_to, created_by, priority, due_date`,
      [input.organizationId, input.jobCardId, input.expectedVersion, input.status, input.occurredAt,
        input.actorId ?? null, input.note ?? null, input.revisionReason ?? null],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async appendActivity(input: ActivityInput) {
    await this.client.query(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type, old_value, new_value, client_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.organizationId, input.jobCardId, input.actorId, input.event,
        input.oldValue ?? null, input.newValue ?? null, input.clientActionId ?? null],
    );
  }

  async getAssignee(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(
      `SELECT id, organization_id, role, is_active FROM users
       WHERE organization_id = $1 AND id = $2`, [organizationId, userId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async customerExists(organizationId: string, customerId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM customers WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, customerId],
    );
    return result.rowCount === 1;
  }

  async createJobCard(input: CreateJobCardRecord) {
    const result = await this.client.query<JobCardRow>(
      `INSERT INTO job_cards
         (organization_id, type, title, description, customer_id, assigned_to, created_by, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, organization_id, type, status, version, title, description, customer_id,
                 assigned_to, created_by, priority, due_date`,
      [input.organizationId, input.type, input.title, input.description, input.customerId,
        input.assignedTo, input.createdBy, input.priority, input.dueDate],
    );
    return mapJobCard(result.rows[0]!);
  }

  async updateFieldsWithVersion(input: UpdateJobCardInput) {
    const columns: Record<keyof UpdateJobCardFields, string> = {
      title: 'title', description: 'description', customerId: 'customer_id',
      assignedTo: 'assigned_to', priority: 'priority', dueDate: 'due_date',
    };
    const values: unknown[] = [input.organizationId, input.jobCardId, input.expectedVersion];
    const assignments = Object.entries(input.fields).map(([key, value]) => {
      values.push(value);
      return `${columns[key as keyof UpdateJobCardFields]} = $${values.length}`;
    });
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards SET ${assignments.join(', ')}, version = version + 1, updated_at = NOW()
       WHERE organization_id = $1 AND id = $2 AND version = $3
       RETURNING id, organization_id, type, status, version, title, description, customer_id,
                 assigned_to, created_by, priority, due_date`, values,
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getProduct(organizationId: string, productId: string) {
    const result = await this.client.query<{ id: string; organization_id: string; name: string; sku: string; model: string | null; unit: string; is_active: boolean }>(
      `SELECT id, organization_id, name, sku, model, unit, is_active FROM products
       WHERE organization_id = $1 AND id = $2`, [organizationId, productId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, name: row.name, sku: row.sku,
      model: row.model, unit: row.unit, isActive: row.is_active } : null;
  }

  async getDeliveryItemForUpdate(organizationId: string, jobCardId: string, itemId: string) {
    const result = await this.client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id = $1 AND job_card_id = $2 AND id = $3 FOR UPDATE`,
      [organizationId, jobCardId, itemId]);
    return result.rows[0] ? mapDelivery(result.rows[0]) : null;
  }

  async createDeliveryItem(input: Omit<DeliveryItemRecord, 'id'>) {
    const result = await this.client.query<DeliveryRow>(
      `INSERT INTO job_card_delivery_items
       (organization_id, job_card_id, product_id, delivery_purpose, delivered_at, quantity, unit,
        product_name_snapshot, product_sku_snapshot, product_model_snapshot, lot_no, serial_no, expiry_date, delivery_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${DELIVERY_COLUMNS}`,
      [input.organizationId, input.jobCardId, input.productId, input.deliveryPurpose, input.deliveredAt,
        input.quantity, input.unit, input.productNameSnapshot, input.productSkuSnapshot,
        input.productModelSnapshot, input.lotNo, input.serialNo, input.expiryDate, input.deliveryNote]);
    return mapDelivery(result.rows[0]!);
  }

  async updateDeliveryItem(itemId: string, input: Omit<DeliveryItemRecord, 'id'>) {
    const result = await this.client.query<DeliveryRow>(
      `UPDATE job_card_delivery_items SET product_id=$2, delivery_purpose=$3, delivered_at=$4,
       quantity=$5, unit=$6, product_name_snapshot=$7, product_sku_snapshot=$8,
       product_model_snapshot=$9, lot_no=$10, serial_no=$11, expiry_date=$12,
       delivery_note=$13, updated_at=NOW() WHERE id=$1 RETURNING ${DELIVERY_COLUMNS}`,
      [itemId, input.productId, input.deliveryPurpose, input.deliveredAt, input.quantity, input.unit,
        input.productNameSnapshot, input.productSkuSnapshot, input.productModelSnapshot, input.lotNo,
        input.serialNo, input.expiryDate, input.deliveryNote]);
    return mapDelivery(result.rows[0]!);
  }

  async deleteDeliveryItem(itemId: string) { await this.client.query('DELETE FROM job_card_delivery_items WHERE id = $1', [itemId]); }

  async bumpVersion(organizationId: string, jobCardId: string, expectedVersion: number) {
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards SET version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 AND version=$3
       RETURNING id, organization_id, type, status, version, title, description, customer_id,
                 assigned_to, created_by, priority, due_date`, [organizationId, jobCardId, expectedVersion]);
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getSubmissionDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.client.query<DeliveryRow & { product_active: boolean }>(
      `SELECT ${DELIVERY_COLUMNS.split(',').map((column) => `d.${column.trim()}`).join(', ')},
              p.is_active AS product_active
       FROM job_card_delivery_items d
       JOIN products p ON p.organization_id=d.organization_id AND p.id=d.product_id
       WHERE d.organization_id=$1 AND d.job_card_id=$2
       ORDER BY d.sort_order, d.created_at, d.id FOR UPDATE OF d`, [organizationId, jobCardId]);
    return result.rows.map((row) => ({ ...mapDelivery(row), productActive: row.product_active }));
  }
}

export class PostgresJobCardRepository implements JobCardRepository {
  constructor(private readonly pool: Pool) {}

  async executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (transaction: JobCardTransaction) => Promise<T>,
  ): Promise<CriticalActionResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, status)
         VALUES ($1, $2, $3, $4, 'processing')
         ON CONFLICT (organization_id, user_id, client_action_id, operation_key) DO NOTHING
         RETURNING id`,
        [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
      );

      if (claimed.rowCount === 0) {
        const existing = await client.query<{ status: string; response_body: T | null }>(
          `SELECT status, response_body FROM processed_actions
           WHERE organization_id = $1 AND user_id = $2
             AND client_action_id = $3 AND operation_key = $4`,
          [claim.organizationId, claim.userId, claim.clientActionId, claim.operationKey],
        );
        await client.query('COMMIT');
        const action = existing.rows[0];
        if (action?.status === 'completed' && action.response_body !== null) {
          return { kind: 'replay', response: action.response_body };
        }
        return { kind: 'processing' };
      }

      const response = await work(new PostgresJobCardTransaction(client));
      await client.query(
        `UPDATE processed_actions
         SET status = 'completed', status_code = 200, response_body = $2, completed_at = NOW()
         WHERE id = $1`,
        [claimed.rows[0]!.id, response],
      );
      await client.query('COMMIT');
      return { kind: 'completed', response };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listJobCards(scope: JobCardListScope) {
    const values: unknown[] = [scope.organizationId];
    const assignedFilter = scope.assignedTo ? ' AND assigned_to = $2' : '';
    if (scope.assignedTo) values.push(scope.assignedTo);
    const result = await this.pool.query<JobCardRow>(
      `SELECT id, organization_id, type, status, version, title, description, customer_id,
              assigned_to, created_by, priority, due_date
       FROM job_cards WHERE organization_id = $1${assignedFilter}
       ORDER BY created_at DESC, id DESC`, values,
    );
    return result.rows.map(mapJobCard);
  }

  async findJobCard(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<JobCardRow>(
      `SELECT id, organization_id, type, status, version, title, description, customer_id,
              assigned_to, created_by, priority, due_date
       FROM job_cards WHERE organization_id = $1 AND id = $2`, [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async executeTransaction<T>(work: (transaction: JobCardTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresJobCardTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id=$1 AND job_card_id=$2 ORDER BY sort_order, created_at, id`,
      [organizationId, jobCardId]);
    return result.rows.map(mapDelivery);
  }

  async listActivity(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<{
      id: string; job_card_id: string; actor_id: string | null; event_type: string;
      old_value: unknown; new_value: unknown; metadata: unknown; client_action_id: string | null; created_at: Date;
    }>(`SELECT id, job_card_id, actor_id, event_type, old_value, new_value, metadata,
              client_action_id, created_at
       FROM job_card_activity_logs WHERE organization_id=$1 AND job_card_id=$2
       ORDER BY created_at, id`, [organizationId, jobCardId]);
    return result.rows.map((row) => ({ id: row.id, jobCardId: row.job_card_id, actorId: row.actor_id,
      eventType: row.event_type, oldValue: row.old_value, newValue: row.new_value,
      metadata: row.metadata, clientActionId: row.client_action_id, createdAt: row.created_at }));
  }
}
