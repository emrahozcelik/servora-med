import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { hashPassword } from '../src/modules/auth/crypto.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
const password = process.env.F4_SEED_PASSWORD;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!password) throw new Error('F4_SEED_PASSWORD is required');

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
const now = new Date('2026-07-31T09:00:00.000Z');
const at = (hours: number) => new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

const ids = {
  org: '81be5ae2-8657-4e63-ae49-83f395613faa',
  otherOrg: 'eccdad8c-5d51-42bc-986a-9b43e6948de7',
  admin: '8935c4ca-6d97-4020-a10c-0bf9987d1f75',
  manager: '4dcf2dd6-d4c2-44e6-9622-2da0703ff7ec',
  staffA: '6bad0eec-ae61-4a0c-a5da-bb2d7fedc8bd',
  staffB: '4228abe0-454c-4607-9db3-a56dcaf77eec',
  staffC: 'ac30ea43-e587-4176-b7cd-a6d5838e337d',
  staffD: '7fcccf9b-a37d-40a9-ab8e-3458c7f7ab47',
  crossStaff: 'c44172ac-b1c6-4c2a-a693-7116e18896a3',
  customerA: 'fd70e6be-655d-44a3-a73f-d78844ff31c5',
  customerB: 'c26326ee-fd80-4089-8598-ae8e740165a3',
  crossCustomer: 'f04131c8-54b9-4697-a97e-ff328b1dee92',
  contactA: 'aa111111-1111-4111-8111-111111111111',
  contactB: 'bb222222-2222-4222-8222-222222222222',
  crossContact: 'cc333333-3333-4333-8333-333333333333',
  product: 'dd444444-4444-4444-8444-444444444444',
  s1: '843521a9-7f23-4b8b-b455-6dd95410eb07',
  p1: '45780022-482e-468d-a5de-7dc2c638f82b',
  g1: 'da3d1aa6-fdd1-4712-8581-2d83561f9ee7',
  c1: '5c693c75-f5ae-4c61-8103-323f7aafd0a3',
  u1: '8b22d285-7934-4085-882f-d169d2d25221',
  x1: '6c5bc242-e710-449c-a94b-7d353a25832f',
};

type JobSpec = {
  id: string;
  organizationId?: string;
  type: 'PRODUCT_DELIVERY' | 'GENERAL_TASK' | 'SALES_MEETING';
  status: 'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED' | 'COMPLETED' | 'CANCELLED';
  title: string;
  assignedTo: string;
  customerId?: string | null;
  contactId?: string | null;
  scheduledAt?: string | null;
  engagementKind?: string | null;
  sourceJobCardId?: string | null;
  followUpInstructions?: string | null;
  priority?: string;
};

const insertedJobs: Record<string, string> = {};
const depthRoot = '90000000-0000-4000-8000-000000000000';
const depthChain = Array.from({ length: 10 }, (_, index) =>
  `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

async function insertJob(spec: JobSpec) {
  const actorId = spec.organizationId === ids.otherOrg ? ids.crossStaff : ids.manager;
  const values: Record<string, unknown> = {
    id: spec.id,
    organization_id: spec.organizationId ?? ids.org,
    type: spec.type,
    status: spec.status,
    title: spec.title,
    assigned_to: spec.assignedTo,
    created_by: spec.organizationId === ids.otherOrg ? ids.crossStaff : ids.manager,
    priority: spec.priority ?? 'normal',
    customer_id: spec.customerId ?? null,
    contact_id: spec.contactId ?? null,
    scheduled_at: spec.scheduledAt ?? null,
    engagement_kind: spec.engagementKind ?? null,
    source_job_card_id: spec.sourceJobCardId ?? null,
    follow_up_instructions: spec.followUpInstructions ?? null,
  };
  if (spec.status === 'ACCEPTED') {
    values.accepted_at = at(1);
    values.accepted_by = spec.assignedTo;
  }
  if (['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'].includes(spec.status)) {
    values.started_at = at(2);
  }
  if (['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'].includes(spec.status)) {
    values.staff_completed_at = at(3);
    values.staff_completed_by = spec.assignedTo;
  }
  if (spec.status === 'REVISION_REQUESTED') {
    values.revision_requested_at = at(4);
    values.revision_requested_by = actorId;
    values.revision_reason = 'F4 sentetik revizyon kontrolü';
  }
  if (spec.status === 'COMPLETED') {
    values.manager_approved_at = at(5);
    values.manager_approved_by = actorId;
  }
  if (spec.status === 'CANCELLED') {
    values.cancelled_at = at(4);
    values.cancelled_by = actorId;
    values.cancel_reason = 'F4 sentetik iptal kontrolü';
  }
  const columns = Object.keys(values);
  const params = columns.map((column) => values[column]);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await client.query(
    `INSERT INTO job_cards (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    params,
  );
  insertedJobs[spec.title] = spec.id;
  await client.query(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type, new_value, metadata, created_at)
     VALUES ($1, $2, $3, 'JOB_CREATED', $4::jsonb, $5::jsonb, $6)`,
    [spec.organizationId ?? ids.org, spec.id, actorId,
      JSON.stringify({ status: spec.status, assignedTo: spec.assignedTo, version: 1 }),
      JSON.stringify(spec.title === 'S1 — completed Sales Meeting'
        ? { privateMarker: 'PRIVATE_ACTIVITY_F4' }
        : {}), at(-1)],
  );
  if (spec.status === 'COMPLETED') {
    await client.query(
      `INSERT INTO job_card_activity_logs
         (organization_id, job_card_id, actor_id, event_type, new_value, created_at)
       VALUES ($1, $2, $3, 'JOB_APPROVED', $4::jsonb, $5)`,
      [spec.organizationId ?? ids.org, spec.id, actorId,
        JSON.stringify({ status: 'COMPLETED' }), at(6)],
    );
  }
}

const passwordHash = await hashPassword(password);

try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, 'Europe/Istanbul'), ($3, $4, 'Europe/Istanbul')`,
    [ids.org, 'F4 Synthetic Organization', ids.otherOrg, 'F4 Cross Organization'],
  );

  const users = [
    [ids.admin, ids.org, 'F4 Synthetic Admin', 'admin@f4.synthetic', 'ADMIN'],
    [ids.manager, ids.org, 'F4 Synthetic Manager', 'manager@f4.synthetic', 'MANAGER'],
    [ids.staffA, ids.org, 'F4 Staff A Source Assignee', 'staff-a@f4.synthetic', 'STAFF'],
    [ids.staffB, ids.org, 'F4 Staff B Follow-up Assignee', 'staff-b@f4.synthetic', 'STAFF'],
    [ids.staffC, ids.org, 'F4 Staff C Unrelated', 'staff-c@f4.synthetic', 'STAFF'],
    [ids.staffD, ids.org, 'F4 Staff D Reassignment Target', 'staff-d@f4.synthetic', 'STAFF'],
    [ids.crossStaff, ids.otherOrg, 'F4 Cross Organization Staff', 'cross-staff@f4.synthetic', 'STAFF'],
  ] as const;
  for (const [id, organizationId, name, email, role] of users) {
    await client.query(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role, must_change_password, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, false, true)`,
      [id, organizationId, name, email, passwordHash, role],
    );
  }
  for (const userId of [ids.staffA, ids.staffB, ids.staffC, ids.staffD]) {
    await client.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title, region, manager_user_id)
       VALUES ($1, $2, 'F4 sentetik saha personeli', 'F4', $3)`,
      [ids.org, userId, ids.manager],
    );
  }
  await client.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title, region, manager_user_id)
     VALUES ($1, $2, 'F4 cross-org saha personeli', 'X', NULL)`,
    [ids.otherOrg, ids.crossStaff],
  );

  await client.query(
    `INSERT INTO customers (id, organization_id, name, customer_type, assigned_staff_user_id, status)
     VALUES ($1, $2, 'F4 Synthetic Customer A', 'clinic', $3, 'active'),
            ($4, $2, 'F4 Synthetic Customer B', 'hospital', $5, 'active'),
            ($6, $7, 'F4 Cross Organization Customer', 'clinic', $8, 'active')`,
    [ids.customerA, ids.org, ids.staffA, ids.customerB, ids.staffB, ids.crossCustomer, ids.otherOrg, ids.crossStaff],
  );
  await client.query(
    `INSERT INTO contacts (id, organization_id, customer_id, name, title, is_primary)
     VALUES ($1, $2, $3, 'F4 Synthetic Contact A', 'Purchasing', true),
            ($4, $2, $5, 'F4 Synthetic Contact B', 'Doctor', true),
            ($6, $7, $8, 'F4 Cross Organization Contact', 'Doctor', true)`,
    [ids.contactA, ids.org, ids.customerA, ids.contactB, ids.customerB, ids.crossContact, ids.otherOrg, ids.crossCustomer],
  );
  await client.query(
    `INSERT INTO products (id, organization_id, sku, name, brand, category, unit, is_active)
     VALUES ($1, $2, 'F4-001', 'F4 Synthetic Implant Kit', 'F4', 'Dental', 'adet', true)`,
    [ids.product, ids.org],
  );

  await insertJob({
    id: ids.s1, type: 'SALES_MEETING', status: 'COMPLETED', title: 'S1 — completed Sales Meeting',
    assignedTo: ids.staffA, customerId: ids.customerA, contactId: ids.contactA,
    scheduledAt: '2026-07-12T08:00:00.000Z', engagementKind: 'SALES_MEETING',
  });
  await client.query(
    `INSERT INTO job_card_meeting_details
       (job_card_id, organization_id, meeting_at, outcome, meeting_summary, next_follow_up_at)
     VALUES ($1, $2, '2026-07-12T09:15:00.000Z', 'FOLLOW_UP_REQUIRED', $3, '2026-08-05T10:00:00.000Z')`,
    [ids.s1, ids.org, 'PRIVATE_MEETING_SUMMARY_F4 — synthetic only'],
  );
  await client.query(
    `INSERT INTO job_card_notes (organization_id, job_card_id, author_id, note, record_version)
     VALUES ($1, $2, $3, $4, 0)`,
    [ids.org, ids.s1, ids.staffA, 'PRIVATE_SOURCE_NOTE_F4 — synthetic only'],
  );

  await insertJob({
    id: ids.p1, type: 'PRODUCT_DELIVERY', status: 'COMPLETED', title: 'P1 — completed product delivery',
    assignedTo: ids.staffA, customerId: ids.customerA, contactId: ids.contactA,
  });
  await client.query(
    `INSERT INTO job_card_delivery_items
       (organization_id, job_card_id, product_id, delivery_purpose, delivered_at, quantity, unit,
        product_name_snapshot, product_sku_snapshot, delivery_note)
     VALUES ($1, $2, $3, 'SALE', '2026-07-20T10:00:00.000Z', 2, 'adet',
             'F4 Synthetic Implant Kit', 'F4-001', $4)`,
    [ids.org, ids.p1, ids.product, 'PRIVATE_DELIVERY_DETAIL_F4 — synthetic only'],
  );

  await insertJob({
    id: ids.g1, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'G1 — completed customerless task',
    assignedTo: ids.staffA, customerId: null,
  });
  await insertJob({
    id: ids.c1, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'C1 — completed chain source',
    assignedTo: ids.staffA, customerId: ids.customerA, contactId: ids.contactA,
  });
  await insertJob({
    id: ids.u1, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'U1 — unrelated Staff C job',
    assignedTo: ids.staffC, customerId: ids.customerA,
  });

  const ineligible: JobSpec[] = [
    { id: randomUUID(), type: 'GENERAL_TASK', status: 'NEW', title: 'N1 — ineligible NEW', assignedTo: ids.staffA, customerId: ids.customerA },
    { id: randomUUID(), type: 'GENERAL_TASK', status: 'ACCEPTED', title: 'N2 — ineligible ACCEPTED', assignedTo: ids.staffA, customerId: ids.customerA },
    { id: randomUUID(), type: 'GENERAL_TASK', status: 'IN_PROGRESS', title: 'N3 — ineligible IN_PROGRESS', assignedTo: ids.staffA, customerId: ids.customerA },
    { id: randomUUID(), type: 'GENERAL_TASK', status: 'WAITING_APPROVAL', title: 'N4 — ineligible WAITING_APPROVAL', assignedTo: ids.staffA, customerId: ids.customerA },
    { id: randomUUID(), type: 'GENERAL_TASK', status: 'REVISION_REQUESTED', title: 'N5 — ineligible REVISION_REQUESTED', assignedTo: ids.staffA, customerId: ids.customerA },
    { id: randomUUID(), type: 'GENERAL_TASK', status: 'CANCELLED', title: 'N6 — ineligible CANCELLED', assignedTo: ids.staffA, customerId: ids.customerA },
  ];
  for (const job of ineligible) await insertJob(job);

  await insertJob({
    id: depthRoot, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'DEPTH-0 — chain root',
    assignedTo: ids.staffA, customerId: ids.customerA,
  });
  let previous = depthRoot;
  for (let depth = 1; depth <= 10; depth += 1) {
    const id = depthChain[depth - 1]!;
    await insertJob({
      id, type: 'GENERAL_TASK', status: 'COMPLETED', title: `DEPTH-${depth} — chain fixture`,
      assignedTo: ids.staffA, customerId: ids.customerA, sourceJobCardId: previous,
      followUpInstructions: `Depth ${depth} synthetic instruction`,
    });
    previous = id;
  }

  await insertJob({
    id: ids.x1, organizationId: ids.otherOrg, type: 'GENERAL_TASK', status: 'COMPLETED', title: 'X1 — cross organization job',
    assignedTo: ids.crossStaff, customerId: ids.crossCustomer,
  });

  await client.query('COMMIT');
  console.log(JSON.stringify({
    database: 'servora_med_f4_test',
    organizationId: ids.org,
    otherOrganizationId: ids.otherOrg,
    users: {
      admin: { id: ids.admin, email: 'admin@f4.synthetic' },
      manager: { id: ids.manager, email: 'manager@f4.synthetic' },
      staffA: { id: ids.staffA, email: 'staff-a@f4.synthetic' },
      staffB: { id: ids.staffB, email: 'staff-b@f4.synthetic' },
      staffC: { id: ids.staffC, email: 'staff-c@f4.synthetic' },
      staffD: { id: ids.staffD, email: 'staff-d@f4.synthetic' },
      crossStaff: { id: ids.crossStaff, email: 'cross-staff@f4.synthetic' },
    },
    customers: { customerA: ids.customerA, customerB: ids.customerB, crossCustomer: ids.crossCustomer },
    jobs: { s1: ids.s1, p1: ids.p1, g1: ids.g1, c1: ids.c1, u1: ids.u1, x1: ids.x1, depth10: previous },
    syntheticOnly: true,
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
