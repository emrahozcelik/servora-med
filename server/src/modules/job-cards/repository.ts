import {
  JOB_CARD_STATUSES,
  type DeliveryItem,
  type JobCard,
  type JobCardActivityEvent,
  type JobCardAssignee,
  type JobCardBaseFilters,
  type JobCardBoard,
  type JobCardBoardQuery,
  type JobCardListItem,
  type JobCardListQuery,
  type JobCardPriority,
  type JobCardStatus,
  type JobCardStatusFilter,
  type JobLifecycleFacts,
  type LifecycleCommand,
  type Paginated,
  type PersistedJobCardDetail,
  type JobCardNoteDto,
  type MeetingDetailsCandidate,
  type MeetingOutcome,
  type RelatedIdentity,
} from './types.js';
import type { Pool, PoolClient } from 'pg';
import type { ApprovalQueueItemPort } from '../reports/ports.js';
import type { ApprovalItem } from '../reports/types.js';

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
  command: LifecycleCommand;
  status: JobCardStatus;
  occurredAt: Date;
  actorId?: string;
  note?: string | null;
  revisionReason?: string | null;
  cancelReason?: string | null;
};

export type ActivityInput = {
  organizationId: string;
  jobCardId: string;
  actorId: string;
  event: JobCardActivityEvent;
  clientActionId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: unknown;
};

export type CreateNoteRecord = {
  organizationId: string; jobCardId: string; authorId: string; note: string;
};

export type CreateJobCardRecord = {
  organizationId: string; type: JobCard['type']; title: string; description: string | null;
  customerId: string | null; contactId: string | null; assignedTo: string; createdBy: string;
  priority: JobCardPriority; dueDate: string | null;
};
export type MeetingDetailsRecord = MeetingDetailsCandidate & {
  organizationId: string;
  jobCardId: string;
};

export type JobCardReadScope = { organizationId: string; assignedTo: string | null };
export type UpdateJobCardFields = Partial<Pick<
  JobCard, 'title' | 'description' | 'customerId' | 'contactId' | 'assignedTo' | 'priority' | 'dueDate'
>>;
export type UpdateJobCardInput = {
  organizationId: string; jobCardId: string; expectedVersion: number; fields: UpdateJobCardFields;
};
export type ProductReference = {
  id: string; organizationId: string; name: string; sku: string | null; model: string | null;
  unit: string | null; isActive: boolean;
};
export type DeliveryItemRecord = DeliveryItem & {
  id: string; organizationId: string; jobCardId: string; unit: string | null;
  productNameSnapshot: string; productSkuSnapshot: string | null; productModelSnapshot: string | null;
  lotNo: string | null; serialNo: string | null; expiryDate: string | null; deliveryNote: string | null;
};
export type SubmissionDeliveryItem = DeliveryItemRecord;
export type ActivityRecord = {
  id: string; jobCardId: string; actorId: string | null; actorName: string | null;
  eventType: JobCardActivityEvent;
  oldValue: unknown; newValue: unknown; metadata: unknown; clientActionId: string | null; createdAt: Date;
};
export type PageQuery = { limit: number; offset: number };
export type ReferenceCustomer = { id: string; name: string; customerType: string; status: string };
export type JobCustomerReference = { id: string; status: 'prospect' | 'active' | 'inactive' };
export type SubmissionCustomer = JobCustomerReference & { organizationId: string };
export type JobContactReference = { id: string; customerId: string; isActive: boolean };

export interface SubmissionReader {
  getAssignee(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getSubmissionCustomer(
    organizationId: string,
    customerId: string,
  ): Promise<SubmissionCustomer | null>;
  getSubmissionMeetingDetails(
    organizationId: string,
    jobCardId: string,
  ): Promise<MeetingDetailsCandidate | null>;
  getSubmissionDeliveryItems(
    organizationId: string,
    jobCardId: string,
  ): Promise<SubmissionDeliveryItem[]>;
}

export interface JobCardTransaction extends SubmissionReader {
  getJob(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobForUpdate(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  getJobDetail(organizationId: string, jobCardId: string): Promise<PersistedJobCardDetail | null>;
  transitionWithVersion(input: TransitionInput): Promise<JobCard | null>;
  appendActivity(input: ActivityInput): Promise<void>;
  createNote(input: CreateNoteRecord): Promise<JobCardNoteDto>;
  getAssigneeForUpdate(organizationId: string, userId: string): Promise<JobCardAssignee | null>;
  getCustomerForUpdate(organizationId: string, customerId: string): Promise<JobCustomerReference | null>;
  customerExists(organizationId: string, customerId: string): Promise<boolean>;
  getContactForUpdate(organizationId: string, contactId: string): Promise<JobContactReference | null>;
  createJobCard(input: CreateJobCardRecord): Promise<JobCard>;
  createMeetingDetails(input: { organizationId: string; jobCardId: string }): Promise<void>;
  updateMeetingDetails(input: MeetingDetailsRecord): Promise<void>;
  updateFieldsWithVersion(input: UpdateJobCardInput): Promise<JobCard | null>;
  getProduct(organizationId: string, productId: string): Promise<ProductReference | null>;
  getDeliveryItemForUpdate(organizationId: string, jobCardId: string, itemId: string): Promise<DeliveryItemRecord | null>;
  createDeliveryItem(input: Omit<DeliveryItemRecord, 'id'>): Promise<DeliveryItemRecord>;
  updateDeliveryItem(itemId: string, input: Omit<DeliveryItemRecord, 'id'>): Promise<DeliveryItemRecord>;
  deleteDeliveryItem(itemId: string): Promise<void>;
  bumpVersion(organizationId: string, jobCardId: string, expectedVersion: number): Promise<JobCard | null>;
}

export type CriticalActionResult<T> =
  | { kind: 'completed'; response: T }
  | { kind: 'replay'; response: T }
  | { kind: 'processing' };

export interface JobCardRepository extends SubmissionReader {
  executeCriticalAction<T>(
    claim: CriticalActionClaim,
    work: (transaction: JobCardTransaction) => Promise<T>,
  ): Promise<CriticalActionResult<T>>;
  listJobCards(
    scope: JobCardReadScope,
    query: JobCardListQuery,
  ): Promise<Paginated<JobCardListItem>>;
  listBoard(scope: JobCardReadScope, query: JobCardBoardQuery): Promise<JobCardBoard>;
  findJobCard(organizationId: string, jobCardId: string): Promise<JobCard | null>;
  findJobCardDetail(organizationId: string, jobCardId: string): Promise<PersistedJobCardDetail | null>;
  findMeetingDetails(
    organizationId: string,
    jobCardId: string,
  ): Promise<MeetingDetailsCandidate | null>;
  executeTransaction<T>(work: (transaction: JobCardTransaction) => Promise<T>): Promise<T>;
  listDeliveryItems(organizationId: string, jobCardId: string): Promise<DeliveryItemRecord[]>;
  listActivity(
    organizationId: string,
    jobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<ActivityRecord>>;
  listNotes(
    organizationId: string,
    jobCardId: string,
    page: PageQuery,
  ): Promise<Paginated<JobCardNoteDto>>;
  listReferenceCustomers(organizationId: string): Promise<ReferenceCustomer[]>;
}

type JobCardRow = {
  id: string; organization_id: string; type: JobCard['type']; status: JobCardStatus;
  version: number; title: string; description: string | null; customer_id: string | null; contact_id: string | null;
  assigned_to: string; created_by: string; priority: JobCardPriority;
  due_date: string | Date | null;
};
type JobCardDetailRow = JobCardRow & {
  assignee_id: string; assignee_name: string;
  customer_id_join: string | null; customer_name: string | null;
  contact_id_join: string | null; contact_name: string | null;
  created_at: Date;
  planned_at: Date | null;
  started_at: Date | null;
  staff_completed_at: Date | null;
  staff_completion_note: string | null;
  submitter_id: string | null;
  submitter_name: string | null;
  manager_approved_at: Date | null;
  manager_approval_note: string | null;
  approver_id: string | null;
  approver_name: string | null;
  revision_requested_at: Date | null;
  revision_reason: string | null;
  revision_actor_id: string | null;
  revision_actor_name: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  cancellation_actor_id: string | null;
  cancellation_actor_name: string | null;
  cancelled_from_status: string | null;
};
type JobCardListRow = {
  id: string;
  type: JobCard['type'];
  status: JobCardStatus;
  version: number;
  title: string;
  priority: JobCardPriority;
  due_date: string | Date | null;
  created_at: Date;
  updated_at: Date;
  staff_completed_at: Date | null;
  customer_id: string | null;
  customer_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  assignee_id: string;
  assignee_name: string;
  delivery_item_count: number;
};
type DeliveryRow = {
  id: string; organization_id: string; job_card_id: string; product_id: string;
  delivery_purpose: DeliveryItem['deliveryPurpose']; delivered_at: Date; quantity: string;
  unit: string | null; product_name_snapshot: string; product_sku_snapshot: string | null;
  product_model_snapshot: string | null; lot_no: string | null; serial_no: string | null;
  expiry_date: string | null; delivery_note: string | null;
};
type NoteRow = {
  id: string; job_card_id: string; note: string; author_id: string;
  author_name: string; created_at: Date;
};
type MeetingDetailsRow = {
  job_card_id: string;
  meeting_at: Date | null;
  outcome: MeetingOutcome | null;
  meeting_summary: string | null;
  next_follow_up_at: Date | null;
};

function mapMeetingDetails(row: MeetingDetailsRow): MeetingDetailsCandidate {
  return {
    meetingAt: row.meeting_at?.toISOString() ?? null,
    outcome: row.outcome,
    meetingSummary: row.meeting_summary,
    nextFollowUpAt: row.next_follow_up_at?.toISOString() ?? null,
  };
}
function mapNote(row: NoteRow): JobCardNoteDto {
  return {
    id: row.id, jobCardId: row.job_card_id, note: row.note,
    author: { id: row.author_id, name: row.author_name }, createdAt: row.created_at.toISOString(),
  };
}
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
    customerId: row.customer_id, contactId: row.contact_id, assignedTo: row.assigned_to, createdBy: row.created_by,
    priority: row.priority, dueDate: mapCalendarDate(row.due_date),
  };
}

function mapCalendarDate(value: string | Date | null) {
  if (value === null || typeof value === 'string') return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const JOB_CARD_DETAIL_QUERY = `SELECT j.id, j.organization_id, j.type, j.status, j.version,
       j.title, j.description, j.customer_id, j.contact_id, j.assigned_to, j.created_by,
       j.priority, j.due_date,
       j.created_at, j.planned_at, j.started_at,
       j.staff_completed_at, j.staff_completion_note,
       j.manager_approved_at, j.manager_approval_note,
       j.revision_requested_at, j.revision_reason,
       j.cancelled_at, j.cancel_reason,
       assignee.id AS assignee_id, assignee.name AS assignee_name,
       customer.id AS customer_id_join, customer.name AS customer_name,
       contact.id AS contact_id_join, contact.name AS contact_name,
       submitter.id AS submitter_id, submitter.name AS submitter_name,
       approver.id AS approver_id, approver.name AS approver_name,
       revision_actor.id AS revision_actor_id, revision_actor.name AS revision_actor_name,
       cancellation_actor.id AS cancellation_actor_id,
       cancellation_actor.name AS cancellation_actor_name,
       cancellation.cancelled_from_status
FROM job_cards j
JOIN users assignee
  ON assignee.organization_id = j.organization_id AND assignee.id = j.assigned_to
LEFT JOIN customers customer
  ON customer.organization_id = j.organization_id AND customer.id = j.customer_id
LEFT JOIN contacts contact
  ON contact.organization_id = j.organization_id AND contact.id = j.contact_id
LEFT JOIN users submitter
  ON submitter.organization_id = j.organization_id AND submitter.id = j.staff_completed_by
LEFT JOIN users approver
  ON approver.organization_id = j.organization_id AND approver.id = j.manager_approved_by
LEFT JOIN users revision_actor
  ON revision_actor.organization_id = j.organization_id
  AND revision_actor.id = j.revision_requested_by
LEFT JOIN users cancellation_actor
  ON cancellation_actor.organization_id = j.organization_id
  AND cancellation_actor.id = j.cancelled_by
LEFT JOIN LATERAL (
  SELECT a.old_value->>'status' AS cancelled_from_status
  FROM job_card_activity_logs a
  WHERE a.organization_id = j.organization_id
    AND a.job_card_id = j.id
    AND a.event_type = 'JOB_CANCELLED'
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1
) cancellation ON TRUE
WHERE j.organization_id = $1 AND j.id = $2`;

function mapInstant(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapRelatedIdentity(id: string | null, name: string | null): RelatedIdentity | null {
  if (id === null || name === null) return null;
  return { id, name };
}

function mapCancelledFromStatus(value: string | null): JobCardStatus | null {
  if (value === null) return null;
  if (!(JOB_CARD_STATUSES as readonly string[]).includes(value)) return null;
  if (value === 'COMPLETED' || value === 'CANCELLED') return null;
  return value as JobCardStatus;
}

function mapLifecycleFacts(row: JobCardDetailRow): JobLifecycleFacts {
  return {
    createdAt: row.created_at.toISOString(),
    plannedAt: mapInstant(row.planned_at),
    startedAt: mapInstant(row.started_at),
    submittedAt: mapInstant(row.staff_completed_at),
    submittedBy: mapRelatedIdentity(row.submitter_id, row.submitter_name),
    submissionNote: row.staff_completion_note,
    approvedAt: mapInstant(row.manager_approved_at),
    approvedBy: mapRelatedIdentity(row.approver_id, row.approver_name),
    approvalNote: row.manager_approval_note,
    revisionRequestedAt: mapInstant(row.revision_requested_at),
    revisionRequestedBy: mapRelatedIdentity(row.revision_actor_id, row.revision_actor_name),
    revisionReason: row.revision_reason,
    cancelledAt: mapInstant(row.cancelled_at),
    cancelledBy: mapRelatedIdentity(row.cancellation_actor_id, row.cancellation_actor_name),
    cancelReason: row.cancel_reason,
    cancelledFromStatus: mapCancelledFromStatus(row.cancelled_from_status),
  };
}

function mapJobCardDetail(row: JobCardDetailRow): PersistedJobCardDetail {
  return {
    ...mapJobCard(row),
    assignee: { id: row.assignee_id, name: row.assignee_name },
    customer: row.customer_id_join === null
      ? null
      : { id: row.customer_id_join, name: row.customer_name! },
    contact: row.contact_id_join === null
      ? null
      : { id: row.contact_id_join, name: row.contact_name! },
    lifecycle: mapLifecycleFacts(row),
  };
}

function mapJobCardListItem(row: JobCardListRow): JobCardListItem {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    version: row.version,
    title: row.title,
    priority: row.priority,
    dueDate: mapCalendarDate(row.due_date),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    staffCompletedAt: row.staff_completed_at?.toISOString() ?? null,
    customer: row.customer_id === null
      ? null
      : { id: row.customer_id, name: row.customer_name! },
    contact: row.contact_id === null
      ? null
      : { id: row.contact_id, name: row.contact_name! },
    assignee: { id: row.assignee_id, name: row.assignee_name },
    deliveryItemCount: Number(row.delivery_item_count),
  };
}

type SqlFilter = { clause: string; values: unknown[] };

const ACTIVE_JOB_CARD_STATUSES = [
  'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED',
] as const;

const WORKSPACE_JOINS = `FROM job_cards j
  LEFT JOIN customers c
    ON c.organization_id = j.organization_id AND c.id = j.customer_id
  LEFT JOIN contacts ct
    ON ct.organization_id = j.organization_id AND ct.id = j.contact_id`;

const JOB_CARD_LIST_COLUMNS = `j.id, j.type, j.status, j.version, j.title, j.priority, j.due_date,
  j.created_at, j.updated_at, j.staff_completed_at,
  c.id AS customer_id, c.name AS customer_name,
  ct.id AS contact_id, ct.name AS contact_name,
  u.id AS assignee_id, u.name AS assignee_name,
  COALESCE(delivery.delivery_item_count, 0)::int AS delivery_item_count`;

const WORKSPACE_ITEM_JOINS = `${WORKSPACE_JOINS}
  JOIN users u
    ON u.organization_id = j.organization_id AND u.id = j.assigned_to
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS delivery_item_count
    FROM job_card_delivery_items di
    WHERE di.organization_id = j.organization_id AND di.job_card_id = j.id
  ) delivery ON TRUE`;

function statusValues(status: JobCardStatusFilter) {
  if (status === 'all') return null;
  if (status === 'active') {
    return [...ACTIVE_JOB_CARD_STATUSES];
  }
  if (status === 'closed') return ['COMPLETED', 'CANCELLED'];
  return [status];
}

function workspaceWhere(
  scope: JobCardReadScope,
  filters: JobCardBaseFilters & { status?: JobCardStatusFilter },
): SqlFilter {
  const predicates = ['j.organization_id = $1'];
  const values: unknown[] = [scope.organizationId];
  const add = (sql: (position: number) => string, value: unknown) => {
    values.push(value);
    predicates.push(sql(values.length));
  };
  if (scope.assignedTo) add((position) => `j.assigned_to = $${position}`, scope.assignedTo);
  if (filters.assignedTo) add((position) => `j.assigned_to = $${position}`, filters.assignedTo);
  if (filters.type) add((position) => `j.type = $${position}`, filters.type);
  if (filters.customerId) add((position) => `j.customer_id = $${position}`, filters.customerId);
  if (filters.priority) add((position) => `j.priority = $${position}`, filters.priority);
  if (filters.dueAfter) add((position) => `j.due_date >= $${position}::date`, filters.dueAfter);
  if (filters.dueBefore) add((position) => `j.due_date <= $${position}::date`, filters.dueBefore);
  const statuses = statusValues(filters.status ?? 'all');
  if (statuses) add((position) => `j.status = ANY($${position}::varchar[])`, statuses);
  if (filters.q) {
    const escaped = filters.q.replace(/[\\%_]/g, '\\$&');
    add(
      (position) => `(j.title ILIKE $${position} ESCAPE '\\' OR c.name ILIKE $${position} ESCAPE '\\' OR ct.name ILIKE $${position} ESCAPE '\\')`,
      `%${escaped}%`,
    );
  }
  return { clause: predicates.join(' AND '), values };
}

class PostgresJobCardTransaction implements JobCardTransaction {
  constructor(private readonly client: PoolClient) {}

  async getJob(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardRow>(
      `SELECT id, organization_id, type, status, version, title, description, customer_id, contact_id,
              assigned_to, created_by, priority, due_date
       FROM job_cards WHERE organization_id = $1 AND id = $2`, [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getJobForUpdate(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardRow>(
      `SELECT id, organization_id, type, status, version, title, description, customer_id, contact_id,
              assigned_to, created_by, priority, due_date
       FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getJobDetail(organizationId: string, jobCardId: string) {
    const result = await this.client.query<JobCardDetailRow>(
      JOB_CARD_DETAIL_QUERY,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCardDetail(result.rows[0]) : null;
  }

  async transitionWithVersion(input: TransitionInput) {
    const result = await this.client.query<JobCardRow>(
      `UPDATE job_cards
       SET status = $4::varchar(30),
           version = version + 1,
           planned_at = CASE WHEN $4 = 'PLANNED' THEN $5 ELSE planned_at END,
           started_at = CASE WHEN $10 = 'START' THEN COALESCE(started_at, $5) ELSE started_at END,
           staff_completed_at = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $5 ELSE staff_completed_at END,
           staff_completed_by = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $6 ELSE staff_completed_by END,
           staff_completion_note = CASE WHEN $10 = 'SUBMIT_FOR_APPROVAL' THEN $7 ELSE staff_completion_note END,
           manager_approved_at = CASE WHEN $10 = 'APPROVE' THEN $5 ELSE manager_approved_at END,
           manager_approved_by = CASE WHEN $10 = 'APPROVE' THEN $6 ELSE manager_approved_by END,
           manager_approval_note = CASE WHEN $10 = 'APPROVE' THEN $7 ELSE manager_approval_note END,
           revision_requested_at = CASE WHEN $10 = 'REQUEST_REVISION' THEN $5 ELSE revision_requested_at END,
           revision_requested_by = CASE WHEN $10 = 'REQUEST_REVISION' THEN $6 ELSE revision_requested_by END,
           revision_reason = CASE WHEN $10 = 'REQUEST_REVISION' THEN $8 ELSE revision_reason END,
           cancelled_at = CASE WHEN $10 = 'CANCEL' THEN $5 ELSE cancelled_at END,
           cancelled_by = CASE WHEN $10 = 'CANCEL' THEN $6 ELSE cancelled_by END,
           cancel_reason = CASE WHEN $10 = 'CANCEL' THEN $9 ELSE cancel_reason END,
           updated_at = $5
       WHERE organization_id = $1 AND id = $2 AND version = $3
       RETURNING id, organization_id, type, status, version, title, description, customer_id, contact_id,
                 assigned_to, created_by, priority, due_date`,
      [input.organizationId, input.jobCardId, input.expectedVersion, input.status, input.occurredAt,
        input.actorId ?? null, input.note ?? null, input.revisionReason ?? null,
        input.cancelReason ?? null, input.command],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async appendActivity(input: ActivityInput) {
    await this.client.query(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type, old_value, new_value, metadata, client_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.organizationId, input.jobCardId, input.actorId, input.event,
        input.oldValue ?? null, input.newValue ?? null, input.metadata ?? null,
        input.clientActionId ?? null],
    );
  }

  async createNote(input: CreateNoteRecord) {
    const result = await this.client.query<NoteRow>(
      `WITH inserted AS (
         INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id, organization_id, job_card_id, author_id, note, created_at
       )
       SELECT n.id, n.job_card_id, n.note, n.author_id, u.name AS author_name, n.created_at
       FROM inserted n
       JOIN users u ON u.organization_id = n.organization_id AND u.id = n.author_id`,
      [input.organizationId, input.jobCardId, input.authorId, input.note],
    );
    return mapNote(result.rows[0]!);
  }

  async getAssigneeForUpdate(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(
      `SELECT id, organization_id, role, is_active FROM users
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, userId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async getAssignee(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(`SELECT id, organization_id, role, is_active FROM users
        WHERE organization_id = $1 AND id = $2`, [organizationId, userId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async getCustomerForUpdate(organizationId: string, customerId: string) {
    const result = await this.client.query<{ id: string; status: JobCustomerReference['status'] }>(
      `SELECT id, status FROM customers WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, customerId],
    );
    return result.rows[0] ?? null;
  }

  async customerExists(organizationId: string, customerId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM customers WHERE organization_id=$1 AND id=$2 LIMIT 1`, [organizationId, customerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getSubmissionCustomer(organizationId: string, customerId: string) {
    const result = await this.client.query<{
      id: string;
      organization_id: string;
      status: SubmissionCustomer['status'];
    }>(
      `SELECT id, organization_id, status
         FROM customers
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, customerId],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, organizationId: row.organization_id, status: row.status }
      : null;
  }

  async getContactForUpdate(organizationId: string, contactId: string) {
    const result = await this.client.query<{ id: string; customer_id: string; is_active: boolean }>(
      `SELECT id, customer_id, is_active FROM contacts
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, contactId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, customerId: row.customer_id, isActive: row.is_active } : null;
  }

  async createJobCard(input: CreateJobCardRecord) {
    const result = await this.client.query<JobCardRow>(
      `INSERT INTO job_cards
         (organization_id, type, title, description, customer_id, contact_id, assigned_to, created_by, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, organization_id, type, status, version, title, description, customer_id, contact_id,
                 assigned_to, created_by, priority, due_date`,
      [input.organizationId, input.type, input.title, input.description, input.customerId,
        input.contactId, input.assignedTo, input.createdBy, input.priority, input.dueDate],
    );
    return mapJobCard(result.rows[0]!);
  }

  async createMeetingDetails(input: { organizationId: string; jobCardId: string }) {
    await this.client.query(
      `INSERT INTO job_card_meeting_details (organization_id, job_card_id)
       VALUES ($1, $2)`,
      [input.organizationId, input.jobCardId],
    );
  }

  async getSubmissionMeetingDetails(organizationId: string, jobCardId: string) {
    const result = await this.client.query<MeetingDetailsRow>(
      `SELECT job_card_id, meeting_at, outcome, meeting_summary, next_follow_up_at
         FROM job_card_meeting_details
        WHERE organization_id = $1 AND job_card_id = $2
        FOR UPDATE`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapMeetingDetails(result.rows[0]) : null;
  }

  async updateMeetingDetails(input: MeetingDetailsRecord) {
    await this.client.query(
      `UPDATE job_card_meeting_details
          SET meeting_at = $3, outcome = $4, meeting_summary = $5,
              next_follow_up_at = $6, updated_at = NOW()
        WHERE organization_id = $1 AND job_card_id = $2`,
      [input.organizationId, input.jobCardId, input.meetingAt, input.outcome,
        input.meetingSummary, input.nextFollowUpAt],
    );
  }

  async updateFieldsWithVersion(input: UpdateJobCardInput) {
    const columns: Record<keyof UpdateJobCardFields, string> = {
      title: 'title', description: 'description', customerId: 'customer_id', contactId: 'contact_id',
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
       RETURNING id, organization_id, type, status, version, title, description, customer_id, contact_id,
                 assigned_to, created_by, priority, due_date`, values,
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getProduct(organizationId: string, productId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; name: string; sku: string | null;
      model: string | null; unit: string | null; is_active: boolean;
    }>(
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
       RETURNING id, organization_id, type, status, version, title, description, customer_id, contact_id,
                 assigned_to, created_by, priority, due_date`, [organizationId, jobCardId, expectedVersion]);
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async getSubmissionDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.client.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id=$1 AND job_card_id=$2
       ORDER BY sort_order, created_at, id FOR UPDATE`, [organizationId, jobCardId]);
    return result.rows.map(mapDelivery);
  }
}

export class PostgresJobCardRepository
implements JobCardRepository, ApprovalQueueItemPort {
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

  async getApprovalItems(input: {
    organizationId: string;
    requestTime: Date;
    limit: number;
    offset: number;
  }): Promise<ApprovalItem[]> {
    const rows = await this.pool.query<JobCardListRow & { waiting_minutes: number }>(
      `SELECT ${JOB_CARD_LIST_COLUMNS},
       FLOOR(EXTRACT(EPOCH FROM GREATEST(
         $2::timestamptz - j.staff_completed_at,
         interval '0 seconds')) / 60)::int AS waiting_minutes
       ${WORKSPACE_ITEM_JOINS}
       WHERE j.organization_id = $1 AND j.status = 'WAITING_APPROVAL'
       ORDER BY j.staff_completed_at ASC, j.id ASC
       LIMIT $3 OFFSET $4`,
      [input.organizationId, input.requestTime, input.limit, input.offset],
    );
    return rows.rows.map((row) => ({
      ...mapJobCardListItem(row),
      waitingMinutes: Number(row.waiting_minutes),
    }));
  }

  async listJobCards(scope: JobCardReadScope, query: JobCardListQuery) {
    const filter = workspaceWhere(scope, query);
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       ${WORKSPACE_JOINS}
       WHERE ${filter.clause}`,
      filter.values,
    );
    const limitPosition = filter.values.length + 1;
    const offsetPosition = filter.values.length + 2;
    const order = query.status === 'WAITING_APPROVAL'
      ? 'j.staff_completed_at ASC, j.id ASC'
      : 'j.updated_at DESC, j.id DESC';
    const items = await this.pool.query<JobCardListRow>(
      `SELECT ${JOB_CARD_LIST_COLUMNS}
       ${WORKSPACE_ITEM_JOINS}
       WHERE ${filter.clause}
       ORDER BY ${order}
       LIMIT $${limitPosition} OFFSET $${offsetPosition}`,
      [...filter.values, query.limit, query.offset],
    );
    return {
      items: items.rows.map(mapJobCardListItem),
      total: Number(count.rows[0]?.total ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async listBoard(scope: JobCardReadScope, query: JobCardBoardQuery): Promise<JobCardBoard> {
    const countFilter = workspaceWhere(scope, query);
    const counts = await this.pool.query<{ status: JobCardStatus; count: number }>(
      `SELECT j.status, COUNT(*)::int AS count
       ${WORKSPACE_JOINS}
       WHERE ${countFilter.clause}
       GROUP BY j.status`,
      countFilter.values,
    );
    const itemFilter = workspaceWhere(scope, { ...query, status: 'active' });
    const limitPosition = itemFilter.values.length + 1;
    const items = await this.pool.query<JobCardListRow>(
      `WITH ranked AS (
         SELECT ${JOB_CARD_LIST_COLUMNS},
                ROW_NUMBER() OVER (PARTITION BY j.status ORDER BY j.updated_at DESC, j.id DESC) AS row_number
         ${WORKSPACE_ITEM_JOINS}
         WHERE ${itemFilter.clause}
       )
       SELECT * FROM ranked
       WHERE row_number <= $${limitPosition}
       ORDER BY status, updated_at DESC, id DESC`,
      [...itemFilter.values, query.limit],
    );

    const columns: JobCardBoard['columns'] = {
      NEW: { items: [], count: 0 },
      PLANNED: { items: [], count: 0 },
      IN_PROGRESS: { items: [], count: 0 },
      WAITING_APPROVAL: { items: [], count: 0 },
      REVISION_REQUESTED: { items: [], count: 0 },
    };
    const closedCounts = { COMPLETED: 0, CANCELLED: 0 };
    for (const row of counts.rows) {
      if (row.status === 'COMPLETED' || row.status === 'CANCELLED') {
        closedCounts[row.status] = Number(row.count);
      } else if (row.status in columns) {
        columns[row.status as keyof typeof columns].count = Number(row.count);
      }
    }
    for (const row of items.rows) {
      if (row.status in columns) {
        columns[row.status as keyof typeof columns].items.push(mapJobCardListItem(row));
      }
    }
    return { columns, closedCounts };
  }

  async findJobCard(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<JobCardRow>(
      `SELECT id, organization_id, type, status, version, title, description, customer_id, contact_id,
              assigned_to, created_by, priority, due_date
       FROM job_cards WHERE organization_id = $1 AND id = $2`, [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCard(result.rows[0]) : null;
  }

  async findJobCardDetail(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<JobCardDetailRow>(
      JOB_CARD_DETAIL_QUERY,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapJobCardDetail(result.rows[0]) : null;
  }

  async findMeetingDetails(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<MeetingDetailsRow>(
      `SELECT job_card_id, meeting_at, outcome, meeting_summary, next_follow_up_at
         FROM job_card_meeting_details
        WHERE organization_id = $1 AND job_card_id = $2`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapMeetingDetails(result.rows[0]) : null;
  }

  async getAssignee(organizationId: string, userId: string) {
    const result = await this.pool.query<{
      id: string; organization_id: string; role: JobCardAssignee['role']; is_active: boolean;
    }>(`SELECT id, organization_id, role, is_active FROM users
        WHERE organization_id = $1 AND id = $2`, [organizationId, userId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async getSubmissionCustomer(organizationId: string, customerId: string) {
    const result = await this.pool.query<{
      id: string;
      organization_id: string;
      status: SubmissionCustomer['status'];
    }>(
      `SELECT id, organization_id, status
         FROM customers
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, customerId],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, organizationId: row.organization_id, status: row.status }
      : null;
  }

  async getSubmissionMeetingDetails(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<MeetingDetailsRow>(
      `SELECT job_card_id, meeting_at, outcome, meeting_summary, next_follow_up_at
         FROM job_card_meeting_details
        WHERE organization_id = $1 AND job_card_id = $2`,
      [organizationId, jobCardId],
    );
    return result.rows[0] ? mapMeetingDetails(result.rows[0]) : null;
  }

  async getSubmissionDeliveryItems(organizationId: string, jobCardId: string) {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_card_delivery_items
       WHERE organization_id=$1 AND job_card_id=$2 ORDER BY sort_order, created_at, id`,
      [organizationId, jobCardId]);
    return result.rows.map(mapDelivery);
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

  async listActivity(organizationId: string, jobCardId: string, page: PageQuery) {
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM job_card_activity_logs
       WHERE organization_id=$1 AND job_card_id=$2`,
      [organizationId, jobCardId],
    );
    const result = await this.pool.query<{
      id: string; job_card_id: string; actor_id: string | null; actor_name: string | null;
      event_type: JobCardActivityEvent; old_value: unknown; new_value: unknown; metadata: unknown;
      client_action_id: string | null; created_at: Date;
    }>(`SELECT a.id, a.job_card_id, a.actor_id, u.name AS actor_name, a.event_type,
              a.old_value, a.new_value, a.metadata, a.client_action_id, a.created_at
       FROM job_card_activity_logs a
       LEFT JOIN users u
         ON u.organization_id = a.organization_id AND u.id = a.actor_id
       WHERE a.organization_id=$1 AND a.job_card_id=$2
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $3 OFFSET $4`, [organizationId, jobCardId, page.limit, page.offset]);
    return {
      items: result.rows.map((row) => ({
        id: row.id, jobCardId: row.job_card_id, actorId: row.actor_id, actorName: row.actor_name,
        eventType: row.event_type, oldValue: row.old_value, newValue: row.new_value,
        metadata: row.metadata, clientActionId: row.client_action_id, createdAt: row.created_at,
      })),
      total: Number(count.rows[0]?.total ?? 0),
      limit: page.limit,
      offset: page.offset,
    };
  }

  async listNotes(organizationId: string, jobCardId: string, page: PageQuery) {
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM job_card_notes
       WHERE organization_id=$1 AND job_card_id=$2`,
      [organizationId, jobCardId],
    );
    const result = await this.pool.query<NoteRow>(
      `SELECT n.id, n.job_card_id, n.note, n.author_id, u.name AS author_name, n.created_at
       FROM job_card_notes n
       JOIN users u
         ON u.organization_id = n.organization_id AND u.id = n.author_id
       WHERE n.organization_id=$1 AND n.job_card_id=$2
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $3 OFFSET $4`,
      [organizationId, jobCardId, page.limit, page.offset],
    );
    return {
      items: result.rows.map(mapNote), total: Number(count.rows[0]?.total ?? 0),
      limit: page.limit, offset: page.offset,
    };
  }

  async listReferenceCustomers(organizationId: string) {
    const result = await this.pool.query<{ id: string; name: string; customer_type: string; status: string }>(
      `SELECT id, name, customer_type, status FROM customers
       WHERE organization_id=$1 AND status <> 'inactive' ORDER BY name, id`, [organizationId]);
    return result.rows.map((row) => ({ id: row.id, name: row.name, customerType: row.customer_type, status: row.status }));
  }

}
