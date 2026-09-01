import type { PoolClient, QueryResultRow } from 'pg';

import type {
  DemoDatasetBlocker,
  DemoDatasetConversationParticipant,
  DemoDatasetConversationUserState,
  DemoDatasetImpactCounts,
  DemoDatasetPurgePlan,
  DemoDatasetRecord,
  DemoDatasetRetainedActorLink,
  DemoDatasetPreviewData,
} from './types.js';
import { DEMO_DATASET_PURGE_PLAN_SCHEMA_VERSION } from './types.js';

type DatasetRow = {
  id: string;
  organization_id: string;
  dataset_key: string;
  seed_version: string;
  status: 'ACTIVE' | 'PURGED';
  created_at: Date;
  created_by: string | null;
  created_by_user_id_snapshot: string | null;
  purged_at: Date | null;
  organization_name: string;
};

type OwnershipRow = {
  id: string;
  organization_id: string;
  data_class: 'BUSINESS' | 'DEMO';
  demo_dataset_id: string | null;
};

type UserRow = OwnershipRow;
type CustomerRow = OwnershipRow & { assigned_staff_user_id: string | null };
type ProductRow = OwnershipRow;

type JobRow = OwnershipRow & {
  assigned_to: string | null;
  created_by: string | null;
  accepted_by: string | null;
  staff_completed_by: string | null;
  manager_approved_by: string | null;
  revision_requested_by: string | null;
  cancelled_by: string | null;
  follow_up_proposed_assignee: string | null;
  follow_up_proposed_by: string | null;
  source_job_card_id: string | null;
  customer_id: string | null;
  contact_id: string | null;
};

type StaffProfileRow = {
  id: string;
  organization_id: string;
  user_id: string;
  manager_user_id: string | null;
};

type ContactRow = {
  id: string;
  organization_id: string;
  customer_id: string;
};

type DeliveryRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  product_id: string;
};

type ActivityRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  actor_id: string | null;
};

type NoteRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  author_id: string;
};

type MeetingRow = { job_card_id: string; organization_id: string };
type LocationRow = { id: string; organization_id: string; job_card_id: string; activity_id: string };

type ConfidentialNoteRow = {
  id: string;
  organization_id: string;
  staff_user_id: string;
  author_user_id: string;
};

type CalendarEventRow = OwnershipRow & {
  assigned_user_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  cancelled_by: string | null;
};

type CalendarActivityRow = {
  id: string;
  organization_id: string;
  calendar_event_id: string;
  actor_user_id: string | null;
};

type ReminderRow = {
  id: string;
  organization_id: string;
  job_card_id: string | null;
  calendar_event_id: string | null;
  recipient_user_id: string;
  state: string;
};

type ConversationRow = OwnershipRow & {
  job_id: string | null;
  customer_id: string | null;
};

type MessageRow = { id: string; organization_id: string; conversation_id: string; sender_user_id: string };
type ParticipantRow = DemoDatasetConversationParticipant & { organization_id: string };
type UserStateRow = DemoDatasetConversationUserState & { organization_id: string };
type MessagingActivityRow = { id: string; organization_id: string; conversation_id: string; actor_user_id: string };

type RealtimeRow = {
  id: string;
  organization_id: string;
  source_activity_id: string | null;
  calendar_activity_id: string | null;
  calendar_reminder_id: string | null;
  messaging_activity_id: string | null;
  staff_note_id: string | null;
  actor_user_id: string | null;
  audience_user_ids: string[];
  entity_type: string;
  entity_id: string;
};

type NotificationRow = {
  id: string;
  organization_id: string;
  recipient_user_id: string;
  source_realtime_event_id: string;
};

type PushSubscriptionRow = { id: string; organization_id: string; recipient_user_id: string };
type PushDeliveryRow = {
  id: string;
  organization_id: string;
  notification_id: string;
  subscription_id: string;
  state: string;
};
type AuditLinkRow = { id: string; actor_user_id: string };
type IdRow = { id: string };

type QueryClient = Pick<PoolClient, 'query'>;

const DATASET_COLUMNS = `d.id, d.organization_id, d.dataset_key, d.seed_version,
  d.status, d.created_at, d.created_by, d.created_by_user_id_snapshot,
  d.purged_at, o.name AS organization_name`;

const DATASET_FROM = `
  FROM demo_datasets d
  JOIN organizations o ON o.id = d.organization_id`;

async function rows<T extends QueryResultRow>(client: QueryClient, sql: string, values: unknown[]): Promise<T[]> {
  return (await client.query<T>(sql, values)).rows;
}

function mapDataset(row: DatasetRow): DemoDatasetRecord {
  if (row.status !== 'ACTIVE'
    || row.created_by === null
    || row.created_by_user_id_snapshot !== null
    || row.purged_at !== null) {
    throw new Error('demo dataset row is not an active disposable dataset');
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    datasetKey: row.dataset_key,
    seedVersion: row.seed_version,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function owned(row: OwnershipRow, organizationId: string, datasetId: string) {
  return row.organization_id === organizationId
    && row.data_class === 'DEMO'
    && row.demo_dataset_id === datasetId;
}

function isBusiness(row: OwnershipRow) {
  return row.data_class === 'BUSINESS';
}

function setOf(values: readonly string[]) {
  return new Set(values);
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function ownerCode(row: OwnershipRow, businessCode: string) {
  return isBusiness(row) ? businessCode : 'CROSS_DATASET_EDGE';
}

function userOwnerCode(
  userById: ReadonlyMap<string, UserRow>,
  organizationId: string,
  userId: string,
  businessCode: string,
) {
  return ownerCode(userById.get(userId) ?? {
    id: userId,
    organization_id: organizationId,
    data_class: 'BUSINESS',
    demo_dataset_id: null,
  }, businessCode);
}

function addBlocker(
  blockers: DemoDatasetBlocker[],
  blocker: DemoDatasetBlocker,
) {
  const key = [
    blocker.code,
    blocker.sourceType,
    blocker.sourceId,
    blocker.relatedType ?? '',
    blocker.relatedId ?? '',
  ].join('|');
  if (!blockers.some((item) => [
    item.code,
    item.sourceType,
    item.sourceId,
    item.relatedType ?? '',
    item.relatedId ?? '',
  ].join('|') === key)) blockers.push(blocker);
}

function edgeBlocker(
  blockers: DemoDatasetBlocker[],
  code: string,
  message: string,
  sourceType: string,
  sourceId: string,
  relatedType: string | null,
  relatedId: string | null,
) {
  addBlocker(blockers, { code, message, sourceType, sourceId, relatedType, relatedId });
}

function userRefs(row: JobRow) {
  return [
    ['assigned_to', row.assigned_to],
    ['created_by', row.created_by],
    ['accepted_by', row.accepted_by],
    ['staff_completed_by', row.staff_completed_by],
    ['manager_approved_by', row.manager_approved_by],
    ['revision_requested_by', row.revision_requested_by],
    ['cancelled_by', row.cancelled_by],
    ['follow_up_proposed_assignee', row.follow_up_proposed_assignee],
    ['follow_up_proposed_by', row.follow_up_proposed_by],
  ] as const;
}

function eventUserRefs(row: CalendarEventRow) {
  return [
    ['assigned_user_id', row.assigned_user_id],
    ['created_by', row.created_by],
    ['updated_by', row.updated_by],
    ['cancelled_by', row.cancelled_by],
  ] as const;
}

function mapCounts(input: {
  users: readonly string[];
  staffProfiles: readonly string[];
  customers: readonly string[];
  contacts: readonly string[];
  products: readonly string[];
  jobCards: readonly string[];
  deliveryItems: readonly string[];
  jobNotes: readonly string[];
  confidentialNotes: readonly string[];
  jobActivities: readonly string[];
  calendarActivities: readonly string[];
  followUps: number;
  calendarEvents: readonly string[];
  conversations: readonly string[];
  messages: readonly string[];
  notifications: readonly string[];
  reminders: readonly string[];
  realtimeEvents: readonly string[];
  messagingActivities: readonly string[];
}): DemoDatasetImpactCounts {
  return {
    users: input.users.length,
    staffProfiles: input.staffProfiles.length,
    customers: input.customers.length,
    contacts: input.contacts.length,
    products: input.products.length,
    jobCards: input.jobCards.length,
    deliveryItems: input.deliveryItems.length,
    notes: input.jobNotes.length,
    confidentialNotes: input.confidentialNotes.length,
    activities: input.jobActivities.length + input.calendarActivities.length + input.messagingActivities.length,
    followUps: input.followUps,
    calendarEvents: input.calendarEvents.length,
    conversations: input.conversations.length,
    messages: input.messages.length,
    notifications: input.notifications.length,
    reminders: input.reminders.length,
    realtimeEvents: input.realtimeEvents.length,
  };
}

function deleteOrder(jobRows: readonly JobRow[], jobIds: readonly string[]) {
  const ids = setOf(jobIds);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const calculate = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const row = jobRows.find((item) => item.id === id);
    const parent = row?.source_job_card_id;
    const value = parent && ids.has(parent) ? calculate(parent) + 1 : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const id of jobIds) calculate(id);
  return [...jobIds].sort((left, right) =>
    (depth.get(right) ?? 0) - (depth.get(left) ?? 0) || left.localeCompare(right));
}

function planKeys(plan: DemoDatasetPurgePlan) {
  return [
    ...plan.users.map((id) => `USER:${id}`),
    ...plan.staffProfiles.map((id) => `STAFF_PROFILE:${id}`),
    ...plan.customers.map((id) => `CUSTOMER:${id}`),
    ...plan.contacts.map((id) => `CONTACT:${id}`),
    ...plan.products.map((id) => `PRODUCT:${id}`),
    ...plan.jobCards.map((id) => `JOB_CARD:${id}`),
    ...plan.deliveryItems.map((id) => `DELIVERY_ITEM:${id}`),
    ...plan.jobNotes.map((id) => `JOB_NOTE:${id}`),
    ...plan.meetingDetails.map((id) => `MEETING_DETAILS:${id}`),
    ...plan.jobActivities.map((id) => `JOB_ACTIVITY:${id}`),
    ...plan.jobActionLocations.map((id) => `JOB_ACTION_LOCATION:${id}`),
    ...plan.confidentialNotes.map((id) => `STAFF_CONFIDENTIAL_NOTE:${id}`),
    ...plan.calendarEvents.map((id) => `CALENDAR_EVENT:${id}`),
    ...plan.calendarActivities.map((id) => `CALENDAR_EVENT_ACTIVITY:${id}`),
    ...plan.reminders.map((id) => `CALENDAR_REMINDER:${id}`),
    ...plan.conversations.map((id) => `CONVERSATION:${id}`),
    ...plan.messages.map((id) => `MESSAGE:${id}`),
    ...plan.conversationParticipants.map((item) => `CONVERSATION_PARTICIPANT:${item.conversationId}:${item.userId}`),
    ...plan.conversationUserStates.map((item) => `CONVERSATION_USER_STATE:${item.conversationId}:${item.userId}`),
    ...plan.messagingActivities.map((id) => `MESSAGING_ACTIVITY:${id}`),
    ...plan.realtimeEvents.map((id) => `REALTIME_EVENT:${id}`),
    ...plan.notifications.map((id) => `IN_APP_NOTIFICATION:${id}`),
    ...plan.webPushSubscriptions.map((id) => `WEB_PUSH_SUBSCRIPTION:${id}`),
    ...plan.webPushDeliveries.map((id) => `WEB_PUSH_DELIVERY:${id}`),
    ...plan.sessions.map((id) => `SESSION:${id}`),
    ...plan.processedActions.map((id) => `PROCESSED_ACTION:${id}`),
    ...plan.retainedAuditActorLinks.map((item) => `AUDIT_ACTOR:${item.auditEventId}:${item.actorUserId}`),
    ...(plan.datasetCreatorUserId ? [`DATASET_CREATOR:${plan.datasetCreatorUserId}`] : []),
  ];
}

export type DemoDatasetAnalysis = DemoDatasetPreviewData & { purgePlan: DemoDatasetPurgePlan };

export class DemoDatasetImpactAnalyzer {
  constructor(private readonly client: QueryClient) {}

  async analyze(organizationId: string, datasetId: string): Promise<DemoDatasetAnalysis | null> {
    const datasetRows = await rows<DatasetRow>(this.client, `
      SELECT ${DATASET_COLUMNS}
      ${DATASET_FROM}
      WHERE d.organization_id = $1 AND d.id = $2 AND d.status = 'ACTIVE'`, [organizationId, datasetId]);
    const datasetRow = datasetRows[0];
    if (!datasetRow) return null;
    const dataset = mapDataset(datasetRow);

    const users = await rows<UserRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id
      FROM users
      WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
      ORDER BY id`, [organizationId, datasetId]);
    const customers = await rows<CustomerRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id, assigned_staff_user_id
      FROM customers
      WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
      ORDER BY id`, [organizationId, datasetId]);
    const products = await rows<ProductRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id
      FROM products
      WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
      ORDER BY id`, [organizationId, datasetId]);
    const jobs = await rows<JobRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_to, created_by, accepted_by, staff_completed_by,
        manager_approved_by, revision_requested_by, cancelled_by,
        follow_up_proposed_assignee, follow_up_proposed_by,
        source_job_card_id, customer_id, contact_id
      FROM job_cards
      WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
      ORDER BY id`, [organizationId, datasetId]);
    const events = await rows<CalendarEventRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_user_id, created_by, updated_by, cancelled_by
      FROM calendar_events
      WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
      ORDER BY id`, [organizationId, datasetId]);
    const conversations = await rows<ConversationRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id, job_id, customer_id
      FROM conversations
      WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
      ORDER BY id`, [organizationId, datasetId]);

    const userIds = users.map((row) => row.id);
    const customerIds = customers.map((row) => row.id);
    const productIds = products.map((row) => row.id);
    const jobIds = jobs.map((row) => row.id);
    const eventIds = events.map((row) => row.id);
    const conversationIds = conversations.map((row) => row.id);
    const userSet = setOf(userIds);
    const customerSet = setOf(customerIds);
    const productSet = setOf(productIds);
    const jobSet = setOf(jobIds);
    const eventSet = setOf(eventIds);
    const conversationSet = setOf(conversationIds);

    const allUsers = await rows<UserRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id
      FROM users WHERE organization_id = $1`, [organizationId]);
    const userById = new Map(allUsers.map((row) => [row.id, row]));

    const staffProfilesEdge = await rows<StaffProfileRow>(this.client, `
      SELECT id, organization_id, user_id, manager_user_id
      FROM staff_profiles
      WHERE organization_id = $1
        AND (user_id = ANY($2::uuid[]) OR manager_user_id = ANY($2::uuid[]))`,
    [organizationId, userIds]);
    const staffProfiles = staffProfilesEdge
      .filter((row) => userSet.has(row.user_id))
      .map((row) => row.id);

    const jobContactIds = jobs.flatMap((row) => row.contact_id ? [row.contact_id] : []);
    const jobParentIds = jobs.flatMap((row) => row.source_job_card_id ? [row.source_job_card_id] : []);
    const jobCustomerRefs = jobs.flatMap((row) => row.customer_id ? [row.customer_id] : []);
    const contactsEdge = await rows<ContactRow>(this.client, `
      SELECT id, organization_id, customer_id
      FROM contacts
      WHERE organization_id = $1
        AND (customer_id = ANY($2::uuid[]) OR id = ANY($3::uuid[]))`,
    [organizationId, customerIds, jobContactIds]);
    const contacts = contactsEdge.filter((row) => customerSet.has(row.customer_id)).map((row) => row.id);

    const allJobsEdge = await rows<JobRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_to, created_by, accepted_by, staff_completed_by,
        manager_approved_by, revision_requested_by, cancelled_by,
        follow_up_proposed_assignee, follow_up_proposed_by,
        source_job_card_id, customer_id, contact_id
      FROM job_cards
      WHERE organization_id = $1
        AND (
          id = ANY($2::uuid[])
          OR id = ANY($6::uuid[])
          OR customer_id = ANY($3::uuid[])
          OR source_job_card_id = ANY($2::uuid[])
          OR contact_id = ANY($4::uuid[])
          OR assigned_to = ANY($5::uuid[])
          OR created_by = ANY($5::uuid[])
          OR accepted_by = ANY($5::uuid[])
          OR staff_completed_by = ANY($5::uuid[])
          OR manager_approved_by = ANY($5::uuid[])
          OR revision_requested_by = ANY($5::uuid[])
          OR cancelled_by = ANY($5::uuid[])
          OR follow_up_proposed_assignee = ANY($5::uuid[])
          OR follow_up_proposed_by = ANY($5::uuid[])
        )`,
    [organizationId, jobIds, jobCustomerRefs, contacts, userIds, jobParentIds]);
    const allJobById = new Map(allJobsEdge.map((row) => [row.id, row]));
    // Ensure BUSINESS jobs referencing DEMO customers/contacts are included for blocker detection
    // (isolated BUSINESS job with DEMO customer would otherwise be missed)
    const extraBusinessJobCustomerIds = customerIds;
    if (extraBusinessJobCustomerIds.length > 0) {
      const extraJobsByCustomer = await rows<JobRow>(this.client, `
        SELECT id, organization_id, data_class, demo_dataset_id,
          assigned_to, created_by, accepted_by, staff_completed_by,
          manager_approved_by, revision_requested_by, cancelled_by,
          follow_up_proposed_assignee, follow_up_proposed_by,
          source_job_card_id, customer_id, contact_id
        FROM job_cards
        WHERE organization_id = $1
          AND customer_id = ANY($2::uuid[])
          AND NOT (id = ANY($3::uuid[]))`,
        [organizationId, extraBusinessJobCustomerIds, [...allJobById.keys()]]);
      for (const job of extraJobsByCustomer) {
        if (!allJobById.has(job.id)) {
          allJobById.set(job.id, job);
          allJobsEdge.push(job);
        }
      }
    }
    const extraBusinessJobContactIds = contactsEdge.map((r) => r.id);
    // Also catch BUSINESS jobs referencing DEMO contacts (via contact_id)
    if (extraBusinessJobContactIds.length > 0 || customerIds.length > 0) {
      // contactsEdge already filtered to demo customers, so any contact there is demo-related
      const demoContactIds = contactsEdge.filter((r) => customerSet.has(r.customer_id)).map((r) => r.id);
      if (demoContactIds.length > 0) {
        const extraJobsByContact = await rows<JobRow>(this.client, `
          SELECT id, organization_id, data_class, demo_dataset_id,
            assigned_to, created_by, accepted_by, staff_completed_by,
            manager_approved_by, revision_requested_by, cancelled_by,
            follow_up_proposed_assignee, follow_up_proposed_by,
            source_job_card_id, customer_id, contact_id
          FROM job_cards
          WHERE organization_id = $1
            AND contact_id = ANY($2::uuid[])
            AND NOT (id = ANY($3::uuid[]))`,
          [organizationId, demoContactIds, [...allJobById.keys()]]);
        for (const job of extraJobsByContact) {
          if (!allJobById.has(job.id)) {
            allJobById.set(job.id, job);
            allJobsEdge.push(job);
          }
        }
      }
    }

    const customersEdge = await rows<CustomerRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id, assigned_staff_user_id
      FROM customers
      WHERE organization_id = $1
        AND (
          id = ANY($2::uuid[])
          OR id = ANY($3::uuid[])
          OR id = ANY($4::uuid[])
          OR assigned_staff_user_id = ANY($5::uuid[])
        )`,
    [organizationId, customerIds, jobCustomerRefs,
      contactsEdge.map((row) => row.customer_id), userIds]);

    // Effective DEMO ownership: legacy misclassified follow-ups (persisted as
    // BUSINESS with demo_dataset_id NULL before the forward provenance fix) are
    // DEMO-derived when deterministic graph lineage proves their source chain
    // leads to a JobCard owned by this dataset. Classification is follow-up
    // lineage bound — a row is never classified by customer/assignee/title/
    // timestamp proximity alone.
    //
    // Computed here, before any job-scoped artifact fetch, so every subsequent
    // job-scoped query (deliveries, activities, notes, conversations,
    // reminders) can key on the lineage-expanded set instead of the seed
    // jobIds. Otherwise BUSINESS-staff authored artifacts on a derived
    // follow-up fall outside the plan and trigger FK 23503 at purge time.
    const effectiveDemoJobIds = new Set<string>();
    const jobByIdForEffective = new Map(allJobsEdge.map((row) => [row.id, row]));
    for (const job of allJobsEdge) {
      if (owned(job, organizationId, datasetId)) effectiveDemoJobIds.add(job.id);
    }
    let lineageChanged = true;
    while (lineageChanged) {
      lineageChanged = false;
      for (const job of allJobsEdge) {
        if (effectiveDemoJobIds.has(job.id)) continue;
        if (job.organization_id !== organizationId) continue;
        if (!job.source_job_card_id) continue;
        const source = jobByIdForEffective.get(job.source_job_card_id);
        if (!source || !effectiveDemoJobIds.has(source.id)) continue;
        // Transitive deterministic lineage; cycles simply make no progress.
        effectiveDemoJobIds.add(job.id);
        lineageChanged = true;
      }
    }
    const effectiveJobIdArr = [...effectiveDemoJobIds].sort();
    const effectiveJobSet = setOf(effectiveJobIdArr);

    const deliveriesEdge = await rows<DeliveryRow>(this.client, `
      SELECT di.id, di.organization_id, di.job_card_id, di.product_id
      FROM job_card_delivery_items di
      WHERE di.organization_id = $1
        AND (di.job_card_id = ANY($2::uuid[]) OR di.product_id = ANY($3::uuid[]))`,
    [organizationId, effectiveJobIdArr, productIds]);
    const deliveryJobRefs = deliveriesEdge.map((row) => row.job_card_id);
    const deliveryJobs = await rows<JobRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_to, created_by, accepted_by, staff_completed_by,
        manager_approved_by, revision_requested_by, cancelled_by,
        follow_up_proposed_assignee, follow_up_proposed_by,
        source_job_card_id, customer_id, contact_id
      FROM job_cards WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, deliveryJobRefs]);
    for (const job of deliveryJobs) {
      if (!allJobById.has(job.id)) {
        allJobById.set(job.id, job);
        allJobsEdge.push(job);
      }
    }

    const deliveryItems = deliveriesEdge
      .filter((row) => effectiveJobSet.has(row.job_card_id))
      .map((row) => row.id);

    const jobActivitiesEdge = await rows<ActivityRow>(this.client, `
      SELECT id, organization_id, job_card_id, actor_id
      FROM job_card_activity_logs
      WHERE organization_id = $1
        AND (job_card_id = ANY($2::uuid[]) OR actor_id = ANY($3::uuid[]))
      ORDER BY id`, [organizationId, effectiveJobIdArr, userIds]);
    const jobActivities = jobActivitiesEdge.filter((row) => effectiveJobSet.has(row.job_card_id));
    const jobActivityIds = jobActivities.map((row) => row.id);
    const jobNotesEdge = await rows<NoteRow>(this.client, `
      SELECT id, organization_id, job_card_id, author_id
      FROM job_card_notes
      WHERE organization_id = $1
        AND (job_card_id = ANY($2::uuid[]) OR author_id = ANY($3::uuid[]))
      ORDER BY id`, [organizationId, effectiveJobIdArr, userIds]);
    const jobNotes = jobNotesEdge.filter((row) => effectiveJobSet.has(row.job_card_id));
    const activityAndNoteJobRefs = [
      ...jobActivitiesEdge.map((row) => row.job_card_id),
      ...jobNotesEdge.map((row) => row.job_card_id),
    ];
    const activityAndNoteJobs = await rows<JobRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_to, created_by, accepted_by, staff_completed_by,
        manager_approved_by, revision_requested_by, cancelled_by,
        follow_up_proposed_assignee, follow_up_proposed_by,
        source_job_card_id, customer_id, contact_id
      FROM job_cards WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, activityAndNoteJobRefs]);
    for (const job of activityAndNoteJobs) {
      if (!allJobById.has(job.id)) {
        allJobById.set(job.id, job);
        allJobsEdge.push(job);
      }
    }
    const meetingDetails = await rows<MeetingRow>(this.client, `
      SELECT job_card_id, organization_id
      FROM job_card_meeting_details
      WHERE organization_id = $1 AND job_card_id = ANY($2::uuid[])`, [organizationId, effectiveJobIdArr]);
    const jobActionLocations = await rows<LocationRow>(this.client, `
      SELECT id, organization_id, job_card_id, activity_id
      FROM job_action_locations
      WHERE organization_id = $1 AND job_card_id = ANY($2::uuid[])`, [organizationId, effectiveJobIdArr]);

    const confidentialNotesEdge = await rows<ConfidentialNoteRow>(this.client, `
      SELECT id, organization_id, staff_user_id, author_user_id
      FROM staff_confidential_notes
      WHERE organization_id = $1
        AND (staff_user_id = ANY($2::uuid[]) OR author_user_id = ANY($2::uuid[]))`,
    [organizationId, userIds]);
    const confidentialNotes = confidentialNotesEdge
      .filter((row) => userSet.has(row.staff_user_id))
      .map((row) => row.id);

    const allEventsEdge = await rows<CalendarEventRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_user_id, created_by, updated_by, cancelled_by
      FROM calendar_events
      WHERE organization_id = $1
        AND (
          id = ANY($2::uuid[])
          OR assigned_user_id = ANY($3::uuid[])
          OR created_by = ANY($3::uuid[])
          OR updated_by = ANY($3::uuid[])
          OR cancelled_by = ANY($3::uuid[])
        )`, [organizationId, eventIds, userIds]);
    const allEventById = new Map(allEventsEdge.map((row) => [row.id, row]));
    const calendarActivitiesEdge = await rows<CalendarActivityRow>(this.client, `
      SELECT id, organization_id, calendar_event_id, actor_user_id
      FROM calendar_event_activity_logs
      WHERE organization_id = $1
        AND (calendar_event_id = ANY($2::uuid[]) OR actor_user_id = ANY($3::uuid[]))`,
    [organizationId, eventIds, userIds]);
    const calendarActivities = calendarActivitiesEdge
      .filter((row) => eventSet.has(row.calendar_event_id))
      .map((row) => row.id);
    const activityEventRefs = calendarActivitiesEdge.map((row) => row.calendar_event_id);
    const activityEvents = await rows<CalendarEventRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_user_id, created_by, updated_by, cancelled_by
      FROM calendar_events WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, activityEventRefs]);
    for (const event of activityEvents) {
      if (!allEventById.has(event.id)) {
        allEventById.set(event.id, event);
        allEventsEdge.push(event);
      }
    }

    const candidateConversations = await rows<ConversationRow>(this.client, `
      SELECT c.id, c.organization_id, c.data_class, c.demo_dataset_id, c.job_id, c.customer_id
      FROM conversations c
      WHERE c.organization_id = $1
        AND (
          c.id = ANY($2::uuid[])
          OR c.job_id = ANY($3::uuid[])
          OR c.customer_id = ANY($4::uuid[])
          OR EXISTS (
            SELECT 1 FROM conversation_participants cp
            WHERE cp.organization_id = c.organization_id
              AND cp.conversation_id = c.id
              AND cp.user_id = ANY($5::uuid[])
          )
          OR EXISTS (
            SELECT 1 FROM messages m
            WHERE m.organization_id = c.organization_id
              AND m.conversation_id = c.id
              AND m.sender_user_id = ANY($5::uuid[])
          )
          OR EXISTS (
            SELECT 1 FROM messaging_activity_logs ma
            WHERE ma.organization_id = c.organization_id
              AND ma.conversation_id = c.id
              AND ma.actor_user_id = ANY($5::uuid[])
          )
          OR EXISTS (
            SELECT 1 FROM conversation_user_states cs
            WHERE cs.organization_id = c.organization_id
              AND cs.conversation_id = c.id
              AND cs.user_id = ANY($5::uuid[])
          )
        )`, [organizationId, conversationIds, effectiveJobIdArr, customerIds, userIds]);
    const candidateConversationIds = candidateConversations.map((row) => row.id);
    const conversationJobRefs = candidateConversations.flatMap((row) => row.job_id ? [row.job_id] : []);
    const conversationCustomerRefs = candidateConversations.flatMap((row) => row.customer_id ? [row.customer_id] : []);
    const conversationJobs = await rows<JobRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_to, created_by, accepted_by, staff_completed_by,
        manager_approved_by, revision_requested_by, cancelled_by,
        follow_up_proposed_assignee, follow_up_proposed_by,
        source_job_card_id, customer_id, contact_id
      FROM job_cards WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, conversationJobRefs]);
    for (const job of conversationJobs) {
      if (!allJobById.has(job.id)) {
        allJobById.set(job.id, job);
        allJobsEdge.push(job);
      }
    }
    const conversationCustomers = await rows<CustomerRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id, assigned_staff_user_id
      FROM customers WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, conversationCustomerRefs]);
    const knownCustomerIds = setOf(customersEdge.map((row) => row.id));
    for (const customer of conversationCustomers) {
      if (!knownCustomerIds.has(customer.id)) {
        knownCustomerIds.add(customer.id);
        customersEdge.push(customer);
      }
    }
    const messagesEdge = await rows<MessageRow>(this.client, `
      SELECT id, organization_id, conversation_id, sender_user_id
      FROM messages
      WHERE organization_id = $1 AND conversation_id = ANY($2::uuid[])`,
    [organizationId, candidateConversationIds]);
    const participantsEdge = await rows<ParticipantRow>(this.client, `
      SELECT organization_id, conversation_id AS "conversationId", user_id AS "userId"
      FROM conversation_participants
      WHERE organization_id = $1 AND conversation_id = ANY($2::uuid[])`,
    [organizationId, candidateConversationIds]);
    const userStatesEdge = await rows<UserStateRow>(this.client, `
      SELECT organization_id, conversation_id AS "conversationId", user_id AS "userId"
      FROM conversation_user_states
      WHERE organization_id = $1
        AND (conversation_id = ANY($2::uuid[]) OR user_id = ANY($3::uuid[]))`,
    [organizationId, candidateConversationIds, userIds]);
    const messagingActivitiesEdge = await rows<MessagingActivityRow>(this.client, `
      SELECT id, organization_id, conversation_id, actor_user_id
      FROM messaging_activity_logs
      WHERE organization_id = $1 AND conversation_id = ANY($2::uuid[])`,
    [organizationId, candidateConversationIds]);
    const targetMessages = messagesEdge.filter((row) => conversationSet.has(row.conversation_id));
    const targetParticipants = participantsEdge.filter((row) => conversationSet.has(row.conversationId));
    const targetUserStates = userStatesEdge.filter((row) => conversationSet.has(row.conversationId));
    const targetMessagingActivities = messagingActivitiesEdge.filter((row) => conversationSet.has(row.conversation_id));

    const reminderCandidates = await rows<ReminderRow>(this.client, `
      SELECT id, organization_id, job_card_id, calendar_event_id, recipient_user_id, state
      FROM calendar_reminders
      WHERE organization_id = $1
        AND (
          job_card_id = ANY($2::uuid[])
          OR calendar_event_id = ANY($3::uuid[])
          OR recipient_user_id = ANY($4::uuid[])
        )`, [organizationId, effectiveJobIdArr, eventIds, userIds]);
    const reminderJobRefs = reminderCandidates.flatMap((row) => row.job_card_id ? [row.job_card_id] : []);
    const reminderEventRefs = reminderCandidates.flatMap((row) => row.calendar_event_id ? [row.calendar_event_id] : []);
    const reminderJobs = await rows<JobRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_to, created_by, accepted_by, staff_completed_by,
        manager_approved_by, revision_requested_by, cancelled_by,
        follow_up_proposed_assignee, follow_up_proposed_by,
        source_job_card_id, customer_id, contact_id
      FROM job_cards WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, reminderJobRefs]);
    for (const job of reminderJobs) {
      if (!allJobById.has(job.id)) {
        allJobById.set(job.id, job);
        allJobsEdge.push(job);
      }
    }
    const reminderEvents = await rows<CalendarEventRow>(this.client, `
      SELECT id, organization_id, data_class, demo_dataset_id,
        assigned_user_id, created_by, updated_by, cancelled_by
      FROM calendar_events WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [organizationId, reminderEventRefs]);
    for (const event of reminderEvents) {
      if (!allEventById.has(event.id)) {
        allEventById.set(event.id, event);
        allEventsEdge.push(event);
      }
    }
    // Include any reminder touching the DEMO graph: DEMO source -> BUSINESS recipient and
    // BUSINESS source -> DEMO recipient are both purgeable derived artifacts (delete reminder, preserve BUSINESS root).
    const targetReminderRows = reminderCandidates;
    const targetReminderIds = targetReminderRows.map((row) => row.id);

    const targetSourceActivityIds = jobActivityIds;
    const targetCalendarActivityIds = calendarActivities;
    const targetMessagingActivityIds = targetMessagingActivities.map((row) => row.id);
    const targetStaffNoteIds = confidentialNotes;
    const targetReminderIdStrings = targetReminderIds;
    const realtimeRows = await rows<RealtimeRow>(this.client, `
      SELECT id::text, organization_id, source_activity_id, calendar_activity_id,
        calendar_reminder_id, messaging_activity_id, staff_note_id,
        actor_user_id, audience_user_ids, entity_type, entity_id
      FROM realtime_events
      WHERE organization_id = $1
        AND (
          source_activity_id = ANY($2::uuid[])
          OR calendar_activity_id = ANY($3::uuid[])
          OR calendar_reminder_id = ANY($4::uuid[])
          OR messaging_activity_id = ANY($5::uuid[])
          OR staff_note_id = ANY($6::uuid[])
        )`, [organizationId, targetSourceActivityIds, targetCalendarActivityIds,
      targetReminderIdStrings, targetMessagingActivityIds, targetStaffNoteIds]);
    const realtimeIds = realtimeRows.map((row) => row.id);

    const notificationsEdge = await rows<NotificationRow>(this.client, `
      SELECT id, organization_id, recipient_user_id, source_realtime_event_id::text
      FROM in_app_notifications
      WHERE organization_id = $1
        AND (source_realtime_event_id = ANY($2::bigint[]) OR recipient_user_id = ANY($3::uuid[]))`,
    [organizationId, realtimeIds, userIds]);
    // Include any notification touching the DEMO graph: DEMO realtime -> BUSINESS recipient and
    // BUSINESS realtime -> DEMO recipient are purgeable derived artifacts.
    const targetNotificationRows = notificationsEdge;
    const targetNotificationIds = targetNotificationRows.map((row) => row.id);

    const subscriptions = await rows<PushSubscriptionRow>(this.client, `
      SELECT id, organization_id, recipient_user_id
      FROM web_push_subscriptions
      WHERE organization_id = $1 AND recipient_user_id = ANY($2::uuid[])`,
    [organizationId, userIds]);
    const targetSubscriptionSet = setOf(subscriptions.map((row) => row.id));
    const subscriptionIds = subscriptions.map((row) => row.id);
    const deliveryCandidates = await rows<PushDeliveryRow>(this.client, `
      SELECT id, organization_id, notification_id, subscription_id, state
      FROM web_push_deliveries
      WHERE organization_id = $1
        AND (notification_id = ANY($2::uuid[]) OR subscription_id = ANY($3::uuid[]))`,
    [organizationId, targetNotificationIds, subscriptionIds]);
    // Any delivery touching the DEMO graph is purgeable: delete delivery, preserve BUSINESS subscription/notification.
    const targetDeliveryRows = deliveryCandidates;

    const sessions = await rows<IdRow>(this.client, `
      SELECT id FROM sessions WHERE user_id = ANY($1::uuid[])`, [userIds]);
    const processedActions = await rows<IdRow>(this.client, `
      SELECT id FROM processed_actions
      WHERE organization_id = $1 AND user_id = ANY($2::uuid[])`, [organizationId, userIds]);
    const auditLinks = await rows<AuditLinkRow>(this.client, `
      SELECT id, actor_user_id FROM audit_events
      WHERE organization_id = $1 AND actor_user_id = ANY($2::uuid[])
      ORDER BY id`, [organizationId, userIds]);

    const blockers: DemoDatasetBlocker[] = [];
    const ownershipMessage = 'Demo verisi hedef dışındaki bir köke bağlı.';

    for (const customer of customersEdge) {
      const assigned = customer.assigned_staff_user_id;
      if (assigned && userSet.has(assigned) && !owned(customer, organizationId, datasetId)) {
        edgeBlocker(blockers, ownerCode(customer, 'DEMO_USER_TO_BUSINESS_CUSTOMER'), ownershipMessage,
          'USER', assigned, 'CUSTOMER', customer.id);
      }
      // DEMO customer -> BUSINESS user is DEMO-owned referencing BUSINESS root: purgeable (delete DEMO customer, preserve BUSINESS user)
    }

    for (const profile of staffProfilesEdge) {
      const profileUserIsTarget = userSet.has(profile.user_id);
      const managerIsTarget = profile.manager_user_id ? userSet.has(profile.manager_user_id) : false;
      if (profileUserIsTarget && profile.manager_user_id && !managerIsTarget) {
        const manager = userById.get(profile.manager_user_id);
        if (manager && !isBusiness(manager)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, profile.manager_user_id,
            'DEMO_USER_TO_BUSINESS_STAFF_PROFILE'), ownershipMessage,
            'USER', profile.manager_user_id, 'STAFF_PROFILE', profile.id);
        }
      }
      if (!profileUserIsTarget && managerIsTarget) {
        edgeBlocker(blockers, userOwnerCode(userById, organizationId, profile.user_id,
          'BUSINESS_STAFF_PROFILE_TO_DEMO_USER'), ownershipMessage,
          'STAFF_PROFILE', profile.id, 'USER', profile.manager_user_id);
      }
    }

    for (const job of allJobsEdge) {
      const jobIsTarget = effectiveJobSet.has(job.id);
      for (const [role, userId] of userRefs(job)) {
        if (!userId) continue;
        if (userSet.has(userId) && !jobIsTarget) {
          edgeBlocker(blockers, ownerCode(job, 'DEMO_USER_TO_BUSINESS_JOB'), ownershipMessage,
            'USER', userId, 'JOB_CARD', job.id);
        }
        if (jobIsTarget && !userSet.has(userId)) {
          const relatedUser = userById.get(userId);
          // DEMO job -> BUSINESS user is purgeable; DEMO job -> other DEMO dataset user is CROSS_DATASET blocker
          if (relatedUser && !isBusiness(relatedUser)) {
            edgeBlocker(blockers, ownerCode(relatedUser, 'BUSINESS_USER_TO_DEMO_JOB'), ownershipMessage,
              'JOB_CARD', job.id, 'USER', userId);
          }
        }
        void role;
      }
      if (job.customer_id) {
        const customer = customersEdge.find((row) => row.id === job.customer_id);
        if (customer) {
          if (jobIsTarget && !owned(customer, organizationId, datasetId) && !isBusiness(customer)) {
            edgeBlocker(blockers, ownerCode(customer, 'BUSINESS_CUSTOMER_TO_DEMO_JOB'), ownershipMessage,
              'JOB_CARD', job.id, 'CUSTOMER', customer.id);
          }
          if (!jobIsTarget && owned(customer, organizationId, datasetId)) {
            edgeBlocker(blockers, ownerCode(job, 'DEMO_CUSTOMER_TO_BUSINESS_JOB'), ownershipMessage,
              'CUSTOMER', customer.id, 'JOB_CARD', job.id);
          }
        }
      }
      if (job.contact_id && contactsEdge.some((row) => row.id === job.contact_id)) {
        const contact = contactsEdge.find((row) => row.id === job.contact_id);
        if (contact) {
          const contactCustomer = customersEdge.find((row) => row.id === contact.customer_id);
          if (contactCustomer) {
            if (jobIsTarget && !owned(contactCustomer, organizationId, datasetId) && !isBusiness(contactCustomer)) {
              edgeBlocker(blockers, ownerCode(contactCustomer, 'DEMO_JOB_TO_BUSINESS_CONTACT'), ownershipMessage,
                'JOB_CARD', job.id, 'CONTACT', contact.id);
            }
            if (!jobIsTarget && owned(contactCustomer, organizationId, datasetId)) {
              edgeBlocker(blockers, ownerCode(job, 'BUSINESS_CONTACT_TO_DEMO_JOB'), ownershipMessage,
                'CONTACT', contact.id, 'JOB_CARD', job.id);
            }
          }
        }
      }
      if (job.source_job_card_id) {
        const source = allJobById.get(job.source_job_card_id);
        if (source) {
          if (jobIsTarget && !owned(source, organizationId, datasetId) && !isBusiness(source)) {
            edgeBlocker(blockers, ownerCode(source, 'DEMO_JOB_TO_BUSINESS_FOLLOW_UP'), ownershipMessage,
              'JOB_CARD', job.id, 'JOB_CARD', source.id);
          }
          if (!jobIsTarget && owned(source, organizationId, datasetId)) {
            edgeBlocker(blockers, ownerCode(job, 'BUSINESS_JOB_TO_DEMO_FOLLOW_UP'), ownershipMessage,
              'JOB_CARD', source.id, 'JOB_CARD', job.id);
          }
        }
      }
    }

    for (const delivery of deliveriesEdge) {
      const job = allJobById.get(delivery.job_card_id);
      const product = products.find((row) => row.id === delivery.product_id)
        ?? await rows<ProductRow>(this.client, `
          SELECT id, organization_id, data_class, demo_dataset_id
          FROM products WHERE organization_id = $1 AND id = $2`, [organizationId, delivery.product_id]).then((items) => items[0]);
      if (!job || !product) continue;
      if (productSet.has(product.id) && !effectiveJobSet.has(job.id)) {
        edgeBlocker(blockers, ownerCode(job, 'DEMO_PRODUCT_TO_BUSINESS_JOB'), ownershipMessage,
          'PRODUCT', product.id, 'JOB_CARD', job.id);
      }
      if (effectiveJobSet.has(job.id) && !productSet.has(product.id) && !isBusiness(product)) {
        edgeBlocker(blockers, ownerCode(product, 'BUSINESS_PRODUCT_TO_DEMO_JOB'), ownershipMessage,
          'JOB_CARD', job.id, 'PRODUCT', product.id);
      }
    }

    const jobSetForCycle = effectiveJobSet;
    for (const start of effectiveJobIdArr) {
      const seen = new Set<string>();
      let current: string | null = start;
      while (current && jobSetForCycle.has(current)) {
        if (seen.has(current)) {
          edgeBlocker(blockers, 'FOLLOW_UP_CYCLE', 'Follow-up JobCard grafında döngü var.',
            'JOB_CARD', start, 'JOB_CARD', current);
          break;
        }
        seen.add(current);
        current = allJobById.get(current)?.source_job_card_id ?? null;
      }
    }

    const activityIds = setOf(jobActivityIds);
    for (const activity of jobActivitiesEdge) {
      const job = allJobById.get(activity.job_card_id);
      if (!job || !activity.actor_id) continue;
      const jobIsTarget = effectiveJobSet.has(job.id);
      const actorIsTarget = userSet.has(activity.actor_id);
      if (jobIsTarget && !actorIsTarget) {
        const actor = userById.get(activity.actor_id);
        if (actor && !isBusiness(actor)) {
          edgeBlocker(blockers, ownerCode(actor, 'BUSINESS_JOB_ACTIVITY_TO_DEMO_USER'), ownershipMessage,
            'JOB_ACTIVITY', activity.id, 'USER', activity.actor_id);
        }
      }
      if (!jobIsTarget && actorIsTarget) {
        edgeBlocker(blockers, ownerCode(job, 'DEMO_USER_TO_BUSINESS_JOB_ACTIVITY'), ownershipMessage,
          'USER', activity.actor_id, 'JOB_ACTIVITY', activity.id);
      }
    }
    for (const note of jobNotesEdge) {
      const job = allJobById.get(note.job_card_id);
      if (!job) continue;
      const jobIsTarget = effectiveJobSet.has(job.id);
      const authorIsTarget = userSet.has(note.author_id);
      if (jobIsTarget && !authorIsTarget) {
        const author = userById.get(note.author_id);
        if (author && !isBusiness(author)) {
          edgeBlocker(blockers, ownerCode(author, 'BUSINESS_JOB_NOTE_TO_DEMO_USER'), ownershipMessage,
            'JOB_NOTE', note.id, 'USER', note.author_id);
        }
      }
      if (!jobIsTarget && authorIsTarget) {
        edgeBlocker(blockers, ownerCode(job, 'DEMO_USER_TO_BUSINESS_JOB_NOTE'), ownershipMessage,
          'USER', note.author_id, 'JOB_NOTE', note.id);
      }
    }
    for (const note of confidentialNotesEdge) {
      const staffIsTarget = userSet.has(note.staff_user_id);
      const authorIsTarget = userSet.has(note.author_user_id);
      if (staffIsTarget && !authorIsTarget) {
        const author = userById.get(note.author_user_id);
        if (author && !isBusiness(author)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, note.author_user_id,
            'BUSINESS_CONFIDENTIAL_NOTE_AUTHOR_TO_DEMO_USER'), ownershipMessage,
            'STAFF_CONFIDENTIAL_NOTE', note.id, 'USER', note.author_user_id);
        }
      }
      if (!staffIsTarget && authorIsTarget) {
        edgeBlocker(blockers, userOwnerCode(userById, organizationId, note.staff_user_id,
          'DEMO_USER_TO_BUSINESS_CONFIDENTIAL_NOTE'), ownershipMessage,
          'USER', note.author_user_id, 'STAFF_CONFIDENTIAL_NOTE', note.id);
      }
    }
    for (const event of allEventsEdge) {
      const eventIsTarget = owned(event, organizationId, datasetId);
      for (const [, userId] of eventUserRefs(event)) {
        if (!userId) continue;
        if (userSet.has(userId) && !eventIsTarget) {
          edgeBlocker(blockers, ownerCode(event, 'DEMO_USER_TO_BUSINESS_CALENDAR_EVENT'), ownershipMessage,
            'USER', userId, 'CALENDAR_EVENT', event.id);
        }
        if (eventIsTarget && !userSet.has(userId)) {
          const relatedUser = userById.get(userId);
          if (relatedUser && !isBusiness(relatedUser)) {
            edgeBlocker(blockers, ownerCode(relatedUser, 'BUSINESS_CALENDAR_EVENT_TO_DEMO_USER'), ownershipMessage,
              'CALENDAR_EVENT', event.id, 'USER', userId);
          }
        }
      }
    }
    for (const activity of calendarActivitiesEdge) {
      const event = allEventById.get(activity.calendar_event_id);
      if (event && owned(event, organizationId, datasetId) && activity.actor_user_id && !userSet.has(activity.actor_user_id)) {
        const actor = userById.get(activity.actor_user_id);
        if (actor && !isBusiness(actor)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, activity.actor_user_id,
            'BUSINESS_CALENDAR_ACTIVITY_TO_DEMO_EVENT'), ownershipMessage,
            'CALENDAR_EVENT_ACTIVITY', activity.id, 'USER', activity.actor_user_id);
        }
      }
      if (event && !owned(event, organizationId, datasetId) && activity.actor_user_id && userSet.has(activity.actor_user_id)) {
        edgeBlocker(blockers, ownerCode(event, 'DEMO_USER_TO_BUSINESS_CALENDAR_ACTIVITY'), ownershipMessage,
          'USER', activity.actor_user_id, 'CALENDAR_EVENT_ACTIVITY', activity.id);
      }
    }

    const conversationById = new Map(candidateConversations.map((row) => [row.id, row]));
    for (const conversation of candidateConversations) {
      const conversationIsTarget = owned(conversation, organizationId, datasetId);
      if (conversation.job_id) {
        const job = allJobById.get(conversation.job_id);
        if (job && conversationIsTarget && !effectiveJobSet.has(job.id) && !isBusiness(job)) {
          edgeBlocker(blockers, ownerCode(job, 'DEMO_CONVERSATION_TO_BUSINESS_JOB'), ownershipMessage,
            'CONVERSATION', conversation.id, 'JOB_CARD', job.id);
        }
        if (job && !conversationIsTarget && effectiveJobSet.has(job.id)) {
          edgeBlocker(blockers, ownerCode(conversation, 'DEMO_JOB_TO_BUSINESS_CONVERSATION'), ownershipMessage,
            'JOB_CARD', job.id, 'CONVERSATION', conversation.id);
        }
      }
      if (conversation.customer_id) {
        const customer = customersEdge.find((row) => row.id === conversation.customer_id);
        if (customer) {
          if (conversationIsTarget && !owned(customer, organizationId, datasetId) && !isBusiness(customer)) {
            edgeBlocker(blockers, ownerCode(customer, 'DEMO_CONVERSATION_TO_BUSINESS_CUSTOMER'), ownershipMessage,
              'CONVERSATION', conversation.id, 'CUSTOMER', customer.id);
          }
          if (!conversationIsTarget && owned(customer, organizationId, datasetId)) {
            edgeBlocker(blockers, ownerCode(conversation, 'DEMO_CUSTOMER_TO_BUSINESS_CONVERSATION'), ownershipMessage,
              'CUSTOMER', customer.id, 'CONVERSATION', conversation.id);
          }
        }
      }
    }
    for (const participant of participantsEdge) {
      const conversation = conversationById.get(participant.conversationId);
      if (!conversation) continue;
      const conversationIsTarget = owned(conversation, organizationId, datasetId);
      const participantIsTarget = userSet.has(participant.userId);
      if (conversationIsTarget && !participantIsTarget) {
        const user = userById.get(participant.userId);
        if (user && !isBusiness(user)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, participant.userId,
            'BUSINESS_CONVERSATION_TO_DEMO_USER'), ownershipMessage,
            'CONVERSATION', participant.conversationId, 'USER', participant.userId);
        }
      }
      if (!conversationIsTarget && participantIsTarget) {
        edgeBlocker(blockers, ownerCode(conversation, 'DEMO_USER_TO_BUSINESS_CONVERSATION'), ownershipMessage,
          'USER', participant.userId, 'CONVERSATION', participant.conversationId);
      }
    }
    for (const message of messagesEdge) {
      const conversation = conversationById.get(message.conversation_id);
      if (!conversation) continue;
      const conversationIsTarget = owned(conversation, organizationId, datasetId);
      const senderIsTarget = userSet.has(message.sender_user_id);
      if (conversationIsTarget && !senderIsTarget) {
        const user = userById.get(message.sender_user_id);
        if (user && !isBusiness(user)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, message.sender_user_id,
            'BUSINESS_MESSAGE_TO_DEMO_CONVERSATION'), ownershipMessage,
            'MESSAGE', message.id, 'USER', message.sender_user_id);
        }
      }
      if (!conversationIsTarget && senderIsTarget) {
        edgeBlocker(blockers, ownerCode(conversation, 'DEMO_USER_TO_BUSINESS_MESSAGE'), ownershipMessage,
          'USER', message.sender_user_id, 'MESSAGE', message.id);
      }
    }
    for (const activity of messagingActivitiesEdge) {
      const conversation = conversationById.get(activity.conversation_id);
      if (!conversation) continue;
      const conversationIsTarget = owned(conversation, organizationId, datasetId);
      const actorIsTarget = userSet.has(activity.actor_user_id);
      if (conversationIsTarget && !actorIsTarget) {
        const user = userById.get(activity.actor_user_id);
        if (user && !isBusiness(user)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, activity.actor_user_id,
            'BUSINESS_MESSAGING_ACTIVITY_TO_DEMO_CONVERSATION'), ownershipMessage,
            'MESSAGING_ACTIVITY', activity.id, 'USER', activity.actor_user_id);
        }
      }
      if (!conversationIsTarget && actorIsTarget) {
        edgeBlocker(blockers, ownerCode(conversation, 'DEMO_USER_TO_BUSINESS_MESSAGING_ACTIVITY'), ownershipMessage,
          'USER', activity.actor_user_id, 'MESSAGING_ACTIVITY', activity.id);
      }
    }
    for (const state of userStatesEdge) {
      const conversation = conversationById.get(state.conversationId);
      if (!conversation) continue;
      const conversationIsTarget = owned(conversation, organizationId, datasetId);
      const stateUserIsTarget = userSet.has(state.userId);
      if (conversationIsTarget && !stateUserIsTarget) {
        const user = userById.get(state.userId);
        if (user && !isBusiness(user)) {
          edgeBlocker(blockers, userOwnerCode(userById, organizationId, state.userId,
            'BUSINESS_CONVERSATION_STATE_TO_DEMO_CONVERSATION'), ownershipMessage,
            'CONVERSATION_USER_STATE', `${state.conversationId}:${state.userId}`, 'USER', state.userId);
        }
      }
      if (!conversationIsTarget && stateUserIsTarget) {
        edgeBlocker(blockers, ownerCode(conversation, 'DEMO_USER_TO_BUSINESS_CONVERSATION_STATE'), ownershipMessage,
          'USER', state.userId, 'CONVERSATION_USER_STATE', `${state.conversationId}:${state.userId}`);
      }
    }

    const jobById = new Map(allJobsEdge.map((row) => [row.id, row]));
    for (const reminder of reminderCandidates) {
      // DEMO->BUSINESS and BUSINESS->DEMO reminders are purgeable derived artifacts:
      // they will be included in the purge plan and deleted, preserving the BUSINESS root.
      // Only CLAIMED reminders remain a worker safety blocker.
      if (reminder.state === 'CLAIMED') {
        edgeBlocker(blockers, 'WORKER_CLAIMED_REMINDER', 'Demo hatırlatıcısı bir worker tarafından işleniyor.',
          'CALENDAR_REMINDER', reminder.id, null, null);
      }
    }

    // Realtime/notification/reminder/push cross-scope edges are purgeable derived artifacts.
    // DEMO-derived realtime/notifications/reminders with BUSINESS recipients and
    // BUSINESS-derived realtime/notifications with DEMO recipients are included in the
    // purge plan and deleted, preserving BUSINESS roots.

    for (const delivery of deliveryCandidates) {
      if (delivery.state === 'CLAIMED') {
        edgeBlocker(blockers, 'WORKER_CLAIMED_WEB_PUSH', 'Demo push teslimatı bir worker tarafından işleniyor.',
          'WEB_PUSH_DELIVERY', delivery.id, null, null);
      }
    }

    const backupReferences = await rows<{ source_type: string; source_id: string }>(this.client, `
      SELECT 'BACKUP_RUN' AS source_type, id::text AS source_id
      FROM backup_runs WHERE created_by = ANY($1::uuid[])
      UNION ALL
      SELECT 'BACKUP_POLICY', id::text
      FROM backup_policy WHERE updated_by = ANY($1::uuid[])`, [userIds]);
    for (const reference of backupReferences) {
      edgeBlocker(blockers, 'BACKUP_DEPENDENCY', 'Demo kullanıcı sistem yedekleme kaydına bağlı.',
        reference.source_type, reference.source_id, 'USER', 'TARGET_DATASET_USER');
    }

    const otherDatasetCreatorRefs = await rows<{ id: string }>(this.client, `
      SELECT id::text AS id
      FROM demo_datasets
      WHERE organization_id = $1
        AND id <> $2
        AND created_by = ANY($3::uuid[])`, [organizationId, datasetId, userIds]);
    for (const reference of otherDatasetCreatorRefs) {
      edgeBlocker(blockers, 'DEMO_USER_TO_EXTERNAL_DEMO_DATASET', ownershipMessage,
        'USER', 'TARGET_DATASET_USER', 'DEMO_DATASET', reference.id);
    }

    let targetRealtimeRows = realtimeRows.filter((row) =>
      (row.source_activity_id ? activityIds.has(row.source_activity_id) : false)
      || (row.calendar_activity_id ? setOf(calendarActivities).has(row.calendar_activity_id) : false)
      || (row.calendar_reminder_id ? setOf(targetReminderIds).has(row.calendar_reminder_id) : false)
      || (row.messaging_activity_id ? setOf(targetMessagingActivityIds).has(row.messaging_activity_id) : false)
      || (row.staff_note_id ? setOf(targetStaffNoteIds).has(row.staff_note_id) : false));

    const realtimeSourceIds = [
      ...jobActivityIds,
      ...calendarActivities,
      ...targetReminderIds,
      ...targetMessagingActivityIds,
      ...confidentialNotes,
    ];

    const realtimeEntityIds = [
      ...effectiveJobIdArr,
      ...eventIds,
      ...conversationIds,
      ...confidentialNotes,
    ];
    const crossOrgRealtime = await rows<IdRow>(this.client, `
      SELECT id::text
      FROM realtime_events
      WHERE organization_id <> $1
        AND (
          source_activity_id = ANY($2::uuid[])
          OR calendar_activity_id = ANY($2::uuid[])
          OR calendar_reminder_id = ANY($2::uuid[])
          OR messaging_activity_id = ANY($2::uuid[])
          OR staff_note_id = ANY($2::uuid[])
          OR actor_user_id = ANY($3::uuid[])
          OR audience_user_ids && $3::uuid[]
          OR (entity_id = ANY($4::uuid[])
            AND entity_type IN ('job-card', 'calendar-event', 'conversation', 'confidential-note'))
        )`, [organizationId, realtimeSourceIds, userIds, realtimeEntityIds]);
    if (crossOrgRealtime.length > 0) {
      edgeBlocker(blockers, 'CROSS_ORGANIZATION_DERIVED_EDGE', 'Demo grafı dış organizasyon kaynaklı bir türetim içeriyor.',
        'REALTIME_EVENT', 'CROSS_ORGANIZATION_DERIVED_EDGE', null, null);
    }

    // Same-org external derived realtime that touches DEMO is purgeable: delete the derived realtime, preserve BUSINESS root
    const sameOrgExternalRealtimeIds = await rows<IdRow>(this.client, `
      SELECT id::text
      FROM realtime_events
      WHERE organization_id = $1
        AND NOT (id = ANY($3::bigint[]))
        AND (
          (entity_id = ANY($2::uuid[])
            AND entity_type IN ('job-card', 'calendar-event', 'conversation', 'confidential-note'))
          OR actor_user_id = ANY($4::uuid[])
          OR audience_user_ids && $4::uuid[]
        )`, [organizationId, realtimeEntityIds, realtimeIds, userIds]);
    if (sameOrgExternalRealtimeIds.length > 0) {
      const extraRows = await rows<RealtimeRow>(this.client, `
        SELECT id::text, organization_id, source_activity_id, calendar_activity_id,
          calendar_reminder_id, messaging_activity_id, staff_note_id,
          actor_user_id, audience_user_ids, entity_type, entity_id
        FROM realtime_events
        WHERE organization_id = $1 AND id = ANY($2::bigint[])`, [organizationId, sameOrgExternalRealtimeIds.map((r) => r.id)]);
      const existingIds = setOf(targetRealtimeRows.map((r) => r.id));
      for (const row of extraRows) {
        if (!existingIds.has(row.id)) targetRealtimeRows.push(row);
      }
    }
    const targetRealtimeSet = setOf(targetRealtimeRows.map((row) => row.id));

    // Merge notifications derived from the extra same-org realtime (BUSINESS-derived but touching DEMO)
    if (sameOrgExternalRealtimeIds.length > 0) {
      const extraNotif = await rows<NotificationRow>(this.client, `
        SELECT id, organization_id, recipient_user_id, source_realtime_event_id::text
        FROM in_app_notifications
        WHERE organization_id = $1 AND source_realtime_event_id = ANY($2::bigint[])`,
        [organizationId, sameOrgExternalRealtimeIds.map((r) => r.id)]);
      const existingNotifIds = setOf(targetNotificationRows.map((r) => r.id));
      for (const row of extraNotif) {
        if (!existingNotifIds.has(row.id)) {
          targetNotificationRows.push(row);
          existingNotifIds.add(row.id);
        }
      }
      // Also merge web_push_deliveries for those extra notifications
      if (extraNotif.length > 0) {
        const extraNotifIds = extraNotif.map((r) => r.id);
        const extraDeliveries = await rows<PushDeliveryRow>(this.client, `
          SELECT id, organization_id, notification_id, subscription_id, state
          FROM web_push_deliveries
          WHERE organization_id = $1 AND notification_id = ANY($2::uuid[])`,
          [organizationId, extraNotifIds]);
        const existingDeliveryIds = setOf(targetDeliveryRows.map((r) => r.id));
        for (const row of extraDeliveries) {
          if (!existingDeliveryIds.has(row.id)) targetDeliveryRows.push(row);
        }
      }
    }

    // Notifications and deliveries touching DEMO are already expanded to union above; use them directly
    const targetNotificationIdsFinal = targetNotificationRows.map((row) => row.id);
    const targetNotificationSet = setOf(targetNotificationIdsFinal);
    const targetDeliveryIds = targetDeliveryRows.map((row) => row.id);

    const retainedAuditActorLinks: DemoDatasetRetainedActorLink[] = auditLinks.map((row) => ({
      auditEventId: row.id,
      actorUserId: row.actor_user_id,
    }));
    const datasetCreatorUserId = datasetRow.created_by && userSet.has(datasetRow.created_by)
      ? datasetRow.created_by
      : null;
    const jobCardDeleteOrder = deleteOrder(allJobsEdge, effectiveJobIdArr);
    const semanticallyRelevantEdges = [
      ...contactsEdge
        .filter((row) => customerSet.has(row.customer_id))
        .map((row) => `CONTACT_CUSTOMER:${row.id}:${row.customer_id}`),
      ...allJobsEdge
        .filter((row) => effectiveJobSet.has(row.id))
        .flatMap((row) => [
          ...(row.customer_id ? [`JOB_CUSTOMER:${row.id}:${row.customer_id}`] : []),
          ...(row.contact_id ? [`JOB_CONTACT:${row.id}:${row.contact_id}`] : []),
          ...userRefs(row).flatMap(([role, userId]) => userId ? [`JOB_USER:${row.id}:${role}:${userId}`] : []),
        ]),
      ...deliveriesEdge
        .filter((row) => effectiveJobSet.has(row.job_card_id))
        .map((row) => `JOB_PRODUCT:${row.job_card_id}:${row.product_id}`),
      ...jobActivities
        .flatMap((row) => row.actor_id ? [`JOB_ACTIVITY_ACTOR:${row.id}:${row.actor_id}`] : []),
      ...jobNotes
        .map((row) => `JOB_NOTE_AUTHOR:${row.id}:${row.author_id}`),
      ...confidentialNotesEdge
        .filter((row) => userSet.has(row.staff_user_id))
        .flatMap((row) => [
          `STAFF_NOTE_STAFF:${row.id}:${row.staff_user_id}`,
          `STAFF_NOTE_AUTHOR:${row.id}:${row.author_user_id}`,
        ]),
      ...events.flatMap((row) => eventUserRefs(row)
        .flatMap(([role, userId]) => userId ? [`CALENDAR_EVENT_USER:${row.id}:${role}:${userId}`] : [])),
      ...calendarActivitiesEdge
        .filter((row) => eventSet.has(row.calendar_event_id))
        .flatMap((row) => row.actor_user_id ? [`CALENDAR_ACTIVITY_ACTOR:${row.id}:${row.actor_user_id}`] : []),
      ...targetReminderRows.flatMap((row) => [
        ...(row.job_card_id ? [`REMINDER_JOB:${row.id}:${row.job_card_id}`] : []),
        ...(row.calendar_event_id ? [`REMINDER_EVENT:${row.id}:${row.calendar_event_id}`] : []),
        `REMINDER_RECIPIENT:${row.id}:${row.recipient_user_id}`,
      ]),
      ...conversations.flatMap((row) => [
        ...(row.job_id ? [`CONVERSATION_JOB:${row.id}:${row.job_id}`] : []),
        ...(row.customer_id ? [`CONVERSATION_CUSTOMER:${row.id}:${row.customer_id}`] : []),
      ]),
      ...targetMessages.map((row) => `MESSAGE_SENDER:${row.id}:${row.sender_user_id}`),
      ...targetMessagingActivities.map((row) => `MESSAGING_ACTIVITY_ACTOR:${row.id}:${row.actor_user_id}`),
      ...targetRealtimeRows.flatMap((row) => [
        ...(row.source_activity_id ? [`REALTIME_JOB_ACTIVITY:${row.id}:${row.source_activity_id}`] : []),
        ...(row.calendar_activity_id ? [`REALTIME_CALENDAR_ACTIVITY:${row.id}:${row.calendar_activity_id}`] : []),
        ...(row.calendar_reminder_id ? [`REALTIME_REMINDER:${row.id}:${row.calendar_reminder_id}`] : []),
        ...(row.messaging_activity_id ? [`REALTIME_MESSAGING_ACTIVITY:${row.id}:${row.messaging_activity_id}`] : []),
        ...(row.staff_note_id ? [`REALTIME_STAFF_NOTE:${row.id}:${row.staff_note_id}`] : []),
      ]),
      ...targetNotificationRows.flatMap((row) => [
        `NOTIFICATION_RECIPIENT:${row.id}:${row.recipient_user_id}`,
        `NOTIFICATION_EVENT:${row.id}:${row.source_realtime_event_id}`,
      ]),
      ...targetDeliveryRows.flatMap((row) => [
        `WEB_PUSH_DELIVERY_NOTIFICATION:${row.id}:${row.notification_id}`,
        `WEB_PUSH_DELIVERY_SUBSCRIPTION:${row.id}:${row.subscription_id}`,
      ]),
      ...retainedAuditActorLinks.map((link) => `AUDIT_ACTOR:${link.auditEventId}:${link.actorUserId}`),
      ...(datasetCreatorUserId ? [`DATASET_CREATOR:${datasetCreatorUserId}`] : []),
    ];
    const plan: DemoDatasetPurgePlan = {
      schemaVersion: DEMO_DATASET_PURGE_PLAN_SCHEMA_VERSION,
      organizationId,
      datasetId,
      users: userIds,
      staffProfiles: uniqueSorted(staffProfiles),
      customers: customerIds,
      contacts: uniqueSorted(contacts),
      products: productIds,
      jobCards: effectiveJobIdArr,
      jobCardDeleteOrder,
      deliveryItems: uniqueSorted(deliveryItems),
      jobNotes: jobNotes.map((row) => row.id),
      meetingDetails: meetingDetails.map((row) => row.job_card_id),
      jobActivities: jobActivityIds,
      jobActionLocations: jobActionLocations.map((row) => row.id),
      confidentialNotes: uniqueSorted(confidentialNotes),
      calendarEvents: eventIds,
      calendarActivities: uniqueSorted(calendarActivities),
      reminders: uniqueSorted(targetReminderIds),
      conversations: conversationIds,
      messages: targetMessages.map((row) => row.id),
      conversationParticipants: targetParticipants.map(({ conversationId, userId }) => ({ conversationId, userId })),
      conversationUserStates: targetUserStates.map(({ conversationId, userId }) => ({ conversationId, userId })),
      messagingActivities: targetMessagingActivities.map((row) => row.id),
      realtimeEvents: uniqueSorted(targetRealtimeRows.map((row) => row.id)),
      notifications: uniqueSorted(targetNotificationIdsFinal),
      webPushSubscriptions: subscriptions.map((row) => row.id),
      webPushDeliveries: uniqueSorted(targetDeliveryIds),
      sessions: sessions.map((row) => row.id),
      processedActions: processedActions.map((row) => row.id),
      semanticallyRelevantEdges: uniqueSorted(semanticallyRelevantEdges),
      retainedAuditActorLinks,
      datasetCreatorUserId,
    };

    const counts = mapCounts({
      users: plan.users,
      staffProfiles: plan.staffProfiles,
      customers: plan.customers,
      contacts: plan.contacts,
      products: plan.products,
      jobCards: plan.jobCards,
      deliveryItems: plan.deliveryItems,
      jobNotes: plan.jobNotes,
      confidentialNotes: plan.confidentialNotes,
      jobActivities: plan.jobActivities,
      calendarActivities: plan.calendarActivities,
      followUps: allJobsEdge.filter((row) => effectiveJobSet.has(row.id) && row.source_job_card_id !== null).length,
      calendarEvents: plan.calendarEvents,
      conversations: plan.conversations,
      messages: plan.messages,
      notifications: plan.notifications,
      reminders: plan.reminders,
      realtimeEvents: plan.realtimeEvents,
      messagingActivities: plan.messagingActivities,
    });

    return {
      dataset,
      organizationName: datasetRow.organization_name,
      affectedCounts: counts,
      blockers,
      planKeys: planKeys(plan),
      purgePlan: plan,
    };
  }
}
