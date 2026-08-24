import { createHash } from 'node:crypto';

import type {
  DemoDatasetBlocker,
  DemoDatasetImpactCounts,
  DemoDatasetPreviewData,
} from './types.js';

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalBlockers(blockers: readonly DemoDatasetBlocker[]) {
  return blockers
    .map(({ message: _message, ...blocker }) => blocker)
    .sort((left, right) =>
      compareText(left.code, right.code)
      || compareText(left.sourceType, right.sourceType)
      || compareText(left.sourceId, right.sourceId)
      || compareText(left.relatedType ?? '', right.relatedType ?? '')
      || compareText(left.relatedId ?? '', right.relatedId ?? ''));
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

function canonicalPlan(data: DemoDatasetPreviewData) {
  if (!data.purgePlan) {
    return {
      schemaVersion: 1,
      planKeys: [...new Set(data.planKeys)].sort(compareText),
    };
  }

  const plan = data.purgePlan;
  return {
    schemaVersion: plan.schemaVersion,
    organizationId: plan.organizationId,
    datasetId: plan.datasetId,
    users: [...plan.users].sort(compareText),
    staffProfiles: [...plan.staffProfiles].sort(compareText),
    customers: [...plan.customers].sort(compareText),
    contacts: [...plan.contacts].sort(compareText),
    products: [...plan.products].sort(compareText),
    jobCards: [...plan.jobCards].sort(compareText),
    jobCardDeleteOrder: [...plan.jobCardDeleteOrder],
    deliveryItems: [...plan.deliveryItems].sort(compareText),
    jobNotes: [...plan.jobNotes].sort(compareText),
    meetingDetails: [...plan.meetingDetails].sort(compareText),
    jobActivities: [...plan.jobActivities].sort(compareText),
    jobActionLocations: [...plan.jobActionLocations].sort(compareText),
    confidentialNotes: [...plan.confidentialNotes].sort(compareText),
    calendarEvents: [...plan.calendarEvents].sort(compareText),
    calendarActivities: [...plan.calendarActivities].sort(compareText),
    reminders: [...plan.reminders].sort(compareText),
    conversations: [...plan.conversations].sort(compareText),
    messages: [...plan.messages].sort(compareText),
    conversationParticipants: [...plan.conversationParticipants]
      .map((item) => ({ ...item }))
      .sort((left, right) =>
        compareText(left.conversationId, right.conversationId)
        || compareText(left.userId, right.userId)),
    conversationUserStates: [...plan.conversationUserStates]
      .map((item) => ({ ...item }))
      .sort((left, right) =>
        compareText(left.conversationId, right.conversationId)
        || compareText(left.userId, right.userId)),
    messagingActivities: [...plan.messagingActivities].sort(compareText),
    realtimeEvents: [...plan.realtimeEvents].sort(compareText),
    notifications: [...plan.notifications].sort(compareText),
    webPushSubscriptions: [...plan.webPushSubscriptions].sort(compareText),
    webPushDeliveries: [...plan.webPushDeliveries].sort(compareText),
    sessions: [...plan.sessions].sort(compareText),
    processedActions: [...plan.processedActions].sort(compareText),
    semanticallyRelevantEdges: [...plan.semanticallyRelevantEdges].sort(compareText),
    retainedAuditActorLinks: [...plan.retainedAuditActorLinks]
      .map((link) => ({ ...link }))
      .sort((left, right) =>
        compareText(left.auditEventId, right.auditEventId)
        || compareText(left.actorUserId, right.actorUserId)),
    datasetCreatorUserId: plan.datasetCreatorUserId,
  };
}

export function demoDatasetPlanHash(
  data: DemoDatasetPreviewData,
  blockers: readonly DemoDatasetBlocker[],
) {
  const canonical = {
    planSchemaVersion: data.purgePlan?.schemaVersion ?? 1,
    dataset: {
      id: data.dataset.id,
      organizationId: data.dataset.organizationId,
      datasetKey: data.dataset.datasetKey,
      seedVersion: data.dataset.seedVersion,
      status: data.dataset.status,
    },
    affectedCounts: canonicalCounts(data.affectedCounts),
    plan: canonicalPlan(data),
    blockers: canonicalBlockers(blockers),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
