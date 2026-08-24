export const DATA_CLASSES = ['BUSINESS', 'DEMO'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DEMO_DATASET_STATUSES = ['ACTIVE', 'PURGED'] as const;
export type DemoDatasetStatus = (typeof DEMO_DATASET_STATUSES)[number];

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
}>;

export type DemoDatasetPreviewDto = Readonly<{
  dataset: DemoDatasetDto;
  organization: Readonly<{ id: string; name: string }>;
  affectedCounts: DemoDatasetImpactCounts;
  blockers: readonly DemoDatasetBlocker[];
  safeToPurge: boolean;
  planHash: string;
}>;

export interface DemoDatasetRepository {
  listDatasets(organizationId: string): Promise<readonly DemoDatasetRecord[]>;
  findDataset(organizationId: string, datasetId: string): Promise<DemoDatasetRecord | null>;
  getPreviewData(organizationId: string, datasetId: string): Promise<DemoDatasetPreviewData | null>;
}
