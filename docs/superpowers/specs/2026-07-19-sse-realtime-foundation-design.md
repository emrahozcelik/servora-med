# SSE Realtime Foundation Design

**Date:** 2026-07-19  
**Status:** First sub-project spec awaiting repository review  
**Parent spec:** `2026-07-19-browser-realtime-capabilities-roadmap-design.md`  
**Delivery:** Phase N — server realtime event contract and SSE transport

## 1. Objective

Create the smallest durable server-side foundation that allows authenticated Servora-Med browser sessions to receive JobCard lifecycle invalidation events.

This phase proves the server contract only. It does not add a React realtime client, notification UI, geolocation, manifest, service worker, or Web Push.

## 2. Existing Context

Servora-Med already has:

- Fastify routes and authentication middleware,
- PostgreSQL repositories and explicit transaction boundaries,
- JobCard optimistic versions,
- persisted idempotency claims,
- mandatory `job_card_activity_logs`,
- explicit lifecycle commands,
- role-based JobCard read policies.

The new realtime layer must reuse these boundaries rather than bypass them.

## 3. Scope

### Included

- JobCard creation, base-field patching, reassignment, and lifecycle commands,
- realtime event types,
- resource invalidation mapping,
- audience contract,
- persisted event ledger,
- event repository port,
- in-process event broadcaster port,
- authenticated SSE endpoint,
- cursor replay,
- heartbeat,
- disconnect cleanup,
- lifecycle event creation for JobCard create, assignment, accept, start, submit, approve, revision, cancel, and material update,
- server tests,
- deployment streaming verification.

### Excluded

- frontend `EventSource`,
- browser refetch behavior,
- notification records or unread counts,
- push subscriptions,
- geolocation,
- offline behavior,
- WebSocket support,
- third-party broker,
- PostgreSQL `LISTEN/NOTIFY`,
- multiple application processes,
- note, delivery-item, and meeting-detail realtime events.

The initial delivery covers the completion/assignment chain and base JobCard edits. Note, delivery-item, and meeting-detail invalidation may be added later through separate proven slices.

The initial deployment remains one Fastify process. The persisted ledger preserves a future path to multi-process delivery without introducing that complexity now.

## 4. Proposed Module Boundaries

```text
server/src/modules/realtime/
  types.ts
  audience.ts
  event-mapper.ts
  repository.ts
  event-bus.ts
  service.ts
  routes.ts
```

Responsibilities:

### `types.ts`

Owns:

- `RealtimeEventType`,
- `RealtimeEntityType`,
- `RealtimeResourceKey`,
- persisted event and public SSE envelope types,
- audience value types.

It contains no database or Fastify code.

### `audience.ts`

Owns pure audience decisions.

Inputs include:

- actor role and ID,
- current assignee,
- previous assignee when reassigned,
- event type.

Output includes:

- allowed roles,
- explicitly allowed user IDs.

It contains no HTTP or SQL code.

### `event-mapper.ts`

Maps committed JobCard domain/activity facts into:

- semantic realtime event type,
- affected resource keys,
- audience input.

It does not read the database and does not publish.

### `repository.ts`

Defines `RealtimeEventRepository` and implements PostgreSQL persistence and replay queries.

It owns:

- insert inside an existing `PoolClient` transaction,
- replay after cursor,
- high-water lookup,
- audience-filtered queries.

It does not own Fastify responses or JobCard business rules.

### `event-bus.ts`

Defines an in-process publish/subscribe boundary.

It owns:

- subscriber registration,
- event publication after commit,
- unsubscribe cleanup,
- exception isolation between subscribers.

It stores no canonical business state.

### `service.ts`

Coordinates:

- authenticated replay,
- audience checks,
- replay limits,
- live stream subscriptions,
- event serialization,
- event deduplication for replay/live handoff.

### `routes.ts`

Owns only the HTTP/SSE translation:

- authentication,
- SSE headers,
- `Last-Event-ID` parsing,
- heartbeat comments,
- disconnect cleanup,
- serialized writes.

## 5. Persisted Event Model

Create a new sequential migration under `server/src/db/migrations/` using the next migration number present on `main`.

Table:

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Required checks and indexes:

- event type is non-empty and limited to the initial contract values,
- entity type equals `job-card`,
- resource key array is non-empty,
- audience roles are limited to `ADMIN` and `MANAGER`,
- at least one role or user audience exists,
- index on `(organization_id, id)`,
- GIN index on `audience_user_ids`,
- GIN index on `audience_roles`.

`source_activity_id` makes the ledger a transport projection of the canonical audit record and prevents more than one realtime event for the same activity. `actor_user_id` and `entity_id` intentionally have no direct foreign key: actor accounts are deactivated rather than required for replay, and the generic entity column must not couple the transport table to one domain table.

No payload JSONB column is included in Phase N. The stream carries only invalidation metadata.

## 6. Internal Event Contract

```ts
export type RealtimeEventType =
  | 'job.created'
  | 'job.assignment_changed'
  | 'job.accepted'
  | 'job.started'
  | 'job.submitted_for_approval'
  | 'job.approved'
  | 'job.revision_requested'
  | 'job.cancelled'
  | 'job.updated';

export type RealtimeAudience = Readonly<{
  roles: readonly ('ADMIN' | 'MANAGER')[];
  userIds: readonly string[];
}>;

export type RealtimeEventRecord = Readonly<{
  id: bigint;
  organizationId: string;
  sourceActivityId: string;
  type: RealtimeEventType;
  entityType: 'job-card';
  entityId: string;
  actorUserId: string | null;
  audience: RealtimeAudience;
  resourceKeys: readonly string[];
  createdAt: Date;
}>;

export type RealtimeEventEnvelope =
  | Readonly<{
      id: string;
      type: RealtimeEventType;
      entity: Readonly<{
        type: 'job-card';
        id: string;
      }>;
      resourceKeys: readonly string[];
      occurredAt: string;
    }>
  | Readonly<{
      id: string;
      type: 'sync.required';
      resourceKeys: readonly ['workspace'];
      occurredAt: string;
    }>;
```

`bigint` is converted to a decimal string at the HTTP boundary.

## 7. Initial Audience Rules

### Management audience

`ADMIN` and `MANAGER` receive JobCard lifecycle events in their organization.

### Staff audience

The current assignee receives:

- creation/assignment to them,
- acceptance/start/submission events,
- approval,
- revision request,
- cancellation,
- relevant material updates.

On reassignment, both the previous and new assignee receive the invalidation event so each open workspace can remove or add the card.

The actor may receive an event when included by role or assignee. This is acceptable because the event causes only an idempotent GET refetch in Phase O.

No organization-wide staff broadcast is allowed.

## 8. Resource Mapping

All initial JobCard events include:

```text
job-board
job-list
job-detail:<jobCardId>
```

Additional keys:

| Event | Additional resource keys |
| --- | --- |
| `job.created` | `staff-profile:<assigneeId>`, `reports` |
| `job.assignment_changed` | previous/new `staff-profile:<userId>`, `reports` |
| `job.submitted_for_approval` | `approval-queue`, `staff-profile:<assigneeId>`, `reports` |
| `job.approved` | `approval-queue`, `staff-profile:<assigneeId>`, `reports` |
| `job.revision_requested` | `approval-queue`, `staff-profile:<assigneeId>`, `reports` |
| `job.cancelled` | `approval-queue`, `staff-profile:<assigneeId>`, `reports` |
| other lifecycle/material updates | `staff-profile:<assigneeId>`, `reports` when their read models can change |

The mapper deduplicates and deterministically orders resource keys.

## 9. Transaction and Publication Flow

For each covered command:

1. Validate authentication, role, input, expected version, and idempotency as today.
2. Begin the existing business transaction.
3. Apply the JobCard mutation.
4. Append the canonical activity record and obtain its persisted ID.
5. Insert one realtime event with that `source_activity_id` using the same `PoolClient`.
6. Commit the transaction.
7. If the idempotent result is `completed`, publish the persisted event through the in-process bus.
8. If the result is `replay`, return the original API response and do not republish.
9. If the transaction rolls back, neither activity nor realtime event exists and nothing is published.

The service must receive the persisted event record through an internal result without changing public REST response DTOs.

A process failure after commit but before in-process publication is recovered by SSE replay when clients reconnect or reconcile. This is acceptable for the single-process MVP and avoids adding a broker or PostgreSQL listener.

## 10. SSE Endpoint

Route:

```text
GET /api/realtime/events
```

Requirements:

- existing session-cookie authentication,
- existing forced-password-change gate,
- organization and role derived only from the authenticated session,
- no organization/user selector accepted from the client,
- `Content-Type: text/event-stream`,
- `Cache-Control: no-cache, no-transform`,
- connection keep-alive,
- proxy buffering disabled where supported,
- heartbeat comment every 20 seconds,
- subscriber cleanup when the request closes.

Event frame:

```text
id: 1842
event: servora.change
data: {"id":"1842","type":"job.submitted_for_approval","entity":{"type":"job-card","id":"..."},"resourceKeys":["job-board","job-list","job-detail:...","approval-queue","staff-profile:...","reports"],"occurredAt":"2026-07-19T14:30:00.000Z"}

```

Heartbeat frame:

```text
: heartbeat

```

## 11. Cursor and Replay

- Parse `Last-Event-ID` as a non-negative decimal integer.
- Missing `Last-Event-ID` means first connection.
- On first connection, determine the visible high-water ID, emit one synthetic `sync.required` event with `resourceKeys: ['workspace']`, and continue live after that high-water mark.
- The synthetic event uses ID `0` when no visible persisted event exists.
- This first-connection reconciliation closes the race between the page's initial REST load and stream establishment without replaying historical events.
- Invalid cursor input returns a normal `400` error before switching to streaming mode.
- Replay queries are organization- and audience-filtered.
- Replay events are ordered by ascending ID.
- The maximum normal replay batch is 500 events.

When more than 500 visible events exist after the cursor:

1. determine the visible high-water event ID,
2. send one `sync.required` envelope using that high-water ID and `resourceKeys: ['workspace']`,
3. do not stream the intermediate backlog,
4. continue with live events after the high-water mark.

The Phase O client will respond by refetching all active canonical resources.

## 12. Replay/Live Handoff

The service must avoid losing an event between the replay query and live subscription.

Required sequence:

1. register a live subscriber that buffers visible events,
2. read and emit replay after the requested cursor,
3. record the largest emitted ID,
4. drain buffered events in ascending ID order,
5. deduplicate IDs already emitted,
6. switch the subscriber from buffering to direct serialized writes.

Only one write chain may touch the response at a time.

## 13. Backpressure and Cleanup

- Per-connection writes are serialized.
- A failed or closed response removes the subscriber.
- One slow client must not block publication to other subscribers.
- The event bus catches subscriber exceptions and continues notifying others.
- The server clears heartbeat timers and subscriptions on disconnect and shutdown.
- Phase N does not introduce an unbounded per-client queue. A client that cannot keep up is disconnected and recovers through replay.

## 14. Fastify Wiring

Add optional realtime dependencies to `AppDependencies` so tests can inject fakes.

Production wiring in `server/src/index.ts` creates:

- one PostgreSQL realtime repository,
- one process-wide event bus,
- one realtime service,
- the existing JobCard service with a realtime event port,
- the authenticated realtime route.

No module imports the global Fastify instance.

## 15. JobCard Integration Boundary

The JobCard module must not know SSE framing or connected clients.

It may depend on a narrow internal port that can:

- persist a mapped realtime event through the current transaction,
- publish the committed event after successful completion.

The initial implementation should prefer an explicit typed port over callbacks embedded in route handlers.

Existing `JobCardActivityEvent` values may be used as mapping input, but public realtime event names remain separate and stable.

## 16. Error Handling

- Authentication errors use existing API error behavior before stream headers are committed.
- Database replay errors terminate the connection and are logged without leaking internals.
- Subscriber callback errors are isolated and logged.
- An event that cannot be serialized is not sent; the connection closes so replay can recover after the defect is fixed.
- An unknown persisted event type is treated as an invariant violation and is not silently coerced.
- Heartbeat write failure triggers normal disconnect cleanup.

Logs must not include cookies, session IDs, location, customer details, notes, or full event audiences.

## 17. Tests

### Pure unit tests

- every covered activity/lifecycle action maps to the expected event type,
- resource keys are complete, ordered, and deduplicated,
- assignment audience includes old and new assignee,
- staff audience never becomes organization-wide,
- role audience is limited to Admin/Manager.

### Repository tests

- insert persists all contract fields,
- one activity ID cannot create two realtime events,
- insert rolls back with its parent transaction,
- replay is organization-scoped,
- replay is role/user audience-scoped,
- replay ordering is ascending,
- high-water query respects audience,
- indexes and constraints exist through migration tests.

### Service tests

- committed event publishes once,
- idempotent replay publishes zero times,
- replay plus buffered live events has no gap,
- duplicate IDs are emitted once,
- overflow emits `sync.required`,
- slow/failed subscriber cleanup works.

### Route tests

- unauthenticated request is rejected,
- forced-password-change session is rejected,
- authenticated request receives correct SSE headers,
- invalid cursor is rejected before stream start,
- event frame contains `id`, `event`, and JSON `data`,
- heartbeat is written,
- disconnect releases subscriber and timer.

### Integration tests

Using two authenticated actors:

1. staff submits a JobCard for approval,
2. manager stream receives the event,
3. unrelated staff stream does not receive it,
4. reconnect with the prior ID does not duplicate it.

## 18. Deployment Verification

Add or extend an ops smoke test that proves the production reverse proxy:

- preserves `text/event-stream`,
- does not buffer the first event until connection close,
- allows heartbeat data through,
- keeps the connection open for the tested interval.

Do not weaken existing Caddy, tunnel, authentication, or origin checks.

## 19. Acceptance Criteria

Phase N is complete when:

1. All covered JobCard commands persist one typed realtime event in the same transaction as the business mutation.
2. A rolled-back or rejected command produces no event.
3. Idempotent command replay does not publish a duplicate.
4. An authenticated manager stream receives relevant organization JobCard events.
5. An assigned staff stream receives relevant JobCard events.
6. An unrelated staff stream receives no metadata for the JobCard.
7. `Last-Event-ID` replay returns missed visible events in order.
8. Replay overflow emits `sync.required`.
9. Heartbeat, disconnect, and server shutdown clean up resources.
10. Existing public REST response contracts remain unchanged.
11. Existing server tests, migration tests, build, audit, and ops validation remain green.
12. No frontend, notification, geolocation, manifest, service-worker, or push code is introduced.
