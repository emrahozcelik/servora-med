import {
  ApiError,
  boolean,
  items,
  json,
  nullableString,
  number,
  object,
  request,
  string,
} from './api';

export type DemoDatasetStatus = 'ACTIVE';

export type DemoDataset = {
  id: string;
  organizationId: string;
  datasetKey: string;
  seedVersion: string;
  status: DemoDatasetStatus;
  createdAt: string;
  createdBy: string;
};

export type DemoDatasetImpactCounts = {
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
};

export type DemoDatasetBlocker = {
  code: string;
  message: string;
  sourceType: string;
  sourceId: string;
  relatedType: string | null;
  relatedId: string | null;
};

export type DemoDatasetPreview = {
  dataset: DemoDataset;
  organization: { id: string; name: string };
  affectedCounts: DemoDatasetImpactCounts;
  blockers: DemoDatasetBlocker[];
  safeToPurge: boolean;
  planHash: string;
};

export type DemoDatasetPurgeResponse = {
  operationId: string;
  status: 'COMPLETED';
  datasetId: string;
  datasetKey: string;
  seedVersion: string;
  planHash: string;
  affectedCounts: DemoDatasetImpactCounts;
  retained: {
    auditActorDetaches: number;
  };
  completedAt: string;
};

export type DemoDatasetPurgeRequest = {
  clientActionId: string;
  planHash: string;
};

export type DemoDatasetCreateRequest = {
  clientActionId: string;
};

export type DemoDatasetCreateCounts = {
  users: number;
  customers: number;
  products: number;
  jobCards: number;
};

export type DemoDatasetCreateResponse = {
  dataset: DemoDataset;
  counts: DemoDatasetCreateCounts;
  replayed: boolean;
};

const DATASET_STATUSES = ['ACTIVE'] as const;
const COUNT_FIELDS = [
  'users', 'staffProfiles', 'customers', 'contacts', 'products', 'jobCards',
  'deliveryItems', 'notes', 'confidentialNotes', 'activities', 'followUps',
  'calendarEvents', 'conversations', 'messages', 'notifications', 'reminders',
  'realtimeEvents',
] as const;

function invalid(field: string): never {
  throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
}

function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  const candidate = string(value, field);
  if (!values.includes(candidate as T)) invalid(field);
  return candidate as T;
}

function parseDataset(value: unknown): DemoDataset {
  const item = object(value);
  const status = enumValue(item.status, 'status', DATASET_STATUSES);
  return {
    id: string(item.id, 'id'),
    organizationId: string(item.organizationId, 'organizationId'),
    datasetKey: string(item.datasetKey, 'datasetKey'),
    seedVersion: string(item.seedVersion, 'seedVersion'),
    status,
    createdAt: string(item.createdAt, 'createdAt'),
    createdBy: string(item.createdBy, 'createdBy'),
  };
}

function parseCounts(value: unknown): DemoDatasetImpactCounts {
  const item = object(value);
  const result = {} as DemoDatasetImpactCounts;
  for (const field of COUNT_FIELDS) {
    const count = number(item[field], `affectedCounts.${field}`);
    if (!Number.isInteger(count) || count < 0) invalid(`affectedCounts.${field}`);
    result[field] = count;
  }
  return result;
}

function parseBlocker(value: unknown): DemoDatasetBlocker {
  const item = object(value);
  return {
    code: string(item.code, 'blockers.code'),
    message: string(item.message, 'blockers.message'),
    sourceType: string(item.sourceType, 'blockers.sourceType'),
    sourceId: string(item.sourceId, 'blockers.sourceId'),
    relatedType: item.relatedType === null ? null : nullableString(item.relatedType, 'blockers.relatedType'),
    relatedId: item.relatedId === null ? null : nullableString(item.relatedId, 'blockers.relatedId'),
  };
}

export function parseDemoDatasetPreview(value: unknown): DemoDatasetPreview {
  const item = object(value);
  const organization = object(item.organization);
  const blockers = item.blockers;
  if (!Array.isArray(blockers)) invalid('blockers');
  const parsedBlockers = blockers.map(parseBlocker);
  const safeToPurge = boolean(item.safeToPurge, 'safeToPurge');
  if (safeToPurge !== (parsedBlockers.length === 0)) invalid('safeToPurge');
  const planHash = string(item.planHash, 'planHash');
  if (!/^[0-9a-f]{64}$/.test(planHash)) invalid('planHash');
  return {
    dataset: parseDataset(item.dataset),
    organization: {
      id: string(organization.id, 'organization.id'),
      name: string(organization.name, 'organization.name'),
    },
    affectedCounts: parseCounts(item.affectedCounts),
    blockers: parsedBlockers,
    safeToPurge,
    planHash,
  };
}

export function parseDemoDatasetPurgeResponse(
  value: unknown,
  expected: { datasetId: string; datasetKey: string; seedVersion: string; planHash: string },
): DemoDatasetPurgeResponse {
  const item = object(value);
  const retained = object(item.retained);
  const datasetId = string(item.datasetId, 'datasetId');
  const datasetKey = string(item.datasetKey, 'datasetKey');
  const seedVersion = string(item.seedVersion, 'seedVersion');
  const planHash = string(item.planHash, 'planHash');
  const auditActorDetaches = number(retained.auditActorDetaches, 'retained.auditActorDetaches');
  if (datasetId !== expected.datasetId) invalid('datasetId');
  if (datasetKey !== expected.datasetKey) invalid('datasetKey');
  if (seedVersion !== expected.seedVersion) invalid('seedVersion');
  if (!/^[0-9a-f]{64}$/.test(planHash) || planHash !== expected.planHash) invalid('planHash');
  if (!Number.isInteger(auditActorDetaches) || auditActorDetaches < 0) {
    invalid('retained.auditActorDetaches');
  }
  return {
    operationId: string(item.operationId, 'operationId'),
    status: enumValue(item.status, 'status', ['COMPLETED'] as const),
    datasetId,
    datasetKey,
    seedVersion,
    planHash,
    affectedCounts: parseCounts(item.affectedCounts),
    retained: {
      auditActorDetaches,
    },
    completedAt: string(item.completedAt, 'completedAt'),
  };
}

export async function listDemoDatasets(): Promise<DemoDataset[]> {
  return items(await request('/api/admin/demo-datasets')).map(parseDataset);
}

export async function getDemoDataset(datasetId: string): Promise<DemoDataset> {
  const dataset = parseDataset(await request(`/api/admin/demo-datasets/${encodeURIComponent(datasetId)}`));
  if (dataset.id !== datasetId) invalid('dataset.id');
  return dataset;
}

export async function previewDemoDataset(datasetId: string): Promise<DemoDatasetPreview> {
  const preview = parseDemoDatasetPreview(await request(
    `/api/admin/demo-datasets/${encodeURIComponent(datasetId)}/preview`,
  ));
  if (preview.dataset.id !== datasetId) invalid('dataset.id');
  return preview;
}

export async function purgeDemoDataset(
  datasetId: string,
  input: DemoDatasetPurgeRequest,
  expectedDataset: Pick<DemoDataset, 'datasetKey' | 'seedVersion'>,
): Promise<DemoDatasetPurgeResponse> {
  return parseDemoDatasetPurgeResponse(await request(
    `/api/admin/demo-datasets/${encodeURIComponent(datasetId)}/purge`,
    json('POST', input),
  ), {
    datasetId,
    datasetKey: expectedDataset.datasetKey,
    seedVersion: expectedDataset.seedVersion,
    planHash: input.planHash,
  });
}

function parseDemoDatasetCreateResponse(value: unknown): DemoDatasetCreateResponse {
  const item = object(value);
  const dataset = parseDataset(item.dataset);
  const countsRaw = object(item.counts);
  const counts: DemoDatasetCreateCounts = {
    users: number(countsRaw.users, 'counts.users'),
    customers: number(countsRaw.customers, 'counts.customers'),
    products: number(countsRaw.products, 'counts.products'),
    jobCards: number(countsRaw.jobCards, 'counts.jobCards'),
  };
  for (const [k, v] of Object.entries(counts)) {
    if (!Number.isInteger(v) || v < 0) invalid(`counts.${k}`);
  }
  const replayed = boolean(item.replayed, 'replayed');
  return { dataset, counts, replayed };
}

export async function createDemoDataset(input: DemoDatasetCreateRequest): Promise<DemoDatasetCreateResponse> {
  return parseDemoDatasetCreateResponse(await request('/api/admin/demo-datasets', json('POST', input)));
}
