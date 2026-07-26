# Phase U — Servora Workspace Implementation Plan
## Three substantial delivery slices

**Status:** Proposed implementation plan
**Date:** 2026-07-25
**Design spec:** `docs/superpowers/specs/2026-07-25-phase-u-servora-workspace-design.md`
**Prerequisite:** Phase T4 complete, merged, and resulting `main` CI successful
**Execution rule:** Preflight first; then U1 → U2 → U3; then Phase T5

---

## 1. Planning rules

This plan intentionally uses three large, coherent delivery slices.

Do not fragment Phase U into one PR per widget, route, breakpoint, notification kind or test file.

A slice may use internal commits/checkpoints, but it should remain one coherent product review unit unless repository preflight proves that a single PR would be unsafe or unreviewable.

Any proposed split beyond U1/U2/U3 requires external authorization.

---

## 2. Global repository rules

Operate in dedicated clean worktrees.

Do not modify or clean the main workspace.

Never use:

```bash
git reset --hard
git restore .
git checkout -- .
git stash
git stash apply
git stash pop
git clean
git add .
git add -A
git rebase
git pull --rebase
git push --force
git push --force-with-lease
```

Do not open or expose:

```text
.env
credentials
private keys
API keys
cookies
production logs
database dumps
real customer/patient data
push endpoints
precise production coordinates
message bodies from real users
```

Every implementation checkpoint uses:

```text
appropriate Superpowers skill
→ GPT Terra 5.6 implementation
→ focused validation
→ full validation
→ GPT Terra 5.6 direct self-review
→ GPT Terra 5.6 direct Playwright / Chrome DevTools verification
→ handoff
```

GPT Terra 5.6 is the sole implementation and review agent unless the user explicitly changes the workflow. Self-review must not be described as independent review.

---

# U0 — Repository preflight and final plan reconciliation

## Goal

Confirm repository reality after Phase T4 and convert this proposed plan into exact file-level implementation instructions without changing code.

## Authorization

```text
U0 preflight:
AUTHORIZED only after Phase T4 is merged and main CI succeeds

Application changes:
NOT AUTHORIZED
```

## Required investigation

### Routes and shell

Inspect:

```text
web/src/AppRouter.tsx
web/src/paths.ts
web/src/AppShell.tsx
web/src/styles.css
navigation and authorization helpers
post-login redirect behavior
```

### Existing data and APIs

Trace:

```text
jobs
reports
notes
notifications
SSE
Web Push
users/staff
customers
products
authentication/profile
file upload/object storage
```

### Existing UI primitives

Inspect:

```text
web/src/ui/
web/src/ui/antd/
report chart primitives
table/list primitives
feedback/state primitives
form contracts
visual/accessibility tests
```

### Server architecture

Identify:

```text
route registration
service/repository patterns
authorization services
migration numbering
outbox/projection patterns
worker lifecycle
clock/idempotency abstractions
audit logging patterns
feature/capability flags
```

## Required decisions

U0 must answer:

1. exact role enum/capability names,
2. exact overview API pattern,
3. whether existing reports APIs can power U1 without duplication,
4. whether safe avatar storage already exists,
5. whether jobs already contain schedulable start/end fields,
6. whether calendar should project job scheduling or own separate event records,
7. the existing audit-log convention,
8. notification-kind registration points,
9. the correct SSE invalidation/reconciliation path,
10. exact file/test lists for U1/U2/U3,
11. exact migration numbers,
12. whether any proposed feature requires a separate dependency gate.

## Preflight validation

Run safe read-only searches and existing tests as useful.

No code, docs, branch, commit, push or PR changes.

## U0 handoff

Status:

```text
READY_FOR_EXTERNAL_REVIEW
or
BLOCKED
```

Required gate ending:

```text
U1 implementation:
NOT AUTHORIZED

U2 implementation:
NOT AUTHORIZED

U3 implementation:
NOT AUTHORIZED

T5:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED
```

## U0 reconciled binding decisions

The approved baseline ends at `016_google_reverse_geocoding.sql`. `017_calendar.sql` (U2) and `018_messaging.sql` (U3) are provisional candidates, not irrevocable reservations. At the start of U2 and again at the start of U3, fetch the exact authorized `main`, inspect every migration, fail closed if the candidate number is occupied, and use the next available sequential number.

U1 introduces the smallest server-configured, default-off, server-authoritative capability bootstrap. The authenticated current-user contract contains:

```ts
capabilities: {
  overviewDashboard: boolean;
  calendar: boolean;
  messaging: boolean;
}
```

Both `POST /api/auth/login` and `GET /api/auth/me` return the same contract because the web shell renders directly from the login response. No separate `/api/capabilities` endpoint is planned. Client visibility is not authorization; routes and services gate each capability independently.

Dependency decisions: charts and the first calendar release require no new dependency; docs/help use typed repository-managed content with no Markdown renderer; avatar processing is deferred behind a separate storage/security gate; messaging is plain-text rendering with no sanitizer dependency; timezone/date handling follows existing platform conventions unless U2 proves a gap.

---

# U1 — Workspace foundation, overview, docs/help and settings

## Recommended branch

```text
feat/phase-u-workspace-overview
```

## Recommended PR title

```text
feat: add role-aware Servora workspace overview
```

## User-visible goal

Provide a useful landing page for staff and managers/admins while adding the support and account destinations that complete the application shell.

## Scope

### 1. Overview route and redirect

Implement:

```text
/overview
```

Update:

- root route,
- post-login destination,
- sidebar navigation,
- mobile navigation/drawer,
- route authorization.

Requirements:

- enabled users land on overview,
- unauthorized routes remain protected,
- deep links still work,
- disabled capability falls back safely to the current destination,
- no redirect loop.

### 2. Shared overview primitives

Create the minimum Servora-owned primitives needed for:

- KPI summary,
- dashboard section heading,
- trend/change value,
- action list,
- recent item list,
- chart container,
- compact calendar placeholder contract for future U2 data.

Prefer semantic DOM and CSS contracts over a generic widget framework.

Do not introduce shadcn/Tailwind.

Do not create a universal `Card` abstraction.

### 3. Overview API/service

Implement the role-authoritative overview query established in U0.

The response is a role-specific union of `StaffOverviewResponse` and `ManagementOverviewResponse`; protected datasets are never joined in the browser.

Staff response should support:

- today's work,
- in progress,
- revision requested,
- completed period,
- recent completed work,
- recent authorized notes when safe,
- deep-link filters.

Manager/admin response should support:

- awaiting approval,
- overdue,
- revision requested,
- completed today,
- completion trend,
- work-type distribution if already derivable safely,
- recent completed work,
- recent authorized notes,
- attention-required deep links.

Requirements:

- authorization server-side,
- bounded collections,
- stable ordering,
- server-authoritative dates,
- no N+1 behavior,
- deterministic tests,
- no notes from inaccessible JobCards.

### 4. Staff overview

Implement a role-specific composition.

Acceptance:

- maximum four primary KPIs,
- one clear first operational section,
- recent completed list,
- recent note list only when authorized,
- no other-staff performance,
- no manager-only queues,
- deep links preserve intended filters.

### 5. Manager/admin overview

Implement:

- up to four primary KPIs,
- completion trend,
- attention-required queue,
- recent completed work,
- work-type distribution only if U0 confirms reliable data,
- date-period control when supported.

Reuse existing reporting data and chart primitives where possible.

Do not duplicate report calculations in the browser.

### 6. Documentation

Add `/docs`.

Initial delivery:

- product-use categories,
- versioned content metadata,
- role/audience visibility,
- Turkish content structure,
- legal-document placeholders clearly marked as requiring authorized supplied text.

Do not invent final KVKK/legal content.

### 7. Help Center

Add `/help`.

Implement:

- categorized troubleshooting content,
- safe self-service steps,
- “do not share” guidance,
- configured support contact display.

Do not hardcode a personal administrator email in client code.
Support contact information is authenticated runtime configuration returned alongside the current-user bootstrap contract, or through a small authenticated runtime-config response; it is not an unauthenticated public endpoint.

Do not add a ticket system in U1.

### 8. Profile and settings

Add settings routes/surfaces:

```text
/settings/profile
/settings/security
/settings/notifications
```

Implement according to existing APIs:

- read-only current-user/profile presentation,
- password change using existing auth rules,
- existing Web Push device/subscription controls only,
- avatar display with initials fallback.

Do not promise a self-profile mutation. U1 has no stored notification-category preference model. Avatar decision: `DISPLAY + INITIALS ONLY; UPLOAD DEFERRED`.

### 9. Capability flag

Add or use:

```text
OVERVIEW_DASHBOARD_ENABLED
```

Requirements:

- default off,
- server-authoritative capability,
- disabled server path,
- hidden navigation,
- safe fallback route,
- explicit tests.

## Behavior invariants

U1 contains no migration, calendar persistence, messaging, avatar upload, stored notification-category preferences, new dependency, or invented legal/KVKK text. Overview data is server-authoritative: recent lists are bounded, stably ordered and authorization-filtered in repository/service code. Report calculation reuse occurs within server repositories/services, never through internal HTTP calls or browser recomputation. Work-type distribution remains U3 unless existing repository data provides it without a new calculation.

Exact U1 source candidates include:

```text
server/src/config.ts
server/src/app.ts
server/src/modules/auth/types.ts
server/src/modules/auth/service.ts
server/src/modules/auth/handlers.ts (only if response composition requires it)
server/src/modules/capabilities/types.ts
server/src/modules/capabilities/service.ts
server/src/modules/overview/{types,repository,service,handlers,routes,query}.ts
web/src/services/api.ts
web/src/App.tsx
web/src/AppRouter.tsx
web/src/AppShell.tsx
web/src/paths.ts
web/src/shell/navigation-model.ts
```

No `server/src/modules/capabilities/handlers.ts` or `routes.ts` is planned because no separate capability endpoint is needed.

Do not change:

- job state machine,
- allowed commands,
- report calculations unless a separately reviewed correctness defect exists,
- note visibility,
- role authorization,
- customer/product behavior,
- notification behavior,
- login/session security.

## Candidate tests

Exact files are finalized in U0.

Minimum coverage:

### Server

- staff overview scope,
- manager/admin overview scope,
- inaccessible JobCard notes absent,
- stable date boundaries,
- collection limits/order,
- capability disabled,
- report-data reuse correctness.

### Web

- root/post-login redirect,
- navigation visibility,
- staff dashboard,
- manager dashboard,
- KPI deep links,
- empty/error/retry,
- docs/help routes,
- settings validation,
- accessibility,
- responsive contracts.

## Browser matrix

```text
staff overview: 390 / 1024 / 1440
manager overview: 390 / 1024 / 1440
empty overview
error/retry
docs/help
settings
200% text zoom
```

Check console, network, focus and overflow.

## Validation

At minimum:

```bash
cd web
npm ci
npm run audit:high
npm test -- --run
npm run build
npm run bundle:check
npm run smoke:responsive
```

Server:

```bash
cd server
npm ci
npm audit --audit-level=high
npm run build
npm test -- --run
```

If local DB tests are unavailable, do not expose secrets; exact-head CI is authoritative.

Boundary checks:

```bash
rg -n "from ['\"]antd['\"]|from ['\"]antd/" web/src \
  --glob '!ui/antd/**'

rg -n "servora-visual-tokens" web/src \
  --glob '!ui/antd/**' \
  --glob '!ui/servora-visual-tokens.ts'
```

## U1 evidence

Synthetic, PII-free captures:

```text
staff-overview-390
staff-overview-1024
manager-overview-390
manager-overview-1440
overview-empty
overview-error
docs
help
settings
```

## U1 done criteria

- U1 exact-head local validation passes,
- GPT Terra 5.6 direct self-review passes,
- browser verification passes,
- PR diff contains no U2/U3 implementation,
- PR Ready separately authorized,
- merge separately authorized,
- resulting main CI succeeds.

## U1 gates

```text
U1 code and automated-test implementation:
COMPLETE — Draft PR checkpoint

U1 direct browser verification:
COMPLETE — Playwright MCP matrix plus Chrome DevTools MCP spot-check

U1 persistent visual evidence:
COMPLETE — `docs/ui/screenshots/phase-u-u1/`

U1 visual acceptance:
COMPLETE — Draft PR remains subject to separate Ready authorization

U1 integration:
COMPLETE — merged at 5d5ee5dc15638b94ed3c3267971839b4c6fa36dd

U1 Ready:
NOT AUTHORIZED by this plan

U1 Merge:
NOT AUTHORIZED by this plan

U2:
COMPLETE — Draft PR #72 on clean branch feat/phase-u-calendar-planning-clean
  PR #71 CLOSED (superseded by clean replacement)
  Visual code SHA: d516a61f8a8a8b6add2a5e3d19354ffebc8ff839
```

## U1 implementation checkpoint

```text
Exact authorized base:
06a0d2a92d1776874ec5de13cf2d15e7c5e7460b

Exact source/test implementation commit:
0d45d501a0ace8c54555efaccb431780a2818476
```

The authenticated bootstrap now exposes default-off
`overviewDashboard`, `calendar`, and `messaging` capabilities with login and
`/me` parity. Safe support configuration is authenticated, narrowly validated,
and fails unsafe email, non-HTTPS, credential-bearing, or malformed values
closed.

`GET /api/overview` is server-gated and returns a discriminated Staff or
Management response. It reuses report calculations directly. Staff recent work
and note previews are derived only after assigned-JobCard authorization;
Manager/Admin results are organization-scoped. SQL bounds both recent lists to
10 and uses timestamp plus ID ordering.

The web checkpoint adds capability-aware root/login routing, disabled Overview
fallback to Jobs, grouped desktop navigation, a maximum-four-control mobile
model with secondary destinations in Menü, role-specific Overview UI, typed
Docs/Help content, read-only initials Profile, existing password-change
semantics, and current-device Web Push controls. Realtime carries only the
`overview` invalidation key and canonical REST refetch remains authoritative.

Automated validation:

```text
Focused server:
7 files / 120 tests PASS

Full local server DB suite:
109 files / 1323 of 1324 tests PASS on a disposable migrated database
One environment-contract test cannot pass because the local Homebrew
PostgreSQL host accepts an intentionally wrong password through trust auth
Security: no .env or credential was opened, copied or created
Final authority: exact-head GitHub CI server job

Full web:
90 files / 1004 tests PASS

Server/web builds:
PASS

Server audit:
0 vulnerabilities

Web audit:
PASS_WITH_WAIVER — existing GHSA-qwww-vcr4-c8h2 RSC-only waiver

Bundle:
PASS — 39 JavaScript chunks within the 500000-byte limit

Responsive smoke:
PASS
```

Terra direct self-review found one concrete U1 defect: unsafe optional support
URL/mailto values could survive client parsing. Server validation and client
parsing were tightened to fail credential-bearing URLs and unsafe mailto forms
closed, and regression coverage was added. Boundary review found no migration,
dependency, U2/U3 source module, or new Ant/token boundary violation.

Direct Playwright MCP verification completed the Staff and Manager
390/1024/1440 matrix, Admin 1024 check, empty/error states, Docs/Help/Settings,
mobile drawer, keyboard focus, and capability-disabled fallback. Chrome
DevTools MCP independently repeated the Manager 1024 console/network and
rendered-state check. No horizontal overflow, clipped inspected headings,
application console errors, unexpected network failures, role leakage,
password values, push endpoints, or keys were observed.

Persistent evidence:

```text
Directory:
docs/ui/screenshots/phase-u-u1/

PNG count:
12

Exact visual code/capture head:
2e353a461729b483668c36ae914a4ff580a8991b
```

Remaining U1 acceptance steps:

1. Obtain separate PR Ready authorization after external review.
2. Obtain separate merge authorization and verify resulting-main CI.

---

# U2 — Calendar, scheduling and reminders

## Recommended branch

```text
feat/phase-u-calendar-planning-clean
```
(Original branch feat/phase-u-calendar-planning superseded by clean replacement #72)

## Recommended PR title

```text
feat: add staff work calendar and reminders
```

## User-visible goal

Allow staff to understand upcoming work and allow authorized managers to plan/reschedule staff work with audit history and reliable reminders.

## Scope

### 1. Data model and migration

Implement the U0-approved model for:

- calendar event,
- job relation,
- assigned user,
- start/end/timezone,
- source type,
- version/concurrency,
- audit history,
- reminders.

Current candidate migration: `017_calendar.sql`, subject to the U0 provisional-number policy. The hybrid ownership model is binding:

```text
JOB: projected from authoritative JobCard scheduling; no lifecycle duplication
MANUAL: stored in calendar_events for authorized operational planning only
```

Current JobCard has `scheduled_at`, no scheduled end/duration, and its version-controlled patch owns schedule changes. U2 may add `job_cards.scheduled_ends_at` without moving lifecycle authority. Both job-backed and manual records are organization-scoped. Conflict semantics use `[start, end)`.

Requirements:

- safe migration,
- indexes for user/time queries,
- organization scope,
- foreign keys,
- no duplication of job lifecycle,
- rollback behavior documented,
- retention/privacy consistent with repository conventions.

### 2. Calendar service and API

Implement:

- list own events,
- list authorized team events,
- create authorized manual event,
- assign/reschedule,
- cancel where permitted,
- conflict detection,
- stale-write protection,
- related-job deep link.

Use existing service/repository/authorization patterns.

### 3. Staff calendar UI

Add `/calendar`.

Staff experience:

- day/week/month or the smallest accepted view set from U0,
- upcoming list,
- related-job navigation,
- authorized create/edit only,
- clear empty/error states,
- mobile-safe interaction.

Do not ship a visually rich but operationally unusable calendar.

### 4. Manager calendar UI

Authorized manager/admin experience:

- filter by staff/team,
- inspect workload,
- create/assign/reschedule,
- see overlap warning,
- confirm meaningful changes,
- audit-visible actor.

No hidden staff or cross-organization visibility.

### 5. Dashboard upcoming-work widget

Replace any U1 placeholder/omission with real bounded calendar data.

Staff:

- today/tomorrow/upcoming.

Manager:

- authorized upcoming team schedule or attention-required scheduling signal.

### 6. Reminder worker

Implement reminder scheduling and dispatch using current worker/outbox patterns.

Candidate kinds:

```text
calendar_assigned
calendar_rescheduled
calendar_cancelled
calendar_reminder
```

Requirements:

- idempotent dedupe key,
- server clock,
- retry classification,
- graceful shutdown,
- disabled flag,
- no provider I/O inside open DB transaction,
- privacy-safe Web Push,
- in-app deep link,
- observability.

### 7. Capability flag

Add/use:

```text
CALENDAR_ENABLED
```

Default off.

Disabled mode must block:

- route/navigation,
- API mutations,
- reminder claims/dispatch,
- calendar dashboard widget.

## Behavior invariants

Do not change:

- job lifecycle,
- job assignment authorization,
- notification delivery guarantees,
- Web Push privacy rules,
- existing job start geolocation,
- report semantics.

## Required server tests

- staff own-scope list,
- manager team-scope list,
- cross-organization denial,
- create/assign authorization,
- overlap detection,
- end-before-start rejection,
- time-zone/date-boundary behavior,
- stale update conflict,
- audit creation,
- job-backed event invariants,
- reminder exact boundary,
- reminder dedupe,
- retry/abandon behavior,
- disabled capability lifecycle,
- notification deep link.

## Required web tests

- staff calendar,
- manager filters,
- permission-hidden edit controls,
- event create/edit,
- conflict warning,
- stale-write error,
- dashboard upcoming widget,
- empty/error/retry,
- accessibility,
- responsive contracts.

## Browser matrix

```text
staff calendar 390 / 1024 / 1440
manager calendar 390 / 1024 / 1440
busy week
empty calendar
overlap conflict
reschedule confirmation
dashboard upcoming widget
notification deep link
200% text zoom
```

## Validation

Full server and web validation, security audit, bundle, responsive smoke, boundary checks, GPT Terra 5.6 direct self-review, GPT Terra 5.6 direct Playwright / Chrome DevTools verification, and handoff.

## U2 evidence

Synthetic:

```text
staff-calendar-390
staff-calendar-1024
manager-calendar-1440
manager-calendar-filtered
calendar-conflict
calendar-empty
overview-upcoming-staff
overview-upcoming-manager
calendar-notification
```

## U2 done criteria

- migration and service review approved,
- authorization matrix verified,
- audit history verified,
- reminders idempotent,
- browser verification passed,
- exact-head CI green,
- PR merge and resulting-main CI separately accepted.

## U2 implementation checkpoint — 2026-07-26 (clean replacement)

Implemented on `feat/phase-u-calendar-planning-clean` (replaces contaminated
`feat/phase-u-calendar-planning`) from the clean U1 baseline
`5d5ee5dc15638b94ed3c3267971839b4c6fa36dd`.

### Server

- `017_calendar.sql` with JobCard end time, manual events, field-level audit,
  reminder state machine, and calendar notification/realtime constraints,
- Staff self scope, Manager `staff_profiles.manager_user_id` team scope, and Admin
  organization scope,
- canonical JobCard rescheduling with transactional conflict checks, reminder
  replacement/cancellation, audit, realtime, and notification projection,
- deterministic reminder worker with bounded claims, leases, retry/abandon, in-app
  projection, optional Web Push delivery rows, and graceful shutdown.

### Web

- monthly notice-calendar with ServoraCalendar adapter (Ant Calendar wrapper),
- selected-day agenda beside/below the month grid,
- ResponsiveFormDrawer for create/edit forms,
- half-open shared date helper (`calendar-date.ts`) used by both grid and agenda,
- grid/agenda parity verified by 15 dedicated date-helper tests,
- `dayjs` 1.11.21 declared as direct dependency,
- Staff/Manager/Admin role-based calendar views,
- CALENDAR_CONFLICT preserves draft in drawer,
- capability-off fallback (`/calendar` → `/jobs`),
- 200% text zoom support.

### Automated verification

```text
server build: PASS
server PostgreSQL regression: 113 files / 1353 tests PASS
web tests: 93 files / 1038 tests PASS
web build: PASS
bundle budget: PASS (44 chunks, each <= 500000 bytes)
responsive smoke: PASS
antd boundary: PASS (Calendar + Drawer adapters)
visual token boundary: PASS
```

### Browser verification

```text
Playwright MCP complete: 16 PNGs recaptured
Roles: Staff (390/1024/1440), Manager (390/1440/1024 filtered), Admin (1024)
States: monthly grid, agenda, drawer create, conflict, zoom, deep-link, capability-off overview, notifications
Console: 0 application errors (benign 401/409 expected)
Network: 0 unexpected failures
Exact visual code/capture SHA: d516a61f8a8a8b6add2a5e3d19354ffebc8ff839
```

### Persistent evidence

`docs/ui/screenshots/phase-u-u2/` — 16 PNGs, README with full metadata matrix.

## U2 gates

```text
U2 implementation:
COMPLETE — Draft PR #72

U2 calendar correctness:
COMPLETE

U2 browser verification:
COMPLETE

U2 persistent evidence:
COMPLETE

U2 Ready:
NOT AUTHORIZED

U2 Merge:
NOT AUTHORIZED

U3:
NOT AUTHORIZED until U2 merge/main-CI acceptance
```

---

# U3 — Messaging and advanced dashboard analytics

## Recommended branch

```text
feat/phase-u-messaging-dashboard
```

## Recommended PR title

```text
feat: add operational messaging and dashboard analytics
```

## User-visible goal

Enable scoped manager/staff communication and complete the role-specific dashboard with unread messages, performance and distribution insights.

## Scope

### 1. Messaging data model and migration

Implement:

- conversation,
- participants,
- message,
- read/unread state,
- optional related job,
- idempotent client action id,
- timestamps and indexes.

No attachments or group chat.

Current candidate migration: `018_messaging.sql`, subject to the U0 provisional-number policy. It proposes these constraints:

```text
UNIQUE (organization_id, direct_key)
UNIQUE (conversation_id, user_id)
UNIQUE (conversation_id, sender_user_id, client_action_id)
```

The server generates `direct_key` from the sorted participant pair plus `GENERAL` or `JOB:<jobId>`. Unread state uses `last_read_message_id`; its deterministic read and pagination cursor contains `created_at` and `id`. Message order is `created_at ASC, id ASC`. Body is 1..4000 code points of plain text, with no trusted HTML. Push and dashboard notifications must not contain a message body.

### 2. Messaging service and API

Implement:

- list authorized conversations,
- create/find one-to-one conversation,
- page messages,
- send text message,
- mark/read reconciliation,
- unread counts,
- job-linked conversation,
- disabled-user behavior.

Requirements:

- server-side participants,
- bounded body size,
- safe plain-text rendering,
- stable ordering,
- bounded pagination,
- duplicate-submit protection,
- cross-organization denial,
- privacy-safe body-free message summary metadata.

### 3. Messaging UI

Add `/messages`.

Implement:

- conversation list,
- thread view,
- unread indicators,
- send/retry/pending behavior,
- job deep link,
- mobile layout,
- empty/error states,
- keyboard/focus behavior.

Do not embed the full chat UI in overview.

### 4. Notifications and real-time invalidation

Add:

```text
message_received
```

Integrate:

- notification center,
- optional Web Push,
- SSE invalidation/reconciliation,
- unread badge in shell,
- dashboard unread summary.

Push must not expose sensitive message content. A generic safe notification may be preferable.

### 5. Dashboard message widget

Show:

- unread total,
- bounded recent thread summaries,
- sender,
- generic privacy-safe unread status, never a message-body preview,
- time,
- thread link.

### 6. Advanced staff dashboard

Add only metrics supported by existing authorization and reliable data:

- personal sales or completed value,
- completion trend,
- recent completed work,
- work-type distribution if useful personally.

Do not create organization comparison for staff.

### 7. Advanced manager/admin dashboard

Add:

- staff sales/performance,
- work-type distribution,
- staff workload,
- period-over-period change,
- recent completed work,
- recent notes,
- message summary.

Detailed analytics remain in Reports.

### 8. Capability flag

Add/use:

```text
MESSAGING_ENABLED
```

Default off.

Disabled mode blocks:

- navigation,
- APIs,
- notification projection,
- SSE/message invalidation,
- dashboard message widget.

## Behavior invariants

Do not change:

- existing authorization,
- job notes behavior,
- report source calculations without approved correctness work,
- notification privacy,
- SSE delivery semantics,
- Web Push lifecycle,
- user-management rules.

## Required server tests

- participant authorization,
- one-to-one uniqueness/lookup,
- cross-organization denial,
- body validation,
- duplicate client action,
- stable ordering/pagination,
- unread count,
- mark-read reconciliation,
- disabled/deleted user behavior,
- job-link authorization,
- notification projection idempotency,
- capability disabled,
- dashboard analytics scope.

## Required web tests

- conversation list/thread,
- send pending/retry,
- duplicate-submit guard,
- unread badge,
- read reconciliation,
- deep links,
- mobile message layout,
- overview message widget,
- staff analytics privacy,
- manager analytics,
- chart accessible summaries,
- empty/error/retry,
- responsive/accessibility contracts.

## Browser matrix

```text
staff messages 390 / 1024
manager messages 390 / 1024
unread thread
send failure/retry
job-linked thread
staff advanced overview 390 / 1440
manager advanced overview 390 / 1440
empty analytics
200% text zoom
```

## Validation

Full server/web suites, audits, build, bundle, responsive smoke, boundary checks, GPT Terra 5.6 direct self-review, GPT Terra 5.6 direct Playwright / Chrome DevTools verification, and handoff.

## U3 evidence

Synthetic:

```text
messages-list-390
message-thread-390
message-thread-1024
message-send-error
overview-messages
staff-overview-final-1440
manager-overview-final-1440
manager-work-type-distribution
manager-staff-performance
```

## U3 done criteria

- messaging authorization approved,
- idempotency/unread reconciliation approved,
- notification privacy approved,
- dashboard role privacy approved,
- exact-head CI green,
- PR merged with resulting-main CI successful,
- Phase U design and plan docs updated factually,
- Phase T5 remains not started until external authorization.

## U3 gates

```text
U3 implementation:
AUTHORIZED only after U2 merge/main-CI external acceptance

U3 Ready:
NOT AUTHORIZED by this plan

U3 Merge:
NOT AUTHORIZED by this plan

Phase U complete:
ONLY after U3 merge and resulting-main CI success

T5:
NOT AUTHORIZED until Phase U external closeout
```

---

# Phase U closeout

After U3 merge:

1. verify all capabilities and routes on resulting main,
2. verify exact merge-commit CI,
3. run complete authorization/privacy review,
4. verify notification/worker health,
5. verify worktrees clean,
6. update design and plan status,
7. preserve production flags off,
8. return for external closeout.

Required final handoff:

```text
U1:
COMPLETE

U2:
COMPLETE

U3:
COMPLETE

Phase U:
READY_FOR_EXTERNAL_REVIEW

T5:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED
```

---

# Phase T5 relationship

Phase T5 must run after Phase U and include:

- Overview,
- Calendar,
- Messages,
- Documentation,
- Help Center,
- Settings,
- all previous application surfaces.

T5 owns:

- final application-wide loading/empty/error/success consistency,
- 390–1440 regression matrix,
- 400% reflow closeout,
- final visual evidence index,
- residual state-dialect cleanup.

Phase U slices should implement correct local states but must not absorb an unrelated application-wide state migration.
