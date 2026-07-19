# SSE Realtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, authenticated Server-Sent Events foundation that publishes JobCard invalidation events after committed mutations and replays missed visible events without changing existing REST response contracts.

**Architecture:** Persist one compact realtime event as a transaction-bound projection of each covered canonical `job_card_activity_logs` row. After commit, publish the persisted event through a process-local bus; authenticated SSE clients receive audience-filtered replay plus live events and use event IDs as cursors. The stream carries invalidation metadata only—canonical JobCard data remains in existing REST APIs.

**Tech Stack:** Node.js 22, TypeScript 5.9, Fastify 5, PostgreSQL 17, `pg`, Vitest 4, Bash, Caddy, existing cookie authentication.

## Global Constraints

- Baseline is `main@d785fa3f127a0304e34dc3377b9bc1c74a9b75e7`.
- Work on branch `feature/sse-realtime-foundation`.
- Follow repository `AGENTS.md`; backend truth, role checks, idempotency, optimistic versions, and audit records remain authoritative.
- Add no npm dependency.
- Keep the existing React/Vite frontend unchanged.
- Keep all existing public JobCard REST request and response DTOs unchanged.
- Do not add notifications, Web Push, service workers, manifests, geolocation, WebSockets, PostgreSQL `LISTEN/NOTIFY`, brokers, or multi-process coordination.
- Initial realtime coverage is limited to JobCard creation, base-field patch/reassignment, and lifecycle activity events.
- Exclude `NOTE_ADDED`, delivery-item events, and `MEETING_DETAILS_UPDATED`.
- SSE event payloads contain no JobCard snapshot, notes, delivery details, customer/contact data, session data, or location.
- `ADMIN` and `MANAGER` may receive organization management events; `STAFF` receives only explicitly addressed events.
- Realtime is an acceleration layer. REST remains correct when no stream is connected.
- The new migration is exactly `server/src/db/migrations/011_create_realtime_events.sql`. Stop before editing if `011` already exists on the execution branch; rebase onto the agreed baseline rather than inventing another migration number.
- Every implementation task uses test-first development and ends with a focused commit.
- Do not merge the PR. Stop after opening a draft PR.

## Locked File Structure

### Create

- `server/src/db/migrations/011_create_realtime_events.sql` — durable event ledger schema.
- `server/src/modules/realtime/types.ts` — event, audience, cursor, and envelope contracts.
- `server/src/modules/realtime/audience.ts` — pure role/user audience construction and visibility checks.
- `server/src/modules/realtime/event-mapper.ts` — pure JobCard activity-to-realtime mapping.
- `server/src/modules/realtime/repository.ts` — transaction append and audience-filtered replay/high-water queries.
- `server/src/modules/realtime/event-bus.ts` — process-local publish/subscribe boundary.
- `server/src/modules/realtime/service.ts` — replay/live handoff, overflow, deduplication, and subscriptions.
- `server/src/modules/realtime/routes.ts` — authenticated SSE HTTP translation.
- `server/tests/realtime-migration.test.ts`
- `server/tests/realtime-contract.test.ts`
- `server/tests/realtime-repository.test.ts`
- `server/tests/realtime-event-bus.test.ts`
- `server/tests/realtime-service.test.ts`
- `server/tests/realtime-routes.test.ts`
- `server/tests/realtime-job-card-integration.test.ts`
- `ops/ci/verify-sse-streaming.sh`

### Modify

- `server/src/modules/job-cards/repository.ts` — return canonical activity identity; delegate transaction event append.
- `server/src/modules/job-cards/service.ts` — map/persist events in transactions and publish only after successful commit.
- `server/src/app.ts` — add optional realtime dependencies and register the stream route behind existing auth gates.
- `server/src/index.ts` — construct one repository, bus, and service for the Fastify process.
- `server/tests/job-card-service.test.ts` — update memory transaction contract and verify publish semantics.
- `server/tests/app.test.ts` — verify optional realtime route wiring.
- `ops/ci/verify-caddyfile.sh` — assert the SSE path is not configured with response buffering.
- `.github/workflows/ci.yml` — syntax-check, shellcheck, and run the SSE proxy verification.
- `docs/superpowers/specs/2026-07-19-sse-realtime-foundation-design.md` — append implementation/verification record only after all tests pass.

---

### Task 1: Establish the isolated execution baseline

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-07-19-sse-realtime-foundation-design.md`
- Read: `server/src/modules/job-cards/repository.ts`
- Read: `server/src/modules/job-cards/service.ts`
- Read: `server/src/app.ts`
- Read: `server/src/index.ts`

**Interfaces:**
- Consumes: repository baseline `d785fa3f127a0304e34dc3377b9bc1c74a9b75e7`.
- Produces: isolated branch `feature/sse-realtime-foundation` with no local drift.

- [ ] **Step 1: Confirm the worktree is clean and at the agreed baseline**

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

Expected:

```text
# git status --short prints nothing
main
d785fa3f127a0304e34dc3377b9bc1c74a9b75e7
d785fa3f127a0304e34dc3377b9bc1c74a9b75e7
```

- [ ] **Step 2: Create an isolated worktree**

```bash
git worktree add ../servora-med-sse -b feature/sse-realtime-foundation d785fa3f127a0304e34dc3377b9bc1c74a9b75e7
cd ../servora-med-sse
```

Expected:

```text
Preparing worktree (new branch 'feature/sse-realtime-foundation')
HEAD is now at d785fa3 chore(ci): migrate GitHub Actions to Node 24 runtimes
```

- [ ] **Step 3: Confirm migration 011 is free**

```bash
test ! -e server/src/db/migrations/011_create_realtime_events.sql
find server/src/db/migrations -maxdepth 1 -type f -name '*.sql' -print | sort | tail -n 3
```

Expected: the `test` command exits `0`; the latest existing migration is in the `010_*` family.

- [ ] **Step 4: Run the server baseline**

```bash
cd server
npm ci
npm run build
npm test -- --run
cd ..
```

Expected: build succeeds and the existing server suite passes with the repository's environment-dependent skips only.

- [ ] **Step 5: Do not commit**

This task creates only the isolated branch/worktree.

---

### Task 2: Add the durable realtime event migration

**Files:**
- Create: `server/src/db/migrations/011_create_realtime_events.sql`
- Create: `server/tests/realtime-migration.test.ts`

**Interfaces:**
- Consumes: existing `organizations(id)` and `job_card_activity_logs(id, organization_id)` schema.
- Produces: table `realtime_events` with a monotonic `BIGINT` cursor and one-to-one `source_activity_id`.

- [ ] **Step 1: Write the failing migration contract test**

Create `server/tests/realtime-migration.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../src/db/migrations/011_create_realtime_events.sql',
  import.meta.url,
);

describe('011 realtime event migration', () => {
  it('creates the durable audience-filtered event ledger', async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(sql).toContain('CREATE TABLE realtime_events');
    expect(sql).toMatch(/id\s+BIGINT\s+GENERATED ALWAYS AS IDENTITY\s+PRIMARY KEY/i);
    expect(sql).toMatch(/source_activity_id\s+UUID\s+NOT NULL\s+UNIQUE/i);
    expect(sql).toContain('REFERENCES job_card_activity_logs(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES organizations(id) ON DELETE CASCADE');
    expect(sql).toContain("entity_type = 'job-card'");
    expect(sql).toContain("cardinality(resource_keys) > 0");
    expect(sql).toContain("audience_roles <@ ARRAY['ADMIN', 'MANAGER']");
    expect(sql).toContain(
      'cardinality(audience_roles) > 0 OR cardinality(audience_user_ids) > 0',
    );
    expect(sql).toContain(
      'CREATE INDEX realtime_events_organization_cursor_idx',
    );
    expect(sql).toContain(
      'CREATE INDEX realtime_events_audience_users_gin_idx',
    );
    expect(sql).toContain(
      'CREATE INDEX realtime_events_audience_roles_gin_idx',
    );
    expect(sql).not.toMatch(/\bpayload\b/i);
  });
});
```

- [ ] **Step 2: Run the test and verify the file is missing**

```bash
cd server
npm test -- --run tests/realtime-migration.test.ts
```

Expected: FAIL because `011_create_realtime_events.sql` does not exist.

- [ ] **Step 3: Create the migration**

Create `server/src/db/migrations/011_create_realtime_events.sql`:

```sql
CREATE TABLE realtime_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  source_activity_id UUID NOT NULL UNIQUE
    REFERENCES job_card_activity_logs(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  actor_user_id UUID NULL,
  audience_roles VARCHAR(20)[] NOT NULL DEFAULT '{}',
  audience_user_ids UUID[] NOT NULL DEFAULT '{}',
  resource_keys TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT realtime_events_event_type_check CHECK (
    event_type IN (
      'job.created',
      'job.assignment_changed',
      'job.accepted',
      'job.started',
      'job.submitted_for_approval',
      'job.approved',
      'job.revision_requested',
      'job.cancelled',
      'job.updated'
    )
  ),
  CONSTRAINT realtime_events_entity_type_check CHECK (
    entity_type = 'job-card'
  ),
  CONSTRAINT realtime_events_resources_check CHECK (
    cardinality(resource_keys) > 0
  ),
  CONSTRAINT realtime_events_roles_check CHECK (
    audience_roles <@ ARRAY['ADMIN', 'MANAGER']::VARCHAR(20)[]
  ),
  CONSTRAINT realtime_events_audience_check CHECK (
    cardinality(audience_roles) > 0
    OR cardinality(audience_user_ids) > 0
  )
);

CREATE INDEX realtime_events_organization_cursor_idx
  ON realtime_events (organization_id, id);

CREATE INDEX realtime_events_audience_users_gin_idx
  ON realtime_events USING GIN (audience_user_ids);

CREATE INDEX realtime_events_audience_roles_gin_idx
  ON realtime_events USING GIN (audience_roles);
```

- [ ] **Step 4: Run migration tests**

```bash
npm test -- --run tests/realtime-migration.test.ts tests/migrate-runner.test.ts
```

Expected: both test files PASS.

- [ ] **Step 5: Apply migrations against the test database**

```bash
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
DATABASE_URL="$TEST_DATABASE_URL" \
npm run migrate
```

Expected:

```text
Migration applied: 011_create_realtime_events.sql
```

- [ ] **Step 6: Commit**

```bash
cd ..
git add server/src/db/migrations/011_create_realtime_events.sql \
        server/tests/realtime-migration.test.ts
git commit -m "feat(server): add realtime event ledger"
```

---

### Task 3: Define pure realtime contracts, audiences, and JobCard mapping

**Files:**
- Create: `server/src/modules/realtime/types.ts`
- Create: `server/src/modules/realtime/audience.ts`
- Create: `server/src/modules/realtime/event-mapper.ts`
- Create: `server/tests/realtime-contract.test.ts`

**Interfaces:**
- Consumes:
  - `JobCardActivityEvent`, `JobCardActor`, and `JobCard` from `job-cards/types.ts`.
- Produces:
  - `RealtimeEventType`
  - `RealtimeAudience`
  - `RealtimeEventInput`
  - `RealtimeEventRecord`
  - `RealtimeEventEnvelope`
  - `RealtimeViewer`
  - `buildJobCardAudience(input)`
  - `canViewRealtimeEvent(viewer, event)`
  - `mapJobCardActivityToRealtime(input)`

- [ ] **Step 1: Write the failing contract tests**

Create `server/tests/realtime-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildJobCardAudience,
  canViewRealtimeEvent,
} from '../src/modules/realtime/audience.js';
import {
  mapJobCardActivityToRealtime,
} from '../src/modules/realtime/event-mapper.js';

const base = {
  activityId: 'activity-1',
  organizationId: 'org-1',
  jobCardId: 'job-1',
  actorUserId: 'manager-1',
  occurredAt: new Date('2026-07-19T14:30:00.000Z'),
  beforeAssigneeId: 'staff-old',
  afterAssigneeId: 'staff-new',
};

describe('realtime JobCard contract', () => {
  it('addresses management and both assignees on reassignment', () => {
    expect(buildJobCardAudience({
      event: 'JOB_ASSIGNED',
      beforeAssigneeId: 'staff-old',
      afterAssigneeId: 'staff-new',
    })).toEqual({
      roles: ['ADMIN', 'MANAGER'],
      userIds: ['staff-new', 'staff-old'],
    });
  });

  it('never grants an unrelated staff user visibility', () => {
    const event = mapJobCardActivityToRealtime({
      ...base,
      event: 'JOB_ASSIGNED',
    });

    expect(canViewRealtimeEvent(
      { organizationId: 'org-1', userId: 'staff-other', role: 'STAFF' },
      event,
    )).toBe(false);
  });

  it.each([
    ['JOB_CREATED', 'job.created'],
    ['JOB_ASSIGNED', 'job.assignment_changed'],
    ['JOB_ACCEPTED', 'job.accepted'],
    ['JOB_STARTED', 'job.started'],
    ['JOB_SUBMITTED_FOR_APPROVAL', 'job.submitted_for_approval'],
    ['JOB_APPROVED', 'job.approved'],
    ['JOB_REVISION_REQUESTED', 'job.revision_requested'],
    ['JOB_CANCELLED', 'job.cancelled'],
    ['JOB_FIELDS_UPDATED', 'job.updated'],
    ['JOB_PLANNED', 'job.updated'],
    ['JOB_RESUMED', 'job.updated'],
    ['JOB_APPROVAL_WITHDRAWN', 'job.updated'],
  ] as const)('maps %s to %s', (activity, expected) => {
    expect(mapJobCardActivityToRealtime({
      ...base,
      event: activity,
    }).type).toBe(expected);
  });

  it.each([
    'NOTE_ADDED',
    'DELIVERY_ITEM_ADDED',
    'DELIVERY_ITEM_UPDATED',
    'DELIVERY_ITEM_REMOVED',
    'MEETING_DETAILS_UPDATED',
  ] as const)('excludes %s from phase N', (activity) => {
    expect(mapJobCardActivityToRealtime({
      ...base,
      event: activity,
    })).toBeNull();
  });

  it('adds approval, staff profile, and report invalidations for submission', () => {
    const event = mapJobCardActivityToRealtime({
      ...base,
      beforeAssigneeId: 'staff-new',
      event: 'JOB_SUBMITTED_FOR_APPROVAL',
    });

    expect(event?.resourceKeys).toEqual([
      'approval-queue',
      'job-board',
      'job-detail:job-1',
      'job-list',
      'reports',
      'staff-profile:staff-new',
    ]);
  });
});
```

- [ ] **Step 2: Run and verify imports fail**

```bash
cd server
npm test -- --run tests/realtime-contract.test.ts
```

Expected: FAIL because the realtime modules do not exist.

- [ ] **Step 3: Create `types.ts`**

```ts
import type { UserRole } from '../auth/types.js';

export const REALTIME_EVENT_TYPES = [
  'job.created',
  'job.assignment_changed',
  'job.accepted',
  'job.started',
  'job.submitted_for_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
  'job.updated',
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];
export type RealtimeAudienceRole = Extract<UserRole, 'ADMIN' | 'MANAGER'>;

export type RealtimeAudience = Readonly<{
  roles: readonly RealtimeAudienceRole[];
  userIds: readonly string[];
}>;

export type RealtimeEventInput = Readonly<{
  organizationId: string;
  sourceActivityId: string;
  type: RealtimeEventType;
  entityType: 'job-card';
  entityId: string;
  actorUserId: string | null;
  audience: RealtimeAudience;
  resourceKeys: readonly string[];
  occurredAt: Date;
}>;

export type RealtimeEventRecord = RealtimeEventInput & Readonly<{
  id: bigint;
}>;

export type RealtimeViewer = Readonly<{
  organizationId: string;
  userId: string;
  role: UserRole;
}>;

export type RealtimeChangeEnvelope = Readonly<{
  id: string;
  type: RealtimeEventType;
  entity: Readonly<{ type: 'job-card'; id: string }>;
  resourceKeys: readonly string[];
  occurredAt: string;
}>;

export type RealtimeSyncRequiredEnvelope = Readonly<{
  id: string;
  type: 'sync.required';
  resourceKeys: readonly ['workspace'];
  occurredAt: string;
}>;

export type RealtimeEventEnvelope =
  | RealtimeChangeEnvelope
  | RealtimeSyncRequiredEnvelope;

export function presentRealtimeEvent(
  event: RealtimeEventRecord,
): RealtimeChangeEnvelope {
  return {
    id: event.id.toString(),
    type: event.type,
    entity: { type: event.entityType, id: event.entityId },
    resourceKeys: event.resourceKeys,
    occurredAt: event.occurredAt.toISOString(),
  };
}
```

- [ ] **Step 4: Create `audience.ts`**

```ts
import type { JobCardActivityEvent } from '../job-cards/types.js';
import type {
  RealtimeAudience,
  RealtimeEventRecord,
  RealtimeViewer,
} from './types.js';

type AudienceInput = Readonly<{
  event: JobCardActivityEvent;
  beforeAssigneeId: string | null;
  afterAssigneeId: string;
}>;

export function buildJobCardAudience(
  input: AudienceInput,
): RealtimeAudience {
  const userIds = new Set<string>([input.afterAssigneeId]);
  if (input.event === 'JOB_ASSIGNED' && input.beforeAssigneeId) {
    userIds.add(input.beforeAssigneeId);
  }
  return {
    roles: ['ADMIN', 'MANAGER'],
    userIds: [...userIds].sort(),
  };
}

export function canViewRealtimeEvent(
  viewer: RealtimeViewer,
  event: Pick<
    RealtimeEventRecord,
    'organizationId' | 'audience'
  >,
): boolean {
  if (viewer.organizationId !== event.organizationId) return false;
  return event.audience.roles.includes(
    viewer.role as 'ADMIN' | 'MANAGER',
  ) || event.audience.userIds.includes(viewer.userId);
}
```

- [ ] **Step 5: Create `event-mapper.ts`**

```ts
import type { JobCardActivityEvent } from '../job-cards/types.js';
import { buildJobCardAudience } from './audience.js';
import type {
  RealtimeEventInput,
  RealtimeEventType,
} from './types.js';

type MappingInput = Readonly<{
  activityId: string;
  organizationId: string;
  jobCardId: string;
  actorUserId: string | null;
  event: JobCardActivityEvent;
  occurredAt: Date;
  beforeAssigneeId: string | null;
  afterAssigneeId: string;
}>;

const TYPES: Partial<Record<JobCardActivityEvent, RealtimeEventType>> = {
  JOB_CREATED: 'job.created',
  JOB_ASSIGNED: 'job.assignment_changed',
  JOB_PLANNED: 'job.updated',
  JOB_ACCEPTED: 'job.accepted',
  JOB_STARTED: 'job.started',
  JOB_SUBMITTED_FOR_APPROVAL: 'job.submitted_for_approval',
  JOB_APPROVED: 'job.approved',
  JOB_REVISION_REQUESTED: 'job.revision_requested',
  JOB_RESUMED: 'job.updated',
  JOB_CANCELLED: 'job.cancelled',
  JOB_FIELDS_UPDATED: 'job.updated',
  JOB_APPROVAL_WITHDRAWN: 'job.updated',
};

const APPROVAL_EVENTS = new Set<JobCardActivityEvent>([
  'JOB_SUBMITTED_FOR_APPROVAL',
  'JOB_APPROVED',
  'JOB_REVISION_REQUESTED',
  'JOB_CANCELLED',
  'JOB_APPROVAL_WITHDRAWN',
]);

export function mapJobCardActivityToRealtime(
  input: MappingInput,
): RealtimeEventInput | null {
  const type = TYPES[input.event];
  if (!type) return null;

  const keys = new Set<string>([
    'job-board',
    `job-detail:${input.jobCardId}`,
    'job-list',
    'reports',
    `staff-profile:${input.afterAssigneeId}`,
  ]);
  if (input.beforeAssigneeId) {
    keys.add(`staff-profile:${input.beforeAssigneeId}`);
  }
  if (APPROVAL_EVENTS.has(input.event)) {
    keys.add('approval-queue');
  }

  return {
    organizationId: input.organizationId,
    sourceActivityId: input.activityId,
    type,
    entityType: 'job-card',
    entityId: input.jobCardId,
    actorUserId: input.actorUserId,
    audience: buildJobCardAudience({
      event: input.event,
      beforeAssigneeId: input.beforeAssigneeId,
      afterAssigneeId: input.afterAssigneeId,
    }),
    resourceKeys: [...keys].sort(),
    occurredAt: input.occurredAt,
  };
}
```

- [ ] **Step 6: Run contract tests**

```bash
npm test -- --run tests/realtime-contract.test.ts
npm run build
```

Expected: tests and TypeScript build PASS.

- [ ] **Step 7: Commit**

```bash
cd ..
git add server/src/modules/realtime/types.ts \
        server/src/modules/realtime/audience.ts \
        server/src/modules/realtime/event-mapper.ts \
        server/tests/realtime-contract.test.ts
git commit -m "feat(server): define realtime event contracts"
```

---

### Task 4: Implement PostgreSQL append, replay, and high-water queries

**Files:**
- Create: `server/src/modules/realtime/repository.ts`
- Create: `server/tests/realtime-repository.test.ts`

**Interfaces:**
- Consumes:
  - `RealtimeEventInput`, `RealtimeEventRecord`, `RealtimeViewer`.
  - `Pool`, `PoolClient`, and a query-capable transaction.
- Produces:
  - `RealtimeEventTransaction.append(input): Promise<RealtimeEventRecord>`
  - `PostgresRealtimeEventTransaction`
  - `RealtimeEventRepository.replayVisible(viewer, afterId, limit)`
  - `RealtimeEventRepository.visibleHighWater(viewer)`
  - `PostgresRealtimeEventRepository`

- [ ] **Step 1: Write failing repository tests with a query spy**

Create `server/tests/realtime-repository.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  PostgresRealtimeEventRepository,
  PostgresRealtimeEventTransaction,
} from '../src/modules/realtime/repository.js';

const row = {
  id: '42',
  organization_id: 'org-1',
  source_activity_id: 'activity-1',
  event_type: 'job.started',
  entity_type: 'job-card',
  entity_id: 'job-1',
  actor_user_id: 'staff-1',
  audience_roles: ['ADMIN', 'MANAGER'],
  audience_user_ids: ['staff-1'],
  resource_keys: ['job-board', 'job-detail:job-1', 'job-list'],
  created_at: new Date('2026-07-19T14:30:00.000Z'),
};

describe('Postgres realtime repository', () => {
  it('appends an event and maps bigint IDs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const tx = new PostgresRealtimeEventTransaction({ query } as never);

    const event = await tx.append({
      organizationId: 'org-1',
      sourceActivityId: 'activity-1',
      type: 'job.started',
      entityType: 'job-card',
      entityId: 'job-1',
      actorUserId: 'staff-1',
      audience: { roles: ['ADMIN', 'MANAGER'], userIds: ['staff-1'] },
      resourceKeys: ['job-board', 'job-detail:job-1', 'job-list'],
      occurredAt: new Date('2026-07-19T14:30:00.000Z'),
    });

    expect(event.id).toBe(42n);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO realtime_events'),
      expect.arrayContaining(['activity-1', 'job.started']),
    );
  });

  it('filters replay by organization, role, or explicit user ID', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const repository = new PostgresRealtimeEventRepository(
      { query } as never,
    );

    await repository.replayVisible(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      40n,
      501,
    );

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('$2 = ANY(audience_roles)');
    expect(sql).toContain('$3 = ANY(audience_user_ids)');
    expect(sql).toContain('id > $4');
    expect(sql).toContain('ORDER BY id ASC');
    expect(values).toEqual(['org-1', 'STAFF', 'staff-1', '40', 501]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd server
npm test -- --run tests/realtime-repository.test.ts
```

Expected: FAIL because `realtime/repository.ts` does not exist.

- [ ] **Step 3: Implement `repository.ts`**

```ts
import type { Pool, PoolClient } from 'pg';

import type {
  RealtimeEventInput,
  RealtimeEventRecord,
  RealtimeEventType,
  RealtimeViewer,
} from './types.js';

type EventRow = {
  id: string;
  organization_id: string;
  source_activity_id: string;
  event_type: RealtimeEventType;
  entity_type: 'job-card';
  entity_id: string;
  actor_user_id: string | null;
  audience_roles: ('ADMIN' | 'MANAGER')[];
  audience_user_ids: string[];
  resource_keys: string[];
  created_at: Date;
};

const COLUMNS = `id, organization_id, source_activity_id, event_type,
  entity_type, entity_id, actor_user_id, audience_roles,
  audience_user_ids, resource_keys, created_at`;

function mapEvent(row: EventRow): RealtimeEventRecord {
  return {
    id: BigInt(row.id),
    organizationId: row.organization_id,
    sourceActivityId: row.source_activity_id,
    type: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    audience: {
      roles: row.audience_roles,
      userIds: row.audience_user_ids,
    },
    resourceKeys: row.resource_keys,
    occurredAt: row.created_at,
  };
}

export interface RealtimeEventTransaction {
  append(input: RealtimeEventInput): Promise<RealtimeEventRecord>;
}

export class PostgresRealtimeEventTransaction
implements RealtimeEventTransaction {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async append(input: RealtimeEventInput): Promise<RealtimeEventRecord> {
    const result = await this.client.query<EventRow>(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id, event_type, entity_type,
         entity_id, actor_user_id, audience_roles, audience_user_ids,
         resource_keys, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${COLUMNS}`,
      [
        input.organizationId,
        input.sourceActivityId,
        input.type,
        input.entityType,
        input.entityId,
        input.actorUserId,
        input.audience.roles,
        input.audience.userIds,
        input.resourceKeys,
        input.occurredAt,
      ],
    );
    return mapEvent(result.rows[0]!);
  }
}

export interface RealtimeEventRepository {
  replayVisible(
    viewer: RealtimeViewer,
    afterId: bigint,
    limit: number,
  ): Promise<RealtimeEventRecord[]>;
  visibleHighWater(viewer: RealtimeViewer): Promise<bigint>;
}

export class PostgresRealtimeEventRepository
implements RealtimeEventRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async replayVisible(
    viewer: RealtimeViewer,
    afterId: bigint,
    limit: number,
  ): Promise<RealtimeEventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT ${COLUMNS}
         FROM realtime_events
        WHERE organization_id = $1
          AND ($2 = ANY(audience_roles) OR $3 = ANY(audience_user_ids))
          AND id > $4
        ORDER BY id ASC
        LIMIT $5`,
      [
        viewer.organizationId,
        viewer.role,
        viewer.userId,
        afterId.toString(),
        limit,
      ],
    );
    return result.rows.map(mapEvent);
  }

  async visibleHighWater(viewer: RealtimeViewer): Promise<bigint> {
    const result = await this.pool.query<{ id: string | null }>(
      `SELECT MAX(id)::text AS id
         FROM realtime_events
        WHERE organization_id = $1
          AND ($2 = ANY(audience_roles) OR $3 = ANY(audience_user_ids))`,
      [viewer.organizationId, viewer.role, viewer.userId],
    );
    return BigInt(result.rows[0]?.id ?? '0');
  }
}
```

- [ ] **Step 4: Run repository tests and build**

```bash
npm test -- --run tests/realtime-repository.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Add a real database uniqueness/rollback test**

Extend `server/tests/realtime-repository.test.ts` using the repository's existing PostgreSQL test setup pattern. The test must execute these exact assertions:

```ts
expect(first.sourceActivityId).toBe(activityId);
await expect(tx.append(sameInput)).rejects.toMatchObject({ code: '23505' });
await client.query('ROLLBACK');
const persisted = await pool.query(
  'SELECT COUNT(*)::int AS count FROM realtime_events WHERE source_activity_id=$1',
  [activityId],
);
expect(persisted.rows[0]!.count).toBe(0);
```

Use a fresh organization, user, JobCard, and activity fixture per test; never rely on development seed rows.

- [ ] **Step 6: Run against PostgreSQL**

```bash
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
npm test -- --run tests/realtime-repository.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ..
git add server/src/modules/realtime/repository.ts \
        server/tests/realtime-repository.test.ts
git commit -m "feat(server): persist and replay realtime events"
```

---

### Task 5: Return canonical activity IDs and expose transaction event append

**Files:**
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/tests/job-card-service.test.ts`
- Modify: `server/tests/realtime-repository.test.ts`

**Interfaces:**
- Consumes:
  - `RealtimeEventInput`, `RealtimeEventRecord`
  - `PostgresRealtimeEventTransaction`
- Produces:
  - `AppendedActivity = { id: string; createdAt: Date }`
  - `JobCardTransaction.appendActivity(input): Promise<AppendedActivity>`
  - `JobCardTransaction.appendRealtimeEvent(input): Promise<RealtimeEventRecord>`

- [ ] **Step 1: Update the memory repository test double first**

In `server/tests/job-card-service.test.ts`, replace the current `appendActivity` implementation with:

```ts
async appendActivity(input: ActivityInput) {
  this.activities.push({
    event: input.event,
    jobCardId: input.jobCardId,
    actorId: input.actorId,
    clientActionId: input.clientActionId ?? '',
  });
  return {
    id: `activity-${this.activities.length}`,
    createdAt: new Date('2026-07-19T14:30:00.000Z'),
  };
}

async appendRealtimeEvent() {
  throw new Error('appendRealtimeEvent not implemented');
}
```

Run:

```bash
cd server
npm test -- --run tests/job-card-service.test.ts
```

Expected: TypeScript/test collection FAIL because the production interface still expects `Promise<void>` and has no `appendRealtimeEvent`.

- [ ] **Step 2: Add the repository contracts**

In `server/src/modules/job-cards/repository.ts`, add:

```ts
import type {
  RealtimeEventInput,
  RealtimeEventRecord,
} from '../realtime/types.js';
import {
  PostgresRealtimeEventTransaction,
} from '../realtime/repository.js';

export type AppendedActivity = {
  id: string;
  createdAt: Date;
};
```

Change the transaction interface:

```ts
appendActivity(input: ActivityInput): Promise<AppendedActivity>;
appendRealtimeEvent(
  input: RealtimeEventInput,
): Promise<RealtimeEventRecord>;
```

Add this field to `PostgresJobCardTransaction`:

```ts
private readonly realtime: PostgresRealtimeEventTransaction;

constructor(private readonly client: PoolClient) {
  this.realtime = new PostgresRealtimeEventTransaction(client);
}
```

Replace `appendActivity` with:

```ts
async appendActivity(input: ActivityInput): Promise<AppendedActivity> {
  const result = await this.client.query<{
    id: string;
    created_at: Date;
  }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type,
        old_value, new_value, metadata, client_action_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, created_at`,
    [
      input.organizationId,
      input.jobCardId,
      input.actorId,
      input.event,
      input.oldValue ?? null,
      input.newValue ?? null,
      input.metadata ?? null,
      input.clientActionId ?? null,
    ],
  );
  return {
    id: result.rows[0]!.id,
    createdAt: result.rows[0]!.created_at,
  };
}

appendRealtimeEvent(input: RealtimeEventInput) {
  return this.realtime.append(input);
}
```

- [ ] **Step 3: Update every in-memory `JobCardTransaction` implementation**

Find all implementers:

```bash
grep -R "implements JobCardTransaction" -n server/tests server/src
grep -R "appendActivity" -n server/tests | cut -d: -f1 | sort -u
```

For each test double, return a deterministic `{ id, createdAt }` and add `appendRealtimeEvent` as a spy or deterministic fake. Do not use `as unknown as JobCardTransaction` to bypass the contract.

- [ ] **Step 4: Run the existing JobCard tests**

```bash
npm test -- --run \
  tests/job-card-service.test.ts \
  tests/job-card-routes.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Run the realtime repository test**

```bash
npm test -- --run tests/realtime-repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ..
git add server/src/modules/job-cards/repository.ts \
        server/tests/job-card-service.test.ts \
        server/tests
git commit -m "refactor(server): expose committed activity identity"
```

Before committing, verify `git diff --cached --name-only` contains no unrelated test rewrites.

---

### Task 6: Add the process-local realtime event bus

**Files:**
- Create: `server/src/modules/realtime/event-bus.ts`
- Create: `server/tests/realtime-event-bus.test.ts`

**Interfaces:**
- Consumes: `RealtimeEventRecord`.
- Produces:
  - `RealtimeEventPublisher.publish(event): void`
  - `RealtimeEventBus.subscribe(listener): () => void`
  - `InMemoryRealtimeEventBus`
  - `NOOP_REALTIME_EVENT_PUBLISHER`

- [ ] **Step 1: Write failing bus tests**

Create `server/tests/realtime-event-bus.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryRealtimeEventBus,
} from '../src/modules/realtime/event-bus.js';
import type {
  RealtimeEventRecord,
} from '../src/modules/realtime/types.js';

const event = {
  id: 1n,
  organizationId: 'org-1',
  sourceActivityId: 'activity-1',
  type: 'job.started',
  entityType: 'job-card',
  entityId: 'job-1',
  actorUserId: 'staff-1',
  audience: { roles: ['ADMIN', 'MANAGER'], userIds: ['staff-1'] },
  resourceKeys: ['job-board'],
  occurredAt: new Date('2026-07-19T14:30:00.000Z'),
} satisfies RealtimeEventRecord;

describe('InMemoryRealtimeEventBus', () => {
  it('isolates subscriber failures and supports unsubscribe', () => {
    const log = vi.fn();
    const bus = new InMemoryRealtimeEventBus(log);
    const broken = vi.fn(() => { throw new Error('broken subscriber'); });
    const healthy = vi.fn();
    const unsubscribe = bus.subscribe(broken);
    bus.subscribe(healthy);

    bus.publish(event);
    unsubscribe();
    bus.publish({ ...event, id: 2n });

    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd server
npm test -- --run tests/realtime-event-bus.test.ts
```

Expected: FAIL because `event-bus.ts` does not exist.

- [ ] **Step 3: Implement the bus**

Create `server/src/modules/realtime/event-bus.ts`:

```ts
import type { RealtimeEventRecord } from './types.js';

export type RealtimeEventListener = (
  event: RealtimeEventRecord,
) => void;

export interface RealtimeEventPublisher {
  publish(event: RealtimeEventRecord): void;
}

export interface RealtimeEventBus extends RealtimeEventPublisher {
  subscribe(listener: RealtimeEventListener): () => void;
}

export const NOOP_REALTIME_EVENT_PUBLISHER: RealtimeEventPublisher = {
  publish() {},
};

export class InMemoryRealtimeEventBus implements RealtimeEventBus {
  private readonly listeners = new Set<RealtimeEventListener>();

  constructor(
    private readonly logError: (error: unknown) => void = () => {},
  ) {}

  subscribe(listener: RealtimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: RealtimeEventRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logError(error);
      }
    }
  }
}
```

- [ ] **Step 4: Run test and build**

```bash
npm test -- --run tests/realtime-event-bus.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ..
git add server/src/modules/realtime/event-bus.ts \
        server/tests/realtime-event-bus.test.ts
git commit -m "feat(server): add realtime event bus"
```

---

### Task 7: Persist and publish covered JobCard events after commit

**Files:**
- Modify: `server/src/modules/job-cards/service.ts`
- Modify: `server/src/modules/job-cards/repository.ts`
- Modify: `server/tests/job-card-service.test.ts`
- Create: `server/tests/realtime-job-card-integration.test.ts`

**Interfaces:**
- Consumes:
  - `mapJobCardActivityToRealtime(input)`
  - `RealtimeEventPublisher`
  - `JobCardTransaction.appendActivity`
  - `JobCardTransaction.appendRealtimeEvent`
- Produces:
  - Critical-action result includes committed internal events only for `kind: 'completed'`.
  - JobCard service publishes those events after transaction commit.
  - Public REST responses remain unchanged.

- [ ] **Step 1: Write failing service tests for commit/replay behavior**

In `server/tests/job-card-service.test.ts`, add an event array and publisher:

```ts
const published: RealtimeEventRecord[] = [];
const publisher: RealtimeEventPublisher = {
  publish(event) {
    published.push(event);
  },
};
```

Instantiate:

```ts
const service = new JobCardService(
  repository,
  () => new Date('2026-07-19T14:30:00.000Z'),
  publisher,
);
```

Add tests:

```ts
it('persists and publishes submission after successful commit', async () => {
  await service.submitForApproval(staff, 'job-1', {
    expectedVersion: 1,
    clientActionId: 'action-1',
    note: 'Teslim tamamlandı.',
  });

  expect(repository.realtimeEvents).toHaveLength(1);
  expect(repository.realtimeEvents[0]).toMatchObject({
    type: 'job.submitted_for_approval',
    entityId: 'job-1',
    sourceActivityId: 'activity-1',
  });
  expect(published).toEqual(repository.realtimeEvents);
});

it('does not publish an idempotent replay', async () => {
  repository.nextCriticalResult = 'replay';

  await service.submitForApproval(staff, 'job-1', {
    expectedVersion: 1,
    clientActionId: 'action-1',
    note: 'Teslim tamamlandı.',
  });

  expect(published).toEqual([]);
});

it('does not persist or publish excluded note events', async () => {
  await service.addNote(staff, 'job-1', { note: 'Kapıya bırakıldı.' });

  expect(repository.realtimeEvents).toEqual([]);
  expect(published).toEqual([]);
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd server
npm test -- --run tests/job-card-service.test.ts
```

Expected: FAIL because the service has no publisher or event persistence.

- [ ] **Step 3: Extend critical-action internal results without changing public DTOs**

In `server/src/modules/job-cards/repository.ts`, define:

```ts
export type CriticalActionWorkResult<T> = Readonly<{
  response: T;
  realtimeEvents: readonly RealtimeEventRecord[];
}>;

export type CriticalActionResult<T> =
  | {
      kind: 'completed';
      response: T;
      realtimeEvents: readonly RealtimeEventRecord[];
    }
  | {
      kind: 'replay';
      response: T;
      realtimeEvents: readonly [];
    }
  | { kind: 'processing' };
```

Change `executeCriticalAction`:

```ts
executeCriticalAction<T>(
  claim: CriticalActionClaim,
  work: (
    transaction: JobCardTransaction,
  ) => Promise<CriticalActionWorkResult<T>>,
): Promise<CriticalActionResult<T>>;
```

In the PostgreSQL implementation:

- Persist only `workResult.response` in the idempotency record.
- Commit the transaction.
- Return `{ kind: 'completed', response, realtimeEvents }`.
- On stored-response replay return `{ kind: 'replay', response, realtimeEvents: [] }`.
- On processing return `{ kind: 'processing' }`.

Do not serialize `RealtimeEventRecord` or `bigint` into the idempotency response column.

- [ ] **Step 4: Add service helpers**

At the top of `server/src/modules/job-cards/service.ts`:

```ts
import {
  mapJobCardActivityToRealtime,
} from '../realtime/event-mapper.js';
import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import type {
  RealtimeEventRecord,
} from '../realtime/types.js';
```

Preserve the existing second constructor parameter:

```ts
constructor(
  private readonly repository: JobCardRepository,
  private readonly now: () => Date = () => new Date(),
  private readonly realtimePublisher: RealtimeEventPublisher =
    NOOP_REALTIME_EVENT_PUBLISHER,
) {
  this.notesService = new JobCardNotesService(repository);
}
```

Add:

```ts
private publishRealtime(events: readonly RealtimeEventRecord[]) {
  for (const event of events) {
    this.realtimePublisher.publish(event);
  }
}

private async appendRealtimeForActivity(
  transaction: JobCardTransaction,
  input: {
    activity: AppendedActivity;
    organizationId: string;
    jobCardId: string;
    actorUserId: string;
    event: JobCardActivityEvent;
    beforeAssigneeId: string | null;
    afterAssigneeId: string;
  },
): Promise<RealtimeEventRecord[]> {
  const mapped = mapJobCardActivityToRealtime({
    activityId: input.activity.id,
    organizationId: input.organizationId,
    jobCardId: input.jobCardId,
    actorUserId: input.actorUserId,
    event: input.event,
    occurredAt: input.activity.createdAt,
    beforeAssigneeId: input.beforeAssigneeId,
    afterAssigneeId: input.afterAssigneeId,
  });
  return mapped ? [await transaction.appendRealtimeEvent(mapped)] : [];
}
```

Import `AppendedActivity` from the JobCard repository types.

- [ ] **Step 5: Integrate creation**

Inside the existing creation transaction:

```ts
const activity = await transaction.appendActivity({
  organizationId: actor.organizationId,
  jobCardId: job.id,
  actorId: actor.id,
  event: 'JOB_CREATED',
  clientActionId: input.clientActionId,
  newValue: createdValue,
});
const realtimeEvents = await this.appendRealtimeForActivity(transaction, {
  activity,
  organizationId: actor.organizationId,
  jobCardId: job.id,
  actorUserId: actor.id,
  event: 'JOB_CREATED',
  beforeAssigneeId: null,
  afterAssigneeId: job.assignedTo,
});
const detail = await transaction.getJobDetail(
  actor.organizationId,
  job.id,
);
if (!detail) {
  throw new AppError(
    'JOB_CARD_NOT_FOUND',
    404,
    'JobCard bulunamadı.',
  );
}
return {
  response: await this.presentDetail(
    transaction,
    actor,
    detail,
    requestTime,
  ),
  realtimeEvents,
};
```

After `executeCriticalAction`:

```ts
if (result.kind === 'processing') {
  throw new AppError(
    'ACTION_IN_PROGRESS',
    409,
    'Aynı işlem halen devam ediyor.',
  );
}
if (result.kind === 'completed') {
  this.publishRealtime(result.realtimeEvents);
}
return result.response;
```

- [ ] **Step 6: Integrate base patch/reassignment**

For the base-field patch transaction:

1. Read the current JobCard before mutation.
2. Apply the versioned update.
3. Keep the existing activity event selection.
4. Capture the returned activity.
5. Map with `beforeAssigneeId: current.assignedTo` and `afterAssigneeId: updated.assignedTo`.
6. Return `{ response, realtimeEvents }` from the transaction.
7. Publish only after `executeTransaction(...)` resolves successfully.

The exact return shape:

```ts
const committed = await this.repository.executeTransaction(
  async (transaction) => {
    // existing validation and mutation
    const activity = await transaction.appendActivity(activityInput);
    const realtimeEvents = await this.appendRealtimeForActivity(
      transaction,
      {
        activity,
        organizationId: actor.organizationId,
        jobCardId,
        actorUserId: actor.id,
        event: activityInput.event,
        beforeAssigneeId: current.assignedTo,
        afterAssigneeId: updated.assignedTo,
      },
    );
    return { response: presented, realtimeEvents };
  },
);
this.publishRealtime(committed.realtimeEvents);
return committed.response;
```

A rejected version conflict or rolled-back transaction never reaches `publishRealtime`.

- [ ] **Step 7: Integrate every lifecycle definition**

In the shared lifecycle execution path, replace the standalone activity append with:

```ts
const activity = await transaction.appendActivity({
  organizationId: actor.organizationId,
  jobCardId,
  actorId: actor.id,
  event: definition.event,
  clientActionId: input.clientActionId,
  oldValue,
  newValue,
  metadata,
});
const realtimeEvents = await this.appendRealtimeForActivity(
  transaction,
  {
    activity,
    organizationId: actor.organizationId,
    jobCardId,
    actorUserId: actor.id,
    event: definition.event,
    beforeAssigneeId: current.assignedTo,
    afterAssigneeId: updated.assignedTo,
  },
);
return { response: presented, realtimeEvents };
```

After the critical action:

```ts
if (result.kind === 'completed') {
  this.publishRealtime(result.realtimeEvents);
}
return result.response;
```

This covers accept, start, submit, approve, request revision, withdraw approval, resume, and cancel through the existing shared definition table.

- [ ] **Step 8: Update all critical-action memory doubles**

Every test repository must:

- store only `.response` for replay,
- return `realtimeEvents` only for completed work,
- return `realtimeEvents: []` for replay.

Use this exact pattern:

```ts
const completed = await work(this);
if (this.nextCriticalResult === 'replay') {
  return {
    kind: 'replay' as const,
    response: completed.response,
    realtimeEvents: [] as const,
  };
}
return {
  kind: 'completed' as const,
  response: completed.response,
  realtimeEvents: completed.realtimeEvents,
};
```

- [ ] **Step 9: Run focused tests**

```bash
npm test -- --run \
  tests/job-card-service.test.ts \
  tests/job-card-routes.test.ts \
  tests/realtime-contract.test.ts \
  tests/realtime-repository.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 10: Add the real transaction integration test**

Create `server/tests/realtime-job-card-integration.test.ts` following the repository's existing PostgreSQL fixture pattern. Cover these exact scenarios:

```ts
it('commits activity and realtime event together', async () => {
  // create fixture JobCard and execute START
  // assert one JOB_STARTED activity
  // assert one realtime_events row with source_activity_id = activity.id
});

it('rolls back both rows when event insertion fails', async () => {
  // force a duplicate source_activity_id inside the transaction
  // assert JobCard version/status unchanged
  // assert no additional activity or realtime row
});

it('does not create a second event on idempotent replay', async () => {
  // execute the same clientActionId twice
  // assert one activity and one realtime event
  // assert publisher called once
});
```

Use SQL assertions, not only mocks.

- [ ] **Step 11: Run integration test**

```bash
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
npm test -- --run tests/realtime-job-card-integration.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
cd ..
git add server/src/modules/job-cards/repository.ts \
        server/src/modules/job-cards/service.ts \
        server/tests/job-card-service.test.ts \
        server/tests/realtime-job-card-integration.test.ts \
        server/tests
git commit -m "feat(server): emit committed JobCard events"
```

---

### Task 8: Implement replay/live handoff and overflow reconciliation

**Files:**
- Create: `server/src/modules/realtime/service.ts`
- Create: `server/tests/realtime-service.test.ts`

**Interfaces:**
- Consumes:
  - `RealtimeEventRepository`
  - `RealtimeEventBus`
  - `canViewRealtimeEvent`
  - `presentRealtimeEvent`
- Produces:
  - `RealtimeStreamSink`
  - `RealtimeSubscription`
  - `RealtimeService.open(viewer, cursor, sink)`
  - replay limit `500`, query limit `501`
  - first-connect and overflow `sync.required`

- [ ] **Step 1: Write failing service tests**

Create `server/tests/realtime-service.test.ts` with deterministic fakes:

```ts
import { describe, expect, it } from 'vitest';

import {
  InMemoryRealtimeEventBus,
} from '../src/modules/realtime/event-bus.js';
import {
  RealtimeService,
} from '../src/modules/realtime/service.js';
import type {
  RealtimeEventRecord,
} from '../src/modules/realtime/types.js';

function event(id: bigint): RealtimeEventRecord {
  return {
    id,
    organizationId: 'org-1',
    sourceActivityId: `activity-${id}`,
    type: 'job.started',
    entityType: 'job-card',
    entityId: 'job-1',
    actorUserId: 'staff-1',
    audience: {
      roles: ['ADMIN', 'MANAGER'],
      userIds: ['staff-1'],
    },
    resourceKeys: ['job-board'],
    occurredAt: new Date('2026-07-19T14:30:00.000Z'),
  };
}

describe('RealtimeService', () => {
  it('sends sync.required at visible high-water on first connect', async () => {
    const repository = {
      visibleHighWater: async () => 12n,
      replayVisible: async () => [],
    };
    const sent: unknown[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'manager-1', role: 'MANAGER' },
      null,
      { send: async (value) => { sent.push(value); } },
    );

    expect(sent).toEqual([{
      id: '12',
      type: 'sync.required',
      resourceKeys: ['workspace'],
      occurredAt: expect.any(String),
    }]);
    subscription.close();
  });

  it('buffers live events while replay is loading without gaps', async () => {
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const bus = new InMemoryRealtimeEventBus();
    const repository = {
      visibleHighWater: async () => 3n,
      replayVisible: async () => {
        await replayGate;
        return [event(2n), event(3n)];
      },
    };
    const sent: string[] = [];
    const service = new RealtimeService(repository, bus);

    const opening = service.open(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      1n,
      { send: async (value) => { sent.push(value.id); } },
    );
    bus.publish(event(4n));
    releaseReplay();

    const subscription = await opening;
    expect(sent).toEqual(['2', '3', '4']);
    subscription.close();
  });

  it('emits sync.required instead of more than 500 replay events', async () => {
    const repository = {
      visibleHighWater: async () => 900n,
      replayVisible: async () =>
        Array.from({ length: 501 }, (_, index) =>
          event(BigInt(index + 1))),
    };
    const sent: unknown[] = [];
    const service = new RealtimeService(
      repository,
      new InMemoryRealtimeEventBus(),
    );

    const subscription = await service.open(
      { organizationId: 'org-1', userId: 'manager-1', role: 'MANAGER' },
      0n,
      { send: async (value) => { sent.push(value); } },
    );

    expect(sent).toEqual([{
      id: '900',
      type: 'sync.required',
      resourceKeys: ['workspace'],
      occurredAt: expect.any(String),
    }]);
    subscription.close();
  });
});
```

- [ ] **Step 2: Run and verify failure**

```bash
cd server
npm test -- --run tests/realtime-service.test.ts
```

Expected: FAIL because `service.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `server/src/modules/realtime/service.ts`:

```ts
import { canViewRealtimeEvent } from './audience.js';
import type { RealtimeEventBus } from './event-bus.js';
import type {
  RealtimeEventRepository,
} from './repository.js';
import {
  presentRealtimeEvent,
  type RealtimeEventEnvelope,
  type RealtimeEventRecord,
  type RealtimeViewer,
} from './types.js';

const MAX_REPLAY = 500;

export interface RealtimeStreamSink {
  send(event: RealtimeEventEnvelope): Promise<void>;
  close?(): void;
}

export interface RealtimeSubscription {
  close(): void;
}

export class RealtimeService {
  constructor(
    private readonly repository: RealtimeEventRepository,
    private readonly bus: RealtimeEventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(
    viewer: RealtimeViewer,
    cursor: bigint | null,
    sink: RealtimeStreamSink,
  ): Promise<RealtimeSubscription> {
    let closed = false;
    let replaying = true;
    let writeChain = Promise.resolve();
    let lastSent = cursor ?? 0n;
    const buffered = new Map<bigint, RealtimeEventRecord>();

    const send = (event: RealtimeEventEnvelope) => {
      writeChain = writeChain.then(async () => {
        if (!closed) await sink.send(event);
      });
      return writeChain;
    };

    const unsubscribe = this.bus.subscribe((event) => {
      if (closed || !canViewRealtimeEvent(viewer, event)) return;
      if (event.id <= lastSent) return;
      if (replaying) {
        buffered.set(event.id, event);
        return;
      }
      lastSent = event.id;
      void send(presentRealtimeEvent(event));
    });

    try {
      if (cursor === null) {
        const highWater = await this.repository.visibleHighWater(viewer);
        lastSent = highWater;
        await send({
          id: highWater.toString(),
          type: 'sync.required',
          resourceKeys: ['workspace'],
          occurredAt: this.now().toISOString(),
        });
      } else {
        const replay = await this.repository.replayVisible(
          viewer,
          cursor,
          MAX_REPLAY + 1,
        );
        if (replay.length > MAX_REPLAY) {
          const highWater = await this.repository.visibleHighWater(viewer);
          lastSent = highWater;
          await send({
            id: highWater.toString(),
            type: 'sync.required',
            resourceKeys: ['workspace'],
            occurredAt: this.now().toISOString(),
          });
        } else {
          for (const event of replay) {
            if (event.id <= lastSent) continue;
            lastSent = event.id;
            await send(presentRealtimeEvent(event));
          }
        }
      }

      for (const event of [...buffered.values()].sort(
        (left, right) => left.id < right.id ? -1 : 1,
      )) {
        if (event.id <= lastSent) continue;
        lastSent = event.id;
        await send(presentRealtimeEvent(event));
      }
      buffered.clear();
      replaying = false;
    } catch (error) {
      closed = true;
      unsubscribe();
      sink.close?.();
      throw error;
    }

    return {
      close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        sink.close?.();
      },
    };
  }
}
```

- [ ] **Step 4: Add slow/failing sink tests**

Extend the test file:

```ts
it('closes and unsubscribes when replay send fails', async () => {
  const bus = new InMemoryRealtimeEventBus();
  const repository = {
    visibleHighWater: async () => 1n,
    replayVisible: async () => [event(1n)],
  };
  let closed = 0;
  const service = new RealtimeService(repository, bus);

  await expect(service.open(
    { organizationId: 'org-1', userId: 'manager-1', role: 'MANAGER' },
    0n,
    {
      send: async () => { throw new Error('closed socket'); },
      close: () => { closed += 1; },
    },
  )).rejects.toThrow('closed socket');

  expect(closed).toBe(1);
});
```

- [ ] **Step 5: Run tests and build**

```bash
npm test -- --run tests/realtime-service.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ..
git add server/src/modules/realtime/service.ts \
        server/tests/realtime-service.test.ts
git commit -m "feat(server): coordinate realtime replay and live events"
```

---

### Task 9: Add the authenticated SSE route

**Files:**
- Create: `server/src/modules/realtime/routes.ts`
- Create: `server/tests/realtime-routes.test.ts`

**Interfaces:**
- Consumes:
  - `RealtimeService.open(viewer, cursor, sink)`
  - existing Fastify `preHandlerHookHandler`
  - `request.currentUser`
- Produces:
  - `GET /api/realtime/events`
  - SSE event name `servora.change`
  - 20-second heartbeat comments
  - strict `Last-Event-ID` parser

- [ ] **Step 1: Write failing route tests**

Create `server/tests/realtime-routes.test.ts`:

```ts
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  realtimeRoutes,
} from '../src/modules/realtime/routes.js';

const apps: Awaited<ReturnType<typeof Fastify>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('realtime SSE route', () => {
  it('rejects an invalid Last-Event-ID before opening the stream', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    const open = vi.fn();
    await app.register(realtimeRoutes, {
      service: { open } as never,
      authenticate: async (
        request: FastifyRequest,
        _reply: FastifyReply,
      ) => {
        request.currentUser = {
          id: 'manager-1',
          organizationId: 'org-1',
          role: 'MANAGER',
          mustChangePassword: false,
        } as never;
      },
      heartbeatMs: 20_000,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { 'last-event-id': 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(open).not.toHaveBeenCalled();
  });

  it('formats change events as SSE frames', async () => {
    const writes: string[] = [];
    const raw = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      on: vi.fn(),
      end: vi.fn(),
    };
    const reply = {
      hijack: vi.fn(),
      raw,
    };
    const service = {
      open: vi.fn(async (_viewer, _cursor, sink) => {
        await sink.send({
          id: '42',
          type: 'job.started',
          entity: { type: 'job-card', id: 'job-1' },
          resourceKeys: ['job-board'],
          occurredAt: '2026-07-19T14:30:00.000Z',
        });
        return { close: vi.fn() };
      }),
    };

    await createRealtimeHandler(service as never, 20_000)(
      {
        headers: {},
        currentUser: {
          id: 'manager-1',
          organizationId: 'org-1',
          role: 'MANAGER',
        },
        raw: { on: vi.fn() },
      } as never,
      reply as never,
    );

    expect(raw.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream; charset=utf-8',
    );
    expect(writes.join('')).toContain('id: 42\n');
    expect(writes.join('')).toContain('event: servora.change\n');
    expect(writes.join('')).toContain('"type":"job.started"');
  });
});
```

The route module must export `createRealtimeHandler` for direct deterministic handler tests.

- [ ] **Step 2: Run and verify failure**

```bash
cd server
npm test -- --run tests/realtime-routes.test.ts
```

Expected: FAIL because `routes.ts` does not exist.

- [ ] **Step 3: Implement strict cursor parsing and frame serialization**

Create `server/src/modules/realtime/routes.ts`:

```ts
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

import { AppError } from '../../errors/index.js';
import type { RealtimeService } from './service.js';
import type {
  RealtimeEventEnvelope,
} from './types.js';

type Options = {
  service: RealtimeService;
  authenticate: preHandlerHookHandler;
  heartbeatMs?: number;
};

function parseCursor(value: unknown): bigint | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string'
    || !/^(0|[1-9]\d*)$/.test(value)
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Last-Event-ID geçersiz.',
    );
  }
  return BigInt(value);
}

function frame(event: RealtimeEventEnvelope): string {
  return `id: ${event.id}\nevent: servora.change\ndata: ${
    JSON.stringify(event)
  }\n\n`;
}

export function createRealtimeHandler(
  service: RealtimeService,
  heartbeatMs = 20_000,
) {
  return async function realtimeHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const currentUser = request.currentUser!;
    const cursor = parseCursor(request.headers['last-event-id']);

    reply.hijack();
    reply.raw.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8',
    );
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    let subscription: { close(): void } | undefined;
    let writeChain = Promise.resolve();
    let closed = false;

    const write = (chunk: string) => {
      writeChain = writeChain.then(async () => {
        if (closed) return;
        const accepted = reply.raw.write(chunk);
        if (!accepted) {
          await new Promise<void>((resolve) => {
            reply.raw.once('drain', resolve);
          });
        }
      });
      return writeChain;
    };

    const heartbeat = setInterval(() => {
      void write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription?.close();
      if (!reply.raw.destroyed) reply.raw.end();
    };

    request.raw.once('close', close);
    request.raw.once('aborted', close);

    try {
      subscription = await service.open(
        {
          organizationId: currentUser.organizationId,
          userId: currentUser.id,
          role: currentUser.role,
        },
        cursor,
        {
          send: (event) => write(frame(event)),
          close,
        },
      );
    } catch (error) {
      close();
      request.log.error(
        { err: error },
        'Realtime stream failed',
      );
    }
  };
}

export const realtimeRoutes: FastifyPluginAsync<Options> = async (
  app,
  options,
) => {
  app.get(
    '/events',
    { preHandler: options.authenticate },
    createRealtimeHandler(
      options.service,
      options.heartbeatMs ?? 20_000,
    ),
  );
};
```

- [ ] **Step 4: Correct the test raw response contract**

Fastify's real raw response uses `once`. Ensure the test double includes:

```ts
once: vi.fn(),
destroyed: false,
```

The route must never set CORS or authentication itself; those remain app-level/existing middleware responsibilities.

- [ ] **Step 5: Run route tests**

```bash
npm test -- --run tests/realtime-routes.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ..
git add server/src/modules/realtime/routes.ts \
        server/tests/realtime-routes.test.ts
git commit -m "feat(server): expose authenticated SSE stream"
```

---

### Task 10: Wire realtime dependencies into Fastify and production startup

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/tests/app.test.ts`
- Modify: `server/tests/realtime-routes.test.ts`

**Interfaces:**
- Consumes:
  - `RealtimeService`
  - `RealtimeEventPublisher`
  - `PostgresRealtimeEventRepository`
  - `InMemoryRealtimeEventBus`
- Produces:
  - optional `AppDependencies.realtimeService`
  - optional `AppDependencies.realtimePublisher`
  - production singleton bus/service per Fastify process
  - registered `/api/realtime/events`

- [ ] **Step 1: Write failing app wiring tests**

Add to `server/tests/app.test.ts`:

```ts
it('does not expose realtime routes without realtime dependencies', async () => {
  const app = await buildApp(testConfig);
  apps.push(app);

  const response = await app.inject({
    method: 'GET',
    url: '/api/realtime/events',
  });

  expect(response.statusCode).toBe(404);
});

it('registers the realtime route when auth and service exist', async () => {
  const app = await buildApp(testConfig, {
    authRepository: authRepositoryDouble(),
    realtimeService: {
      open: async () => ({ close() {} }),
    } as never,
  });
  apps.push(app);

  const response = await app.inject({
    method: 'GET',
    url: '/api/realtime/events',
  });

  expect(response.statusCode).toBe(401);
});
```

Use the existing authenticated app test double rather than introducing a second session implementation.

- [ ] **Step 2: Run and verify failure**

```bash
cd server
npm test -- --run tests/app.test.ts
```

Expected: FAIL because `AppDependencies` has no `realtimeService`.

- [ ] **Step 3: Extend `AppDependencies` and register route**

In `server/src/app.ts`, import types and route:

```ts
import type {
  RealtimeEventPublisher,
} from './modules/realtime/event-bus.js';
import type {
  RealtimeService,
} from './modules/realtime/service.js';
import {
  realtimeRoutes,
} from './modules/realtime/routes.js';
```

Add:

```ts
realtimeService?: RealtimeService;
realtimePublisher?: RealtimeEventPublisher;
```

Construct JobCard service without changing existing defaults:

```ts
const jobCardService = new JobCardService(
  dependencies.jobCardRepository,
  undefined,
  dependencies.realtimePublisher,
);
```

After creating `authenticateDomain`, register:

```ts
if (dependencies.realtimeService) {
  await app.register(realtimeRoutes, {
    prefix: '/api/realtime',
    service: dependencies.realtimeService,
    authenticate: authenticateDomain,
  });
}
```

The stream therefore uses both `requireAuthentication` and `requirePasswordChanged`.

- [ ] **Step 4: Wire production singletons in `server/src/index.ts`**

Add imports:

```ts
import {
  InMemoryRealtimeEventBus,
} from './modules/realtime/event-bus.js';
import {
  PostgresRealtimeEventRepository,
} from './modules/realtime/repository.js';
import {
  RealtimeService,
} from './modules/realtime/service.js';
```

Before `buildApp`:

```ts
const realtimeBus = new InMemoryRealtimeEventBus((error) => {
  app?.log.error(
    { err: error },
    'Realtime subscriber failed',
  );
});
const realtimeRepository = new PostgresRealtimeEventRepository(
  database.pool,
);
const realtimeService = new RealtimeService(
  realtimeRepository,
  realtimeBus,
);
```

Pass:

```ts
realtimeService,
realtimePublisher: realtimeBus,
```

Do not create one bus per route or one bus per JobCard service call.

- [ ] **Step 5: Add forced-password-change route coverage**

In `server/tests/realtime-routes.test.ts`, add an integration test through `buildApp`:

```ts
it('rejects a forced-password-change session before stream start', async () => {
  // authenticate a fixture whose mustChangePassword is true
  // GET /api/realtime/events
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    code: 'PASSWORD_CHANGE_REQUIRED',
  });
});
```

Use the existing auth repository/session test pattern. Do not set `request.currentUser` manually for this integration assertion.

- [ ] **Step 6: Run app and route tests**

```bash
npm test -- --run \
  tests/app.test.ts \
  tests/realtime-routes.test.ts \
  tests/job-card-service.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ..
git add server/src/app.ts \
        server/src/index.ts \
        server/tests/app.test.ts \
        server/tests/realtime-routes.test.ts
git commit -m "feat(server): wire realtime stream dependencies"
```

---

### Task 11: Prove manager/staff audience isolation through the HTTP stream

**Files:**
- Modify: `server/tests/realtime-job-card-integration.test.ts`
- Modify: `server/tests/realtime-routes.test.ts`

**Interfaces:**
- Consumes: completed server wiring.
- Produces: end-to-end proof that the correct user receives the event and unrelated staff does not.

- [ ] **Step 1: Add a deterministic two-actor integration harness**

Create three authenticated sessions:

```ts
const manager = {
  id: managerId,
  organizationId,
  role: 'MANAGER' as const,
};
const assignedStaff = {
  id: assignedStaffId,
  organizationId,
  role: 'STAFF' as const,
};
const unrelatedStaff = {
  id: unrelatedStaffId,
  organizationId,
  role: 'STAFF' as const,
};
```

Use one real `InMemoryRealtimeEventBus`, one real `RealtimeService`, and a PostgreSQL repository against the test database.

- [ ] **Step 2: Write the failing audience integration test**

```ts
it('delivers submission to manager and assignee but not unrelated staff', async () => {
  const managerEvents: RealtimeEventEnvelope[] = [];
  const assignedEvents: RealtimeEventEnvelope[] = [];
  const unrelatedEvents: RealtimeEventEnvelope[] = [];

  const managerSub = await realtime.open(
    manager,
    await repository.visibleHighWater(manager),
    { send: async (event) => { managerEvents.push(event); } },
  );
  const assignedSub = await realtime.open(
    assignedStaff,
    await repository.visibleHighWater(assignedStaff),
    { send: async (event) => { assignedEvents.push(event); } },
  );
  const unrelatedSub = await realtime.open(
    unrelatedStaff,
    await repository.visibleHighWater(unrelatedStaff),
    { send: async (event) => { unrelatedEvents.push(event); } },
  );

  await jobCards.submitForApproval(assignedStaff, jobCardId, {
    expectedVersion: 1,
    clientActionId: 'submit-1',
    note: 'Teslim tamamlandı.',
  });
  await Promise.resolve();

  expect(managerEvents).toContainEqual(
    expect.objectContaining({
      type: 'job.submitted_for_approval',
    }),
  );
  expect(assignedEvents).toContainEqual(
    expect.objectContaining({
      type: 'job.submitted_for_approval',
    }),
  );
  expect(unrelatedEvents).toEqual([]);

  managerSub.close();
  assignedSub.close();
  unrelatedSub.close();
});
```

- [ ] **Step 3: Add reconnect replay proof**

```ts
it('replays a missed visible event exactly once after its cursor', async () => {
  const before = await repository.visibleHighWater(manager);

  await jobCards.submitForApproval(assignedStaff, jobCardId, {
    expectedVersion: 1,
    clientActionId: 'submit-replay-1',
    note: 'Teslim tamamlandı.',
  });

  const replayed: RealtimeEventEnvelope[] = [];
  const subscription = await realtime.open(manager, before, {
    send: async (event) => { replayed.push(event); },
  });

  expect(replayed.filter(
    (event) => event.type === 'job.submitted_for_approval',
  )).toHaveLength(1);
  subscription.close();
});
```

- [ ] **Step 4: Run against PostgreSQL**

```bash
cd server
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
npm test -- --run \
  tests/realtime-job-card-integration.test.ts \
  tests/realtime-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ..
git add server/tests/realtime-job-card-integration.test.ts \
        server/tests/realtime-routes.test.ts
git commit -m "test(server): prove realtime audience isolation"
```

---

### Task 12: Validate reverse-proxy streaming and CI coverage

**Files:**
- Create: `ops/ci/verify-sse-streaming.sh`
- Modify: `ops/ci/verify-caddyfile.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: current Caddy VPS configuration and CI shell validation pattern.
- Produces: static and behavior checks that prevent buffering the SSE endpoint.

- [ ] **Step 1: Write the failing shell verifier**

Create executable `ops/ci/verify-sse-streaming.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CADDYFILE="${1:-$ROOT/ops/caddy/Caddyfile}"

test -f "$CADDYFILE"

if grep -Eq 'encode[[:space:]]+.*text/event-stream' "$CADDYFILE"; then
  echo "SSE must not be explicitly encoded: $CADDYFILE" >&2
  exit 1
fi

if grep -Eq 'buffer_requests|request_buffers|response_buffers' "$CADDYFILE"; then
  echo "SSE-incompatible buffering directive found: $CADDYFILE" >&2
  exit 1
fi

grep -Eq 'reverse_proxy' "$CADDYFILE"
echo "sse-streaming-config-ok"
```

Make it executable:

```bash
chmod +x ops/ci/verify-sse-streaming.sh
```

- [ ] **Step 2: Run against a deliberately invalid fixture**

```bash
BAD="$(mktemp)"
printf '%s\n' 'example.test {' \
  '  encode text/event-stream' \
  '  reverse_proxy localhost:3000' \
  '}' > "$BAD"

if ops/ci/verify-sse-streaming.sh "$BAD"; then
  echo "expected verifier failure" >&2
  exit 1
fi
rm "$BAD"
```

Expected: command exits non-zero and prints `SSE must not be explicitly encoded`.

- [ ] **Step 3: Run against the production Caddyfile**

First locate the exact production file already passed to `verify-caddyfile.sh`:

```bash
sed -n '1,220p' ops/ci/verify-caddyfile.sh
```

If that script names a path different from `ops/caddy/Caddyfile`, update the default `CADDYFILE` in the new verifier to that exact existing path. Do not add a second production Caddyfile.

Run:

```bash
ops/ci/verify-sse-streaming.sh
```

Expected:

```text
sse-streaming-config-ok
```

- [ ] **Step 4: Chain the verifier from the existing Caddy validation**

At the end of `ops/ci/verify-caddyfile.sh`, after successful Caddy validation, add:

```bash
"$ROOT/ops/ci/verify-sse-streaming.sh" "$CADDYFILE"
```

Reuse the existing `ROOT` and `CADDYFILE` variables. Do not duplicate their definitions.

- [ ] **Step 5: Add CI syntax and shellcheck coverage**

In `.github/workflows/ci.yml`, add `../ops/ci/verify-sse-streaming.sh` to both existing script lists:

```yaml
- run: |
    bash -n \
      # existing paths...
      ../ops/ci/verify-sse-streaming.sh
```

and:

```yaml
- name: shellcheck ops scripts
  run: |
    # existing paths...
    shellcheck -x \
      # existing paths...
      ../ops/ci/verify-sse-streaming.sh
```

The existing `caddy validate Caddyfile (VPS)` step will execute the verifier through `verify-caddyfile.sh`; do not add a redundant third CI step.

- [ ] **Step 6: Run shell validation**

```bash
bash -n \
  ops/ci/verify-caddyfile.sh \
  ops/ci/verify-sse-streaming.sh
shellcheck -x \
  ops/ci/verify-caddyfile.sh \
  ops/ci/verify-sse-streaming.sh
ops/ci/verify-caddyfile.sh
```

Expected: all commands exit `0`, including `sse-streaming-config-ok`.

- [ ] **Step 7: Commit**

```bash
git add ops/ci/verify-sse-streaming.sh \
        ops/ci/verify-caddyfile.sh \
        .github/workflows/ci.yml
git commit -m "test(ops): guard SSE proxy streaming"
```

---

### Task 13: Run full regression, update the spec record, and open a draft PR

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-sse-realtime-foundation-design.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified implementation record and draft PR only.

- [ ] **Step 1: Run formatting and diff safety checks**

```bash
git status --short
git diff --check
```

Expected: only intended Phase N files are modified; `git diff --check` exits `0`.

- [ ] **Step 2: Run complete server verification**

```bash
cd server
npm run build
npm test -- --run
npm audit --omit=dev
cd ..
```

Expected:

- TypeScript build PASS.
- All server tests PASS with only the repository's documented environment-dependent skips.
- Production dependency audit reports zero high/critical vulnerabilities.

- [ ] **Step 3: Run migration and ops verification**

```bash
cd server
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}" \
DATABASE_URL="$TEST_DATABASE_URL" \
npm run migrate
cd ..

bash -n \
  ops/ci/verify-caddyfile.sh \
  ops/ci/verify-sse-streaming.sh
shellcheck -x \
  ops/ci/verify-caddyfile.sh \
  ops/ci/verify-sse-streaming.sh
ops/ci/verify-caddyfile.sh
```

Expected: migration and all ops checks PASS.

- [ ] **Step 4: Run untouched web regression for CI parity**

```bash
cd web
npm ci
npm run build
npm run bundle:check
npm test -- --run
npm run smoke:responsive
npm audit --omit=dev
cd ..
```

Expected: web build, bundle budget, test suite, responsive smoke, and audit remain green even though no web source file changed.

- [ ] **Step 5: Append the implementation record to the approved spec**

At the bottom of `docs/superpowers/specs/2026-07-19-sse-realtime-foundation-design.md`, add:

```markdown
## Implementation Record

- Branch: `feature/sse-realtime-foundation`
- Migration: `011_create_realtime_events.sql`
- Transport: authenticated SSE at `GET /api/realtime/events`
- Replay: `Last-Event-ID`, maximum 500 visible events, then `sync.required`
- First connection: visible high-water `sync.required`
- Publication: after committed JobCard transaction only
- Audience: Admin/Manager organization scope; explicit current/previous assignee
- Excluded: frontend client, notifications, geolocation, manifest, service worker, Web Push
- Verification:
  - `cd server && npm run build`
  - `cd server && npm test -- --run`
  - `cd server && npm audit --omit=dev`
  - `ops/ci/verify-caddyfile.sh`
  - `cd web && npm run build`
  - `cd web && npm run bundle:check`
  - `cd web && npm test -- --run`
  - `cd web && npm run smoke:responsive`
  - `cd web && npm audit --omit=dev`
```

Do not write pass counts until the commands have actually completed; add the observed counts beside the commands after execution.

- [ ] **Step 6: Commit the verification record**

```bash
git add docs/superpowers/specs/2026-07-19-sse-realtime-foundation-design.md
git commit -m "docs: record SSE foundation verification"
```

- [ ] **Step 7: Confirm commit scope**

```bash
git log --oneline d785fa3..HEAD
git diff --stat d785fa3..HEAD
git status --short
```

Expected:

- Focused commits matching Tasks 2–13.
- No frontend runtime file.
- No package or lockfile.
- Clean worktree.

- [ ] **Step 8: Push the feature branch**

```bash
git push -u origin feature/sse-realtime-foundation
```

Expected: remote branch created successfully.

- [ ] **Step 9: Open a draft PR**

Use title:

```text
feat(server): add SSE realtime foundation
```

Use this body:

```markdown
## Summary

- persist audience-filtered JobCard invalidation events beside canonical activity records
- publish committed events through a process-local bus
- expose authenticated SSE with first-connect sync, cursor replay, overflow reconciliation, heartbeat, and cleanup
- preserve REST DTOs, role policies, idempotency, optimistic versions, and audit history
- add reverse-proxy streaming guards

## Scope boundaries

- server and ops foundation only
- no React realtime client
- no notification center
- no geolocation
- no manifest, service worker, or Web Push
- no WebSocket, broker, LISTEN/NOTIFY, or new dependency

## Verification

- server build and full test suite
- migration against PostgreSQL 17
- server production audit
- Caddy/SSE streaming checks
- web build, bundle budget, tests, responsive smoke, and audit
```

Command:

```bash
gh pr create \
  --draft \
  --base main \
  --head feature/sse-realtime-foundation \
  --title "feat(server): add SSE realtime foundation" \
  --body-file /tmp/servora-sse-pr.md
```

Create `/tmp/servora-sse-pr.md` with the exact body above before running the command. If `gh` is unavailable, open the draft PR through the connected GitHub tool with the same title/body/head/base.

- [ ] **Step 10: Stop**

Do not mark ready and do not merge.

## Final Acceptance Checklist

- [ ] `realtime_events` is linked one-to-one to canonical activity through `source_activity_id`.
- [ ] A rejected or rolled-back command creates neither a committed activity/event pair nor a publication.
- [ ] An idempotent replay produces no duplicate realtime publication.
- [ ] Existing public JobCard REST DTOs are unchanged.
- [ ] Admin/Manager receive visible organization events.
- [ ] Current assignee receives relevant events.
- [ ] Previous assignee receives reassignment invalidation.
- [ ] Unrelated staff receive no JobCard metadata.
- [ ] First connection emits `sync.required` at visible high-water.
- [ ] Replay is ordered, audience-filtered, deduplicated, and capped at 500.
- [ ] Replay/live handoff has no loss window.
- [ ] SSE sends heartbeat comments every 20 seconds.
- [ ] Disconnect and server shutdown clean timers/subscribers.
- [ ] Reverse-proxy validation guards against SSE buffering.
- [ ] No web runtime, notification, geolocation, PWA, push, or dependency changes are included.
- [ ] Draft PR is open; merge has not been performed.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-sse-realtime-foundation.md`. Ready for execution.

**Next step:** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`.
