# Persistent In-App Notification Center Design

**Date:** 2026-07-20
**Status:** Proposed — implementation must not start before this design and its plan are reviewed
**Delivery:** Phase P of `2026-07-19-browser-realtime-capabilities-roadmap-design.md`
**Dependencies:** SSE server foundation (PR #34) and SSE web reconciliation (PR #36)

## Objective

Add a small, durable notification read model for authenticated users. It gives
managers and staff a history of relevant JobCard actions, an unread badge, an
accessible in-app list, and a deep link to the affected JobCard.

This is not another source of JobCard truth. JobCard state, authorization,
activity history, and every detail shown after navigation continue to come from
the existing REST APIs. Notifications describe that an already-committed action
matters to the recipient.

## Scope

Included:

- recipient-addressed, persistent notification records;
- unread count, newest-first cursor-paginated list, and idempotent mark-read;
- semantic Turkish messages for a deliberately small JobCard event set;
- an AppShell notification trigger, badge, and responsive accessible panel;
- deep links to the existing JobCard route;
- canonical REST reload of the badge/list when SSE invalidates `notifications`;
- PostgreSQL, server, web, accessibility, and responsive verification.

Excluded:

- Web Push, VAPID, service workers, PWA/offline storage, toast standardisation,
  email/SMS/WhatsApp, browser notifications, and background delivery;
- WebSocket, Redis, Kafka, LISTEN/NOTIFY, a general event-sourcing projector,
  or an SSE transport redesign;
- new JobCard lifecycle transitions, activity records, permissions, DTO
  snapshots, or report metrics;
- bulk `mark all read` in the first slice. It remains a later product decision.

## Architectural Decision

### Transactional projection, not an asynchronous projector

The notification projection is inserted in the same database transaction as
the canonical JobCard activity and its existing `realtime_events` record.

```text
JobCard command
  -> activity log (canonical audit record)
  -> realtime event ledger (existing transport record)
  -> recipient notification rows (Phase P read model)
  -> transaction commit
  -> existing in-process realtime publish
  -> browser receives invalidation and re-reads notification REST resources
```

This has three required consequences:

1. A rolled-back command produces neither an activity, a realtime event, nor a
   notification.
2. An idempotent replay returns the stored command result and creates no new
   notification.
3. A committed event cannot be delivered to a user while its corresponding
   notification row is absent.

The Phase N ledger is the durable source link, but Phase P must not introduce a
separate background consumer. A projector is unnecessary until there is a
proven cross-process or deferred-delivery requirement.

## Data Model

Migration `012_create_in_app_notifications.sql` creates:

```sql
CREATE TABLE in_app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL,
  source_realtime_event_id BIGINT NOT NULL REFERENCES realtime_events(id),
  kind VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  UNIQUE (recipient_user_id, source_realtime_event_id),
  FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES users (organization_id, id),
  CHECK (entity_type = 'job-card')
);
```

Required indexes:

- `(organization_id, recipient_user_id, read_at, created_at DESC, id DESC)`
  for the unread badge and newest-first list;
- `(organization_id, recipient_user_id, created_at DESC, id DESC)` for stable
  cursor pagination;
- `(source_realtime_event_id)` for integrity diagnostics.

`kind`, entity identity, source event, and timestamps are stored. No title,
note, delivery data, customer/contact data, JobCard status snapshot, or actor
name is persisted in the notification row. The server presenter maps the
stable `kind` to a Turkish title/body at read time; the first slice intentionally
uses generic messages that do not need sensitive parameters.

Initial kinds and recipients:

| Source activity/realtime event | Notification kind | Recipients | Turkish message |
| --- | --- | --- | --- |
| `JOB_CREATED` / `job.created` | `job.assigned` | assigned staff, except the actor | `Size yeni bir iş atandı.` |
| `JOB_ASSIGNED` / `job.assignment_changed` | `job.reassigned` | new assignee, except the actor | `Size bir iş atandı.` |
| `JOB_SUBMITTED_FOR_APPROVAL` / `job.submitted_for_approval` | `job.awaiting_approval` | all active managers and admins, except the actor | `Bir iş yönetici kontrolüne gönderildi.` |
| `JOB_APPROVED` / `job.approved` | `job.approved` | current assignee, except the actor | `İşiniz onaylandı.` |
| `JOB_REVISION_REQUESTED` / `job.revision_requested` | `job.revision_requested` | current assignee, except the actor | `İşiniz düzeltme için geri gönderildi.` |
| `JOB_CANCELLED` / `job.cancelled` | `job.cancelled` | current assignee, except the actor | `İşiniz iptal edildi.` |

`JOB_ACCEPTED`, `JOB_STARTED`, field updates, planning, approval withdrawal,
and other existing realtime invalidations deliberately create no notification
in Phase P. They remain visible through the current workspace/detail
reconciliation. This avoids a persistent history of low-signal operational
events.

The notification policy is a pure server-side mapping. It must query active
management recipients inside the command transaction and produce no row when
the actor is the only possible recipient. Existing activity/realtime audience
rules remain unchanged; notification recipients are stricter, explicit users.

## Server Boundaries and API

Create `server/src/modules/notifications/` with focused types, repository,
service, handlers, routes, and a presenter. JobCard service owns when a source
activity is produced; the notification service owns recipient selection,
idempotent row creation, presentation, and recipient-scoped reads.

The JobCard transaction receives a notification transaction port alongside its
existing realtime transaction port. It appends notifications only after the
realtime event has been inserted and only for the mapped event kinds above.
The public JobCard command response is unchanged.

Authenticated, password-change-gated API routes:

```text
GET   /api/notifications/unread-count
GET   /api/notifications?limit=<1..50>&cursor=<opaque cursor>
PATCH /api/notifications/:notificationId/read
```

List order is `created_at DESC, id DESC`. The opaque cursor encodes exactly the
last item’s timestamp and ID; it is validated, not trusted. The list response
returns items and `nextCursor`. The unread endpoint returns `{ unreadCount }`.
`PATCH` is idempotent: an already-read notification returns its current public
DTO and does not change `read_at`.

Every repository query predicates both `organization_id` and
`recipient_user_id = currentUser.id`. A recipient cannot list, mark, infer, or
deep-link through another user’s notification ID. The deep-link target is
derived only from the public entity type and ID (`/jobs/:id`); the destination
still performs its existing canonical authorization read.

After successful notification creation, its source realtime event must include
the `notifications` resource key. This is an invalidation hint only, not a
notification payload. SSE replay and duplicate delivery therefore cause at
most repeated guarded REST reads; the database uniqueness constraint prevents
duplicate notification history.

## Web Composition and Accessibility

```text
authenticated AppShell
  -> NotificationCenter provider/controller
     -> existing RealtimeProvider subscription: notifications
     -> notification REST API
     -> badge trigger + responsive notification panel
```

The controller owns only UI fetch/pending/error state and reuses canonical
REST data. It must not parse JobCard lifecycle events or generate notification
messages from SSE envelopes.

- The AppShell header exposes one labelled notification button with a numeric
  unread badge; zero does not render a misleading badge.
- On desktop it opens a bounded panel; on small screens it uses the existing
  accessible drawer/dialog pattern. The chosen surface has `role="dialog"`, an
  accessible name, Escape close, focus containment, and focus restoration to
  the trigger.
- The panel handles loading, empty, error, and retry states. It does not reuse
  lifecycle confirmation dialogs or add global toast behaviour.
- Activating a notification first performs the existing idempotent mark-read
  request, then navigates to the derived JobCard path. A mark-read failure keeps
  the user on the panel and announces the error; it must not navigate as if the
  operation succeeded.
- Mark-read controls have explicit accessible names. Read/unread state is not
  conveyed by colour alone. Long messages and timestamps must wrap without
  horizontal scrolling at 320 CSS px / 400% reflow.
- While mounted, the controller subscribes to `notifications`; on matching SSE,
  reconnect, focus, visibility, online, and fallback reconciliation it reloads
  the unread count and reloads the current list page only when the panel is
  open. Its request gates prevent stale responses from restoring an obsolete
  read state.

## Error, Concurrency, and Security Rules

- List and unread-count failures preserve the last successful badge/list until
  an explicit retry succeeds; they do not invent a zero unread count.
- A pending mark-read disables only that notification’s action, preventing
  duplicate requests. The server still makes duplicate requests harmless.
- A missing/deleted target record is handled by the destination route’s normal
  not-found/authorization behaviour; notification history is not silently
  deleted or rewritten.
- Event replay, two tabs, and a second browser can all request the same
  mark-read. The database update is idempotent and the next canonical reload
  wins.
- Logs, SSE payloads, and notification rows never include session material,
  notes, deliveries, contacts, locations, or full JobCard snapshots.

## Test Contract

Server tests must prove:

- migration constraints/indexes and recipient/source-event uniqueness;
- recipient isolation across organizations, roles, inactive managers, actor
  exclusion, and unrelated staff;
- transaction rollback and idempotent command replay produce no duplicate row;
- each initial semantic mapping creates only its intended recipients;
- list ordering/cursor validation, unread count, and idempotent mark-read;
- authorization rejects cross-user/cross-organization list and mark-read;
- a notification-producing event invalidates `notifications` without changing
  the existing SSE envelope’s sensitive-data boundary.

Web tests must prove:

- badge/list load and loading/empty/error/retry states;
- semantic message rendering and deep-link navigation;
- pending duplicate-click protection and mark-read error behaviour;
- realtime `notifications` invalidation refreshes canonical REST data without
  creating client-side notifications;
- focus, Escape, focus restoration, keyboard operation, and mobile/desktop
  composition.

Browser smoke/manual tests cover 390, 720, 768, 1024, and 1440 px plus 200%
and 400% reflow; separate manager/staff sessions; another tab marking a row
read; replay/reconnect; and an inaccessible target deep link.

## Acceptance Criteria

1. A relevant committed JobCard action creates exactly one durable record per
   intended active recipient and none for unrelated users.
2. Badge and list use recipient-scoped canonical REST data and reconcile after
   SSE invalidation/recovery.
3. A user can mark only their own notification read, repeatedly without error,
   then open the affected JobCard through the existing route.
4. The UI is keyboard accessible, responsive, and does not leak recipient or
   JobCard metadata through SSE or cross-user APIs.
5. Existing activity, realtime, lifecycle, version, idempotency, build, test,
   responsive-smoke, and audit contracts remain intact.
