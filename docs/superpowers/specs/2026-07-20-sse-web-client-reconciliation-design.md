# SSE Web Client and Reconciliation Design

**Date:** 2026-07-20
**Status:** Implemented, verified, and merged (PR #36)
**Parent roadmap:** `2026-07-19-browser-realtime-capabilities-roadmap-design.md`
**Server dependency:** `2026-07-19-sse-realtime-foundation-design.md` (merged as PR #34)

## Objective

Add the smallest browser-side reconciliation layer for the already-merged SSE
foundation. The browser receives only invalidation envelopes and re-reads the
affected REST resources. It never derives a JobCard status, permission,
readiness result, activity item, or report metric from an SSE payload.

## Scope

Included:

- one authenticated `RealtimeProvider` per mounted application shell;
- one native `EventSource` for `/api/realtime/events` in each browser tab;
- parsing, validation, monotonic cursor de-duplication, and safe ignoring of
  malformed or unknown `servora.change` envelopes;
- resource-key subscriptions for the currently mounted jobs workspace, JobCard
  detail, approval report, delivery report, reports dashboard, staff profile,
  and staff operational report;
- request coalescing that preserves each surface's existing URL filters,
  pagination, request gates, and stale-response protections;
- dirty or pending JobCard detail protection: show an explicit stale-data
  notice with a reload control instead of overwriting a form or command in
  progress;
- reconciliation on initial `sync.required`, reconnect, visibility/focus, and
  online recovery;
- low-frequency fallback polling only while the SSE connection is unavailable;
- isolated unit/integration tests using a fake EventSource.

Excluded:

- server, API, DTO, database, domain, activity, audience, and resource-key
  changes;
- persistent notifications, unread counts, toast standardisation, browser
  push, service workers, geolocation, WebSocket, and offline writes;
- client-side snapshots, optimistic status transitions, or inferred activity
  records;
- note, delivery-item, and meeting-detail events, which the server foundation
  intentionally does not publish;
- the staff desktop alignment change in PR #35.

## Server Contract Used As-Is

```text
GET /api/realtime/events
Cookie-authenticated existing session; same-origin /api Vite proxy in development
SSE event name: servora.change
```

The server sends either a JobCard change or a sync marker:

```ts
type RealtimeEnvelope =
  | {
      id: string;
      type: JobRealtimeEventType;
      entity: { type: 'job-card'; id: string };
      resourceKeys: readonly string[];
      occurredAt: string;
    }
  | {
      id: string;
      type: 'sync.required';
      resourceKeys: readonly ['workspace'];
      occurredAt: string;
    };
```

`id` is a positive decimal cursor. The browser records the greatest accepted
cursor for its current provider lifetime and discards equal or older events.
Native `EventSource` owns reconnect and the HTTP `Last-Event-ID` header; the
client does not create a parallel cursor parameter or reconnect loop.

The EventSource must use `addEventListener('servora.change', ...)`; `onmessage`
does not receive the named server event. Same-origin cookies are automatic. No
authorization header, actor ID, role, organization ID, or resource filter is
sent by the client.

## Browser Boundaries

```text
authenticated App subtree
  -> RealtimeProvider
     -> EventSource adapter + envelope parser + subscription registry
     -> resource-key invalidation callbacks
     -> existing feature load/reload function
     -> existing API service
     -> canonical server truth
```

`web/src/realtime/` owns transport, envelope validation, lifecycle status, and
resource subscription plumbing. It does not import feature APIs.

Feature components own their resource key and invoke their existing load
function. A resource subscription never calls an endpoint directly, changes a
search parameter, calculates a domain result, or updates a store with event
payload data.

`sync.required` is a workspace-wide invalidation: it notifies every currently
mounted subscription. A normal event notifies only subscriptions whose exact
resource key occurs in `resourceKeys`. Multiple events received before React
can process a render are coalesced to one callback per subscription.

## Surface Mapping

| Server resource key | Mounted consumer | Reconciliation action |
| --- | --- | --- |
| `job-list`, `job-board` | `JobWorkspace` | increment its existing reload key; keep parsed URL filters and offset |
| `job-detail:<id>` | matching `JobDetailScreen` | auto-refresh only when neither editing nor pending; otherwise show stale notice |
| `approval-queue` | `ApprovalReport`, dashboard approval summary | invoke existing guarded load |
| `reports` | delivery report, reports dashboard, staff operational report | invoke existing guarded load |
| `staff-profile:<id>` | matching staff profile/directory | re-run its existing profile loader |
| `workspace` | every mounted subscriber | perform its normal reconciliation action |

The browser must not refresh an unmounted route merely because an event exists.
Backend authorization remains the only authority on what each reload returns.

## Detail Safety Contract

`JobDetailScreen` owns the only special protection in this phase.

- If an invalidation for the displayed job arrives while `pending` is false and
  no edit form is open, it runs the existing `refreshTruth()` function.
- If a lifecycle/record command is pending or the sales-meeting editor is open,
  it marks the detail stale but leaves all rendered/local form state unchanged.
- The stale notice has an explicit `En güncel bilgileri yükle` action. That
  action uses `refreshTruth()` and clears the notice only after a successful
  read.
- Completion of the local command continues to use its established refresh and
  version-conflict behavior. The new layer neither replaces its request gate
  nor clears its feedback/focus handling.

This phase deliberately treats an open editor as protected, even before field
level dirty tracking exists. That is conservative and prevents silent loss of
unsaved input.

## Connection State and Fallback

Provider state is `connecting`, `connected`, or `disconnected`; it is exposed
for testability and a non-intrusive diagnostic hook, but this slice adds no
global notification UI.

- The initial EventSource is opened only inside the authenticated subtree and
  closed on sign-out/unmount.
- `open` marks it connected and asks all active subscriptions to reconcile.
- `error` marks it disconnected. Native EventSource continues its own retry.
- `visibilitychange` to visible, `focus`, and `online` notify all mounted
  subscriptions. They do not create another EventSource.
- While disconnected, active subscriptions run a shared 60-second fallback
  reconciliation interval. It is cleared immediately on `open` and whenever
  the provider unmounts. No polling runs while connected.

The interval is intentionally modest: it makes stale data recover without
turning a disconnected browser into an aggressive polling client.

## Test Contract

Tests must prove:

- exactly one EventSource is created for a mounted authenticated provider and
  is closed during cleanup;
- named events are parsed, accepted once by cursor, and unknown/malformed
  payloads have no effect;
- resource and workspace invalidations coalesce and target only mounted
  subscribers;
- `JobWorkspace` reloads list and board without changing URL filters or
  pagination, and existing stale-response protection still wins;
- report/staff surfaces reuse their current loaders;
- an idle matching JobCard detail reloads, while an editing or pending detail
  shows the stale notice and refreshes only when requested;
- focus/visibility/online and disconnected fallback reconciliation behave as
  specified;
- existing web build, test, bundle, responsive-smoke, and audit checks pass.

Manual browser verification after automated checks covers two logged-in
sessions, server restart/replay, and Safari resume. These are verification
steps, not a source of additional behavior in this PR.

## Implementation Record

Implemented in PR #36 on rebased head `ba9df831a81863676b9c840b812532dabf412ea2`,
then squash-merged into `main` as
`e1426cf7e52ddb54b2c0b6e741d536efb14540df`.

The implementation adds one authenticated browser EventSource, validates and
de-duplicates named invalidation envelopes, and reuses existing REST loaders
for mounted JobCard, report, and staff surfaces. Job detail protects active
editing and pending commands with an explicit stale-data reload action.

Final automated verification:

- web: 613 tests passed; build, bundle budget, responsive smoke, and audit
  passed;
- server: build, 955 tests passed with 36 expected skips, and audit passed;
- GitHub Actions CI: server and web jobs passed on the rebased head (run
  `29774052932`).

Manual verification passed:

- two concurrent authenticated sessions reconciled open list, board, detail,
  report, and staff surfaces through canonical REST reads;
- server restart/replay resumed from the cursor without duplicate refreshes;
- Safari background/resume reconciled through visibility and focus recovery;
- an active detail editor retained local input and showed its stale-data action
  after a remote change.

The merge deleted the `feature/sse-web-client` source branch; local stale
remote-tracking references were pruned after `main` was fast-forwarded to the
merge commit.
