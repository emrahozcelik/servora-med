import type { UserRole } from '../auth/types.js';

export const JOB_CARD_STATUSES = [
  'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL',
  'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
] as const;
export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export const JOB_CARD_TYPES = ['PRODUCT_DELIVERY', 'GENERAL_TASK'] as const;
export type JobCardType = (typeof JOB_CARD_TYPES)[number];

export const DELIVERY_PURPOSES = ['SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER'] as const;
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];

export const JOB_CARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type JobCardPriority = (typeof JOB_CARD_PRIORITIES)[number];

export const JOB_CARD_ACTIVITY_EVENTS = [
  'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
  'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED', 'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED', 'NOTE_ADDED',
] as const;
export type JobCardActivityEvent = (typeof JOB_CARD_ACTIVITY_EVENTS)[number];

export type JobCardActor = { id: string; organizationId: string; role: UserRole };
export type JobCardAssignee = JobCardActor & { isActive: boolean };

export type JobCard = {
  id: string;
  organizationId: string;
  type: JobCardType;
  status: JobCardStatus;
  version: number;
  title: string;
  description: string | null;
  customerId: string | null;
  contactId: string | null;
  assignedTo: string;
  createdBy: string;
  priority: JobCardPriority;
  dueDate: string | null;
};

export type JobCardCreateInput =
  | {
    clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string;
    description?: string | null; customerId: string; contactId?: string | null;
    assignedTo: string; priority?: JobCardPriority; dueDate?: string | null;
  }
  | {
    clientActionId: string; type: 'GENERAL_TASK'; title: string;
    description?: string | null; customerId?: string | null; contactId?: string | null;
    assignedTo: string; priority?: JobCardPriority; dueDate?: string | null;
  };

type NormalizedCommonCreateInput = {
  clientActionId: string; title: string; description: string | null; contactId: string | null;
  assignedTo: string; priority: JobCardPriority; dueDate: string | null;
};

export type NormalizedJobCardCreateInput =
  | NormalizedCommonCreateInput & { type: 'PRODUCT_DELIVERY'; customerId: string }
  | NormalizedCommonCreateInput & { type: 'GENERAL_TASK'; customerId: string | null };

export type RelatedIdentity = { id: string; name: string };
export type JobCardDetail = JobCard & {
  assignee: RelatedIdentity;
  customer: RelatedIdentity | null;
  contact: RelatedIdentity | null;
};

export type DeliveryItem = {
  id?: string;
  organizationId?: string;
  jobCardId?: string;
  productId: string;
  deliveryPurpose: DeliveryPurpose;
  deliveredAt: Date;
  quantity: number;
  unit?: string | null;
  productNameSnapshot?: string;
  productSkuSnapshot?: string | null;
  productModelSnapshot?: string | null;
  lotNo?: string | null;
  serialNo?: string | null;
  expiryDate?: string | null;
  deliveryNote?: string | null;
};

export type LifecycleCommand =
  | 'PLAN'
  | 'START'
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'REQUEST_REVISION'
  | 'RESUME'
  | 'CANCEL';

export type JobCardStatusFilter = JobCardStatus | 'active' | 'closed' | 'all';

export type JobCardBaseFilters = {
  q: string | null;
  type: JobCardType | null;
  assignedTo: string | null;
  customerId: string | null;
  priority: JobCardPriority | null;
  dueBefore: string | null;
  dueAfter: string | null;
};

export type JobCardWorkspaceFilters = JobCardBaseFilters & { status: JobCardStatusFilter };
export type JobCardListQuery = JobCardWorkspaceFilters & { limit: number; offset: number };
export type JobCardBoardQuery = JobCardBaseFilters & { limit: number };

export type JobCardListItem = {
  id: string;
  type: JobCardType;
  status: JobCardStatus;
  version: number;
  title: string;
  priority: JobCardPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  staffCompletedAt: string | null;
  customer: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  assignee: { id: string; name: string };
  deliveryItemCount: number;
};

export type Paginated<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type PaginatedJobCardList = Paginated<JobCardListItem>;

export type JobCardBoardColumn = { items: JobCardListItem[]; count: number };
export type JobCardBoard = {
  columns: {
    NEW: JobCardBoardColumn;
    PLANNED: JobCardBoardColumn;
    IN_PROGRESS: JobCardBoardColumn;
    WAITING_APPROVAL: JobCardBoardColumn;
    REVISION_REQUESTED: JobCardBoardColumn;
  };
  closedCounts: { COMPLETED: number; CANCELLED: number };
};

export type JobCardNoteDto = {
  id: string;
  jobCardId: string;
  note: string;
  author: { id: string; name: string };
  createdAt: string;
};

export type PaginatedJobCardNotes = Paginated<JobCardNoteDto>;

export type ActivityRecord = {
  id: string;
  jobCardId: string;
  actorId: string | null;
  actorName: string | null;
  eventType: JobCardActivityEvent;
  oldValue: unknown;
  newValue: unknown;
  metadata: unknown;
  clientActionId: string | null;
  createdAt: Date;
};

export type JobCardActivityDetails =
  | {
      kind: 'STATUS_TRANSITION';
      fromStatus: JobCardStatus;
      toStatus: JobCardStatus;
    }
  | {
      kind: 'FIELDS_UPDATED';
      changedFields: Array<
        'title' | 'description' | 'customer' | 'contact' |
        'assignee' | 'priority' | 'dueDate'
      >;
    }
  | {
      kind: 'DELIVERY_ITEM';
      operation: 'ADDED' | 'UPDATED' | 'REMOVED';
      itemId: string;
      purpose: DeliveryPurpose | null;
      quantity: number | null;
    }
  | { kind: 'NOTE'; noteId: string }
  | { kind: 'NONE' };

export type JobCardActivityDto = {
  id: string;
  jobCardId: string;
  eventType: JobCardActivityEvent;
  actor: { id: string; name: string } | null;
  details: JobCardActivityDetails;
  createdAt: string;
};

export type PaginatedJobCardActivity = Paginated<JobCardActivityDto>;
