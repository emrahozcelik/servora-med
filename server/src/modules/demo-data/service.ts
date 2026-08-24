import { createHash } from 'node:crypto';

import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type {
  DemoDatasetBlocker,
  DemoDatasetDto,
  DemoDatasetImpactCounts,
  DemoDatasetPreviewData,
  DemoDatasetPreviewDto,
  DemoDatasetRepository,
} from './types.js';

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const notFound = () => new AppError('DEMO_DATASET_NOT_FOUND', 404, 'Demo veri kümesi bulunamadı.');

function requireAdmin(actor: Pick<SafeUser, 'role'>) {
  if (actor.role !== 'ADMIN') throw forbidden();
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapDataset(dataset: DemoDatasetPreviewData['dataset']): DemoDatasetDto {
  return {
    id: dataset.id,
    organizationId: dataset.organizationId,
    datasetKey: dataset.datasetKey,
    seedVersion: dataset.seedVersion,
    status: dataset.status,
    createdAt: dataset.createdAt.toISOString(),
    createdBy: dataset.createdBy,
    purgedAt: dataset.purgedAt?.toISOString() ?? null,
  };
}

function stableBlockers(blockers: readonly DemoDatasetBlocker[]) {
  return blockers
    .map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      sourceType: blocker.sourceType,
      sourceId: blocker.sourceId,
      relatedType: blocker.relatedType,
      relatedId: blocker.relatedId,
    }))
    .sort((left, right) =>
      compareText(left.code, right.code)
      || compareText(left.sourceType, right.sourceType)
      || compareText(left.sourceId, right.sourceId)
      || compareText(left.relatedType ?? '', right.relatedType ?? '')
      || compareText(left.relatedId ?? '', right.relatedId ?? '')
      || compareText(left.message, right.message));
}

function canonicalCounts(counts: DemoDatasetImpactCounts): DemoDatasetImpactCounts {
  return {
    users: counts.users,
    staffProfiles: counts.staffProfiles,
    customers: counts.customers,
    contacts: counts.contacts,
    products: counts.products,
    jobCards: counts.jobCards,
    deliveryItems: counts.deliveryItems,
    notes: counts.notes,
    confidentialNotes: counts.confidentialNotes,
    activities: counts.activities,
    followUps: counts.followUps,
    calendarEvents: counts.calendarEvents,
    conversations: counts.conversations,
    messages: counts.messages,
    notifications: counts.notifications,
    reminders: counts.reminders,
    realtimeEvents: counts.realtimeEvents,
  };
}

function planHash(data: DemoDatasetPreviewData, blockers: readonly DemoDatasetBlocker[]) {
  const canonical = {
    dataset: {
      id: data.dataset.id,
      organizationId: data.dataset.organizationId,
      datasetKey: data.dataset.datasetKey,
      seedVersion: data.dataset.seedVersion,
      status: data.dataset.status,
    },
    affectedCounts: canonicalCounts(data.affectedCounts),
    planKeys: [...new Set(data.planKeys)].sort(compareText),
    blockers,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function previewDto(data: DemoDatasetPreviewData): DemoDatasetPreviewDto {
  const blockers = stableBlockers(data.blockers);
  const statusBlocker = data.dataset.status === 'ACTIVE' ? [] : [{
    code: 'DATASET_NOT_ACTIVE',
    message: 'Yalnızca aktif demo veri kümeleri ileride silme adayı olabilir.',
    sourceType: 'DEMO_DATASET',
    sourceId: data.dataset.id,
    relatedType: null,
    relatedId: null,
  } satisfies DemoDatasetBlocker];
  const allBlockers = stableBlockers([...blockers, ...statusBlocker]);
  return {
    dataset: mapDataset(data.dataset),
    organization: { id: data.dataset.organizationId, name: data.organizationName },
    affectedCounts: data.affectedCounts,
    blockers: allBlockers,
    safeToPurge: allBlockers.length === 0,
    planHash: planHash(data, allBlockers),
  };
}

export class DemoDatasetService {
  constructor(private readonly repository: DemoDatasetRepository) {}

  async list(actor: SafeUser): Promise<readonly DemoDatasetDto[]> {
    requireAdmin(actor);
    const datasets = await this.repository.listDatasets(actor.organizationId);
    return datasets.map(mapDataset);
  }

  async inspect(actor: SafeUser, datasetId: string): Promise<DemoDatasetDto> {
    requireAdmin(actor);
    const dataset = await this.repository.findDataset(actor.organizationId, datasetId);
    if (!dataset) throw notFound();
    return mapDataset(dataset);
  }

  async preview(actor: SafeUser, datasetId: string): Promise<DemoDatasetPreviewDto> {
    requireAdmin(actor);
    const data = await this.repository.getPreviewData(actor.organizationId, datasetId);
    if (!data) throw notFound();
    return previewDto(data);
  }
}
