# Browser Realtime Capabilities Roadmap Design

**Date:** 2026-07-19  
**Status:** Design approved in conversation; written spec awaiting repository review  
**Repository:** `emrahozcelik/servora-med`  
**Target stack:** React/Vite web, Fastify API, PostgreSQL, Chrome and Safari first

## 1. Problem

Servora-Med's core JobCard lifecycle is complete, but authenticated users only see changes made by other users after manually refreshing the page.

Examples:

- A staff member submits a job for approval, but the manager's board and approval queue remain stale.
- A manager approves or requests revision, but the assigned staff member does not see the new state.
- A job is reassigned, cancelled, or advanced by another user while an existing tab stays open.

This is a synchronization problem first and a notification problem second. Device notifications alone would not keep open application screens correct.

## 2. Approved Direction

Servora-Med remains an online browser-based application.

The approved capability stack is:

1. **SSE realtime invalidation** for open authenticated sessions.
2. **Canonical REST refetch** after relevant events.
3. **Persistent in-app notifications** for user awareness and history.
4. **Action-scoped browser geolocation** for selected field actions.
5. **Minimal install and Web Push support** after in-app notifications are stable.

This is not an offline-first PWA program. Offline mutations, Background Sync, cached business API responses, and continuous background GPS tracking are out of scope.

## 3. Goals

- Reflect JobCard lifecycle changes in other open sessions without page refresh.
- Preserve backend state and REST APIs as the single source of truth.
- Inform managers and staff about actions relevant to them.
- Recover safely from disconnected, suspended, or resumed browser tabs.
- Support current Chrome and Safari behavior first.
- Add location only through explicit user actions and permissions.
- Keep each delivery slice independently testable and deployable.
- Preserve the modular-monolith architecture and existing role, version, idempotency, and audit contracts.

## 4. Non-Goals

The program does not introduce:

- WebSocket-based command transport.
- Offline JobCard transitions or approval.
- A client-side replica of backend domain state.
- Continuous employee tracking.
- Background geolocation while the page is closed or suspended.
- A native mobile application.
- General-purpose event sourcing.
- A new frontend state-management framework.
- A third-party realtime platform.
- Multi-tenant or multi-region infrastructure.
- Broad browser compatibility work beyond Chrome and Safari in the first delivery cycle.

## 5. Alternatives Considered

### 5.1 Polling only

**Advantages**

- Very simple transport.
- Works in most browser and proxy environments.

**Disadvantages**

- Repeated database and API traffic even when nothing changes.
- Delayed updates unless polling is aggressive.
- Poor foundation for timely notification badges.

**Decision**

Keep low-frequency polling only as a disconnected fallback, not the primary transport.

### 5.2 WebSocket first

**Advantages**

- Bidirectional realtime channel.
- Suitable for collaborative editing or high-frequency interaction.

**Disadvantages**

- Adds protocol, reconnect, authorization, heartbeat, proxy, and lifecycle complexity.
- Servora commands already work correctly through REST.
- No current requirement needs bidirectional socket commands.

**Decision**

Rejected for the MVP. Reconsider only if a proven bidirectional requirement appears.

### 5.3 SSE plus REST invalidation

**Advantages**

- Matches the one-way server-to-browser update requirement.
- Keeps existing REST commands unchanged.
- Uses browser-native reconnect behavior.
- Allows small invalidation messages instead of duplicated business DTOs.

**Disadvantages**

- Requires streaming proxy validation.
- Background mobile tabs can still be suspended.
- Needs replay and fallback rules.

**Decision**

Selected.

## 6. Architectural Rules

### 6.1 Backend truth remains canonical

Realtime messages never become a second representation of a JobCard, approval item, staff report, or customer record.

An event identifies:

- what changed,
- which entity changed,
- which resource views may now be stale,
- when the change occurred,
- who may receive the event.

The browser then refetches the existing canonical REST resource.

### 6.2 Realtime events are transport records, not domain records

Existing domain tables and `job_card_activity_logs` remain the business and audit source of truth.

A small persisted realtime event ledger exists only to support:

- SSE cursor IDs,
- reconnect replay,
- audience filtering,
- resource invalidation,
- future notification derivation.

The ledger must not contain full mutable JobCard snapshots.

### 6.3 Domain mutation and event persistence share a transaction

A business change must not commit without its corresponding realtime invalidation record.

A rolled-back business command must not produce a visible realtime event.

Idempotent command replay must not create or publish a duplicate event.

### 6.4 Authorization applies before delivery

Realtime metadata is still protected data.

- Admin and Manager users receive organization management events relevant to their role.
- Staff users receive events only when explicitly targeted, normally because they are the current or previous assignee.
- Existing REST endpoints continue to enforce the final read boundary.
- No event contains sensitive notes, delivery details, contact data, location data, or full DTOs.

### 6.5 Realtime is an acceleration layer

The application must stay correct when realtime is unavailable.

Fallback reconciliation occurs when:

- the page becomes visible,
- the window regains focus,
- the browser comes online,
- the SSE connection reconnects,
- the SSE connection remains unavailable and fallback polling is active.

## 7. Program Decomposition

Each phase is a separate Superpowers spec, implementation plan, branch, and PR.

### Phase N — Server realtime event contract and SSE transport

Delivers:

- persisted realtime event ledger,
- explicit event and audience contracts,
- in-process publish/subscribe port,
- authenticated SSE route,
- replay with `Last-Event-ID`,
- heartbeat and disconnect cleanup,
- initial JobCard lifecycle event production.

Does not change the web UI.

### Phase O — Web realtime client and automatic reconciliation

Delivers:

- one authenticated `RealtimeProvider`,
- one `EventSource` connection per application tab,
- resource revision/invalidation subscriptions,
- automatic board/list/approval refetch,
- safe detail-page stale-state handling,
- visibility, focus, online, and polling fallback behavior,
- connection status observability.

Does not add persistent notifications.

### Phase P — Persistent in-app notification center

Delivers:

- user-addressed notification records,
- unread count,
- notification list/drawer,
- mark-read behavior,
- deep links to affected records,
- semantic manager/staff messages.

Notifications derive from committed domain/realtime events but remain a separate user-facing read model.

### Phase Q — Action-scoped browser geolocation

Initial pilot:

- user-initiated location capture on an explicitly approved JobCard field action,
- `navigator.geolocation.getCurrentPosition`,
- latitude, longitude, accuracy, capture time, action, actor, and JobCard association,
- permission-denied and timeout handling,
- no continuous tracking,
- no service-worker geolocation,
- no workflow deadlock when location is unavailable unless a later product policy explicitly makes it mandatory.

Production enablement requires an approved purpose, retention period, access policy, and employee/user notice.

### Phase R — Minimal install surface and Web Push

Delivers:

- web app manifest and icons,
- Chrome install guidance,
- Safari/iOS Add to Home Screen guidance,
- service worker used for Push API and notification clicks,
- VAPID-backed subscription storage,
- push delivery derived from persistent notifications,
- deep links into Servora-Med.

Does not cache business APIs or enable offline mutations.

## 8. Event Contract

Initial envelope:

```ts
type RealtimeChangeType =
  | 'job.created'
  | 'job.assignment_changed'
  | 'job.accepted'
  | 'job.started'
  | 'job.submitted_for_approval'
  | 'job.approved'
  | 'job.revision_requested'
  | 'job.cancelled'
  | 'job.updated';

export type RealtimeEventEnvelope =
  | Readonly<{
      id: string;
      type: RealtimeChangeType;
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

Example resource keys:

```text
job-board
job-list
job-detail:<jobCardId>
approval-queue
staff-profile:<staffUserId>
reports
notifications
workspace
```

Rules:

- `id` is a monotonic replay cursor serialized as a string.
- `occurredAt` is an ISO-8601 instant.
- Event payloads contain no complete business record.
- Unknown event types are ignored safely and trigger no mutation.
- `sync.required` requests broad canonical reconciliation when replay cannot be served safely.

## 9. Client Reconciliation Rules

### Lists, boards, counts, and reports

Relevant events trigger guarded canonical refetch.

Refetches must:

- preserve current filters and pagination,
- use the existing request-gate pattern,
- ignore stale responses,
- avoid concurrent duplicate loads where practical.

### Detail and edit screens

A remote event must not silently overwrite unsaved user input.

- If the screen is clean and not submitting, it may refetch automatically.
- If the screen is dirty or pending, show a stale-record banner.
- The banner offers an explicit reload action.
- Existing optimistic-version and `VERSION_CONFLICT` handling remains authoritative.

### Originating session

The tab that performed the command may receive the same event.

The resulting refetch must be harmless. No command is repeated, and no optimistic version is decremented.

## 10. Failure and Recovery

### Initial connection and connection loss

- A first connection without `Last-Event-ID` receives a synthetic `sync.required` event at the visible server high-water mark.
- The client responds by refetching its active canonical resources, closing the race between initial page load and stream establishment.
- Browser-native SSE reconnect is allowed.
- The last processed event ID is tracked.
- Reconnect requests replay after that cursor.
- A visible connection indicator may show connected, reconnecting, or fallback states.

### Browser suspension

Mobile browsers may suspend background tabs.

When the page becomes visible again, the client performs canonical reconciliation even when no SSE error was observed.

### Replay overflow

The server uses a bounded replay response.

When the backlog exceeds the safe replay limit:

1. emit `sync.required`,
2. advance the client cursor to the server high-water mark,
3. let the client refetch its active resources.

### Duplicate delivery

Events are deduplicated by event ID per tab.

Duplicate events may cause a repeated GET, but must never repeat a business mutation.

### Server restart

Persisted events survive restart.

Open connections reconnect and replay from their last cursor.

## 11. Browser Strategy

First-class pilot targets:

- current Chrome desktop,
- current Chrome on Android,
- current Safari on macOS,
- current Safari on iOS/iPadOS.

Automated tests use existing Chromium coverage and may use Playwright WebKit where useful. Real Safari/iOS install, Push API, permission, and background behavior require manual device validation before release.

All browser-specific capabilities use feature detection. Unsupported capabilities degrade to normal online web behavior.

## 12. Security and Privacy

- SSE uses the existing authenticated session and password-change gate.
- Event audience checks run on the server.
- Event streams are organization-scoped.
- Event messages exclude secrets, session identifiers, notes, customer details, and location.
- Geolocation is requested only after an explicit user action.
- Location is never collected continuously in this program.
- Location access, visibility, retention, and deletion rules must be documented before production enablement.
- Push subscription endpoints and keys are treated as credentials and are never logged.

## 13. Operations

The deployment path must preserve streaming responses.

Validation must cover:

- Caddy/reverse-proxy buffering behavior,
- idle timeout behavior,
- heartbeat passage,
- graceful connection cleanup on server shutdown,
- health/readiness behavior independent of active SSE clients.

The application remains deployable as a single Fastify process on the current VPS architecture.

## 14. Testing Strategy

### Server

- event type and resource mapping unit tests,
- audience policy unit tests,
- transaction rollback tests,
- idempotent replay tests,
- authenticated/unauthenticated stream tests,
- replay and cursor tests,
- connection cleanup tests,
- role and organization isolation tests.

### Web

- provider connection lifecycle tests,
- event deduplication tests,
- resource invalidation tests,
- board and approval queue automatic refetch tests,
- dirty-form stale banner tests,
- focus/visibility/online reconciliation tests,
- disconnected fallback polling tests.

### Browser/manual

- two-session manager/staff scenario,
- Chrome foreground and background/resume behavior,
- Safari foreground and background/resume behavior,
- geolocation allow/deny/timeout behavior,
- installed Web Push behavior in Phase R.

## 15. Program-Level Acceptance Criteria

The program is successful when:

1. A staff lifecycle action appears in a manager's open board and approval queue without manual refresh.
2. A manager approval or revision request appears in the assigned staff member's open session without manual refresh.
3. Reconnect and page-resume reconciliation recover missed changes.
4. Staff cannot receive metadata for unrelated JobCards.
5. Open forms never lose unsaved input because of remote events.
6. Notification history remains available after the realtime toast disappears.
7. Location collection remains explicit, action-scoped, observable, and optional under the initial policy.
8. Web Push does not introduce offline business-state caching.
9. Existing role, idempotency, version, audit, build, test, bundle, responsive, and security checks remain green.

## 16. Explicit Gates Before Later Phases

Phase Q must not start until the product owner selects the first location-bearing action and approves its purpose and retention policy.

Phase R must not start until Phase P notification semantics and audience rules are stable.

Other-browser compatibility work starts only after the Chrome and Safari pilot passes.
