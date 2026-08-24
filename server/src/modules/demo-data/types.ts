export const DATA_CLASSES = ['BUSINESS', 'DEMO'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DEMO_DATASET_STATUSES = ['ACTIVE', 'PURGED'] as const;
export type DemoDatasetStatus = (typeof DEMO_DATASET_STATUSES)[number];

export const DEMO_DATASET_PURGE_PLAN_SCHEMA_VERSION = 2 as const;

export type DemoDatasetRecord = Readonly<{
  id: string;
  organizationId: string;
  datasetKey: string;
  seedVersion: string;
  status: DemoDatasetStatus;
  createdAt: Date;
  createdBy: string;
  purgedAt: Date | null;
}>;

export type DemoDatasetDto = Readonly<{
  id: string;
  organizationId: string;
  datasetKey: string;
  seedVersion: string;
  status: DemoDatasetStatus;
  createdAt: string;
  createdBy: string;
  purgedAt: string | null;
}>;

export type DemoDatasetImpactCounts = Readonly<{
  users: number;
  staffProfiles: number;
  customers: number;
  contacts: number;
  products: number;
  jobCards: number;
  deliveryItems: number;
  notes: number;
  confidentialNotes: number;
  activities: number;
  followUps: number;
  calendarEvents: number;
  conversations: number;
  messages: number;
  notifications: number;
  reminders: number;
  realtimeEvents: number;
}>;

export type DemoDatasetRetainedActorLink = Readonly<{
  auditEventId: string;
  actorUserId: string;
}>;

export type DemoDatasetConversationParticipant = Readonly<{
  conversationId: string;
  userId: string;
}>;

export type DemoDatasetConversationUserState = Readonly<{
  conversationId: string;
  userId: string;
}>;

/**
 * Internal, typed execution input. `planKeys` is a presentation/hash aid only;
 * the purge repository must execute from this plan instead of parsing strings.
 */
export type DemoDatasetPurgePlan = Readonly<{
  schemaVersion: typeof DEMO_DATASET_PURGE_PLAN_SCHEMA_VERSION;
  organizationId: string;
  datasetId: string;
  users: readonly string[];
  staffProfiles: readonly string[];
  customers: readonly string[];
  contacts: readonly string[];
  products: readonly string[];
  jobCards: readonly string[];
  jobCardDeleteOrder: readonly string[];
  deliveryItems: readonly string[];
  jobNotes: readonly string[];
  meetingDetails: readonly string[];
  jobActivities: readonly string[];
  jobActionLocations: readonly string[];
  confidentialNotes: readonly string[];
  calendarEvents: readonly string[];
  calendarActivities: readonly string[];
  reminders: readonly string[];
  conversations: readonly string[];
  messages: readonly string[];
  conversationParticipants: readonly DemoDatasetConversationParticipant[];
  conversationUserStates: readonly DemoDatasetConversationUserState[];
  messagingActivities: readonly string[];
  realtimeEvents: readonly string[];
  notifications: readonly string[];
  webPushSubscriptions: readonly string[];
  webPushDeliveries: readonly string[];
  sessions: readonly string[];
  processedActions: readonly string[];
  semanticallyRelevantEdges: readonly string[];
  retainedAuditActorLinks: readonly DemoDatasetRetainedActorLink[];
  datasetCreatorUserId: string | null;
}>;

export type DemoDatasetBlocker = Readonly<{
  code: string;
  message: string;
  sourceType: string;
  sourceId: string;
  relatedType: string | null;
  relatedId: string | null;
}>;

export type DemoDatasetPreviewData = Readonly<{
  dataset: DemoDatasetRecord;
  organizationName: string;
  affectedCounts: DemoDatasetImpactCounts;
  blockers: readonly DemoDatasetBlocker[];
  /** Internal canonical identities used to detect same-count graph replacement. */
  planKeys: readonly string[];
  /** R2 typed plan; populated by the PostgreSQL impact analyzer. */
  purgePlan?: DemoDatasetPurgePlan;
}>;

export type DemoDatasetPreviewDto = Readonly<{
  dataset: DemoDatasetDto;
  organization: Readonly<{ id: string; name: string }>;
  affectedCounts: DemoDatasetImpactCounts;
  blockers: readonly DemoDatasetBlocker[];
  safeToPurge: boolean;
  planHash: string;
}>;

export type DemoDatasetPurgeRequest = Readonly<{
  clientActionId: string;
  planHash: string;
}>;

export type DemoDatasetPurgeResponse = Readonly<{
  operationId: string;
  status: 'COMPLETED';
  dataset: DemoDatasetDto;
  datasetKey: string;
  seedVersion: string;
  planHash: string;
  affectedCounts: DemoDatasetImpactCounts;
  retained: Readonly<{
    auditActorDetaches: number;
    datasetCreatorDetached: boolean;
  }>;
  completedAt: string;
}>;

export interface DemoDatasetRepository {
  listDatasets(organizationId: string): Promise<readonly DemoDatasetRecord[]>;
  findDataset(organizationId: string, datasetId: string): Promise<DemoDatasetRecord | null>;
  getPreviewData(organizationId: string, datasetId: string): Promise<DemoDatasetPreviewData | null>;
  purge(
    organizationId: string,
    datasetId: string,
    actorUserId: string,
    request: DemoDatasetPurgeRequest,
  ): Promise<DemoDatasetPurgeResponse>;
}
