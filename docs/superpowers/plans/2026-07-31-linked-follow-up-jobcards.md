# Linked Follow-up JobCards — Implementation Plan

- **Status:** Ready for external review (documentation checkpoint; NOT to be implemented in this PR)
- **Date:** 2026-07-31
- **Base:** `33aa7997a24a335a773017e521002db86ff2bd90` (merge of PR #81)
- **Design:** [`../specs/2026-07-31-linked-follow-up-jobcards-design.md`](../specs/2026-07-31-linked-follow-up-jobcards-design.md)
- **Repository:** `emrahozcelik/servora-med` (monorepo: `server/` Fastify + PostgreSQL, `web/` React/Vite)

> **Execution rule:** this plan is the contract for the future implementation PR(s). Every slice must be executed as its own PR against `main` after the design is externally reviewed. This documentation PR changes **no source, migration, test, or package files**.

---

## 1. Current repository inventory (evidence)

Verified against base `33aa7997a24a335a773017e521002db86ff2bd90`:

| Area | Evidence |
|---|---|
| JobCard table | `server/src/db/migrations/002_delivery_tracer.sql`: `job_cards` (`id`, `organization_id`, `type`, `status` CHECK incl. `NEW/ACCEPTED/IN_PROGRESS/WAITING_APPROVAL/REVISION_REQUESTED/COMPLETED/CANCELLED`, `version`, `title`, `description`, `customer_id`, `assigned_to`, `created_by`, `priority`, `due_date`, `scheduled_at`, lifecycle timestamps, `created_at`, `updated_at`; `UNIQUE (organization_id, id)`; composite FKs to `users`/`customers`; status-timestamp CHECKs). No link column exists. |
| Meeting details | `007_sales_meeting.sql`: `job_card_meeting_details` (`meeting_at`, `outcome` CHECK `POSITIVE/FOLLOW_UP_REQUIRED/NO_DECISION/NOT_INTERESTED`, `meeting_summary`, `next_follow_up_at` CHECK `next_follow_up_at > meeting_at`). |
| Acceptance/scheduling | `009_job_acceptance_and_scheduling.sql`: added `accepted_at`, `accepted_by`, `scheduled_at`; removed `PLANNED`; `JOB_ACCEPTED` event. |
| Latest migration | `021_job_card_note_added_notification_kind.sql`. Next free number: **022**. |
| Migration contract test | `server/tests/migrate-runner.test.ts` asserts the exact ordered migration list and `expectedSchemaVersion` (currently 21) — must be extended with `022` in slice F1. |
| JobCard types | `server/src/modules/job-cards/types.ts`: `JOB_CARD_STATUSES`, `JOB_CARD_TYPES` (`PRODUCT_DELIVERY`, `GENERAL_TASK`, `SALES_MEETING`), `JOB_CARD_ENGAGEMENT_KINDS` (incl. `FOLLOW_UP`), activity events. |
| Reach policy | `server/src/modules/job-cards/policy.ts`: `actorCanReachJob` = same org && (role !== `STAFF` \|\| `assigned_to === actor.id`); `forbidden()` → `403`. |
| Creation | `server/src/modules/job-cards/service.ts` `create()` (line ~314): idempotency claim `operationKey: 'JOB_CREATE'` + `clientActionId`, then insert, activity, notifications, realtime. |
| Idempotency | `server/src/modules/job-cards/repository.ts`: `processed_actions` table; `findCompletedCriticalAction` / `executeCriticalAction` (line ~1207/1219): `processing` claim, replay of stored response, conflict → `ACTION_IN_PROGRESS` 409. Note op-key precedent: `JOB_NOTE_ADD:<jobCardId>` (`notes-service.ts`). |
| Lifecycle | `service.ts` `runLifecycle` (line ~1013) with per-command operation keys (`JOB_ACCEPT_ASSIGNMENT`, `JOB_START`, `JOB_SUBMIT_FOR_APPROVAL`, `JOB_APPROVE`, `JOB_REQUEST_REVISION`, `JOB_WITHDRAW_FROM_APPROVAL`, `JOB_RESUME`, `JOB_CANCEL`). `COMPLETED`/`CANCELLED` yield no commands (policy). |
| Routes | `server/src/app.ts`: `jobCardRoutes` at prefix `/api/job-cards` (line 196), `peopleRoutes` at `/api` (line 208), `calendarRoutes` at `/api/calendar` (line 248), `crmRoutes` at `/api` (line 269). Route style: `app.get('/:id', secured, h.x)` in `server/src/modules/*/routes.ts`; handlers in `handlers.ts` receive typed DTOs. |
| Notifications | `server/src/modules/notifications/policy.ts` `createJobCardNotificationDrafts`: `JOB_CREATED → job.assigned` (to assignee), `JOB_ASSIGNED → job.reassigned`, `JOB_APPROVED → job.approved`, `JOB_REVISION_REQUESTED → job.revision_requested`, `JOB_CANCELLED → job.cancelled`, `JOB_SUBMITTED_FOR_APPROVAL → management`. Payloads: `entityType: 'job-card'`, `entityId` only (bodyless). |
| Realtime | `server/src/modules/realtime/event-mapper.ts` `JOB_CREATED` → resource keys `job-board`, `job-detail:<jobCardId>`, `job-list`, `reports`, `overview`, `staff-profile:<afterAssigneeId>` (+`<beforeAssigneeId>` on reassignment); `audience.ts` `buildJobCardAudience` = `[afterAssigneeId]` + roles `['ADMIN','MANAGER']`, org-scoped. Web push payloads bodyless. |
| Customer detail | `server/src/modules/crm/repository.ts` `getCustomerDetail` (line ~322): embedded `openJobs`/`completedJobs` slices (5 each) with `staffScope = role==='STAFF' ? " AND assigned_to = $actor" : ''` (line 339). `customerHasActiveJobs`/`customerHasAnyJobs` exist. |
| People | `server/src/modules/people/service.ts`: `requireAdmin` (33), `requireAdminOrManager` (37), `getOwnStaffProfile` (245, STAFF self), `getStaffProfile` (250, `requireAdminOrManager`). Routes: `GET /api/staff`, `/api/staff/me`, `/api/staff/:userId` (`people/routes.ts` lines 22–25). Counters via `StaffOperationalSummaryPort` (`open`, `waitingApproval`, `revisionRequested`, `completedThisMonth`, `overdue`). No job-history list. |
| Calendar | `server/src/modules/calendar/repository.ts` `CALENDAR_LIST_SQL` joins `job_cards`, `customers`, assignee `users`; `event()` builds `JobCalendarEvent` (`jobCardId`, `relatedJobPath`). `service.ts`: staff see only own `assigned_to`; management org-wide. |
| Web | `web/src/paths.ts` (`/jobs/:id`, `/jobs/new-delivery`, `/jobs/new-task`, `/jobs/new-meeting`); `web/src/AppRouter.tsx` routes; `web/src/jobs/jobs-api.ts` parsers (`JobCard`, `JobCardCreateInput` discriminated by type); `web/src/JobDetail.tsx` (1178 lines, `JobDetailPanel`, `isManagementUser`); `web/src/jobs/JobNotes.tsx`/`JobTimeline.tsx`; `web/src/jobs/MeetingDetails.tsx` (`nextFollowUpAt` editing; `FOLLOW_UP_REQUIRED` label "Takip gerekli"); `web/src/CustomerDetail.tsx` (142 lines, uses embedded `openJobs`/`completedJobs`); `web/src/StaffProfiles.tsx` (111 lines, `OwnStaffProfileView`); `web/src/calendar/CalendarPage.tsx` + `web/src/services/calendar-api.ts` (`JobCalendarEvent`); `web/src/realtime/RealtimeProvider.tsx` (`useRealtimeInvalidation`); `web/src/overview/OverviewPage.tsx` invalidates `['overview']`. |
| Visual language | `docs/superpowers/specs/2026-07-26-servora-ant-visual-language.md` (Canvas/Section/Card/Emphasized Card/Raised Layer; `OperationalCard.tsx` pattern). |
| Note privacy precedent | `docs/superpowers/specs/2026-07-29-job-lifecycle-operational-notes-design.md` §privacy: notes are shared append-only operational history; staff-profile notes management-confidential. Its plan (line 249) explicitly defers linked follow-ups to a separate gate — this plan is that gate. |
| Precedent decision | `docs/superpowers/specs/2026-07-12-customers-contacts-design.md` line 50: "completed work creates a linked follow-up JobCard instead of reopening the completed record". |

---

## 2. Gap analysis

| # | Gap | Closes with |
|---|---|---|
| G1 | No persistence for the follow-up relationship or instructions. | Migration 022 + row mapping in `job-cards/types.ts`. |
| G2 | No creation path restricted to `COMPLETED` sources and management role. | New service method + policy checks + routes. |
| G3 | No idempotency key space for follow-up creation. | `JOB_FOLLOW_UP_CREATE:<sourceJobCardId>` claim, reusing `executeCriticalAction`. |
| G4 | Staff cannot see any safe source context; full source is 404 for non-own staff. | New restricted-context endpoint + DTO. |
| G5 | Customer history has no pagination, no role-filtered counts, no link metadata. | New `/api/customers/:customerId/jobs` endpoint + DTO counts; web pagination. |
| G6 | Staff profile has counters but no job-history list. | New `/api/staff/:userId/jobs` endpoint + web section. |
| G7 | Calendar events carry no follow-up indicator or restricted context. | `CALENDAR_LIST_SQL` LEFT JOIN + `followUp` payload field. |
| G8 | No management entry point / form for follow-up creation. | New web route `/jobs/new-follow-up?source=<id>` + source-detail actions. |
| G9 | `FOLLOW_UP_REQUIRED` has no management action surface (recommendation exists in MeetingDetails only). | Recommendation panel on completed `SALES_MEETING` source detail (management). |
| G10 | Realtime does not invalidate the source detail or customer detail on follow-up creation. | Extended `JOB_CREATED` mapping resource keys. |

---

## 3. Chosen data model (design R1–R2)

Self-referencing columns on `job_cards` (Option A — see design §7.1 for the rejection of the link table):

- `source_job_card_id UUID NULL` — direct parent; immutable after creation; `ON DELETE RESTRICT`.
- `follow_up_instructions TEXT NULL` — management-authored; required iff `source_job_card_id IS NOT NULL`.

Derived (never stored): `isFollowUp` (`source_job_card_id IS NOT NULL`), `childCount`, chain depth. `SALES_MEETING` `engagementKind` remains the existing `FOLLOW_UP` value; no new enum values anywhere.

---

## 4. Migration

**File:** `server/src/db/migrations/022_job_card_follow_up_links.sql`

```sql
ALTER TABLE job_cards
  ADD COLUMN source_job_card_id UUID NULL,
  ADD COLUMN follow_up_instructions TEXT NULL;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_source_fk
  FOREIGN KEY (organization_id, source_job_card_id)
  REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_self_link_check
  CHECK (source_job_card_id IS DISTINCT FROM id);

-- present-iff contract, enforced in BOTH directions:
-- root cards never carry instructions; follow-ups always do.
ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_instructions_check
  CHECK (
    (source_job_card_id IS NULL AND follow_up_instructions IS NULL)
    OR
    (source_job_card_id IS NOT NULL AND follow_up_instructions IS NOT NULL)
  );

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_instructions_length_check
  CHECK (
    follow_up_instructions IS NULL
    OR (
      char_length(follow_up_instructions) BETWEEN 1 AND 4000
      AND follow_up_instructions ~ '[^[:space:]]'
    )
  );

CREATE INDEX job_cards_follow_up_source_idx
  ON job_cards (organization_id, source_job_card_id, created_at DESC)
  WHERE source_job_card_id IS NOT NULL;
```

Note: the iff CHECK is same-row (`source_job_card_id` lives on the same row), so it is fully expressible — consistent with existing CHECK style (`002`, `007`). The length/whitespace constraint stays separate so the iff CHECK stays purely structural.

**Contract test:** extend `server/tests/migrate-runner.test.ts` migration list with `022_job_card_follow_up_links.sql` and `expectedSchemaVersion` to 22. Migration behavior tests must prove all four cases: `root + instructions → rejected`, `follow-up + null instructions → rejected`, `root + null instructions → accepted`, `follow-up + valid instructions → accepted`.

---

## 5. Server architecture

| File | Change |
|---|---|
| `server/src/modules/job-cards/types.ts` | `JobCard` + `sourceJobCardId: string \| null`, `followUpInstructions: string \| null`; `JobCardDetail` + `sourceAccess: 'FULL' \| 'RESTRICTED'`, `sourceJobPath: string \| null`. New `FollowUpCreateInput`; new `RestrictedSourceContext` DTO (canonical time model + access mode); `FollowUpListItem`; `JobCardHistoryItem` link metadata (`followUp: { sourceJobCardId } \| null`, `childCount: number \| null`). |
| `server/src/modules/job-cards/create-input.ts` | `normalizeFollowUpCreateInput` — validates instructions presence/length, type-specific `scheduledAt`/`dueDate`, `engagementKind` against the real enum, contact ownership against the **inherited** customer, assignee existence via existing lookups. No `customerId` in the input: the server copies `source.customerId` (design R6). |
| `server/src/modules/job-cards/policy.ts` | `assertCanCreateFollowUp(actor)` → `STAFF` forbidden; `assertSourceEligible(source)` → `COMPLETED` only; `resolveSourceAccess(actor, source)` → `FULL` for management or the source card's current assignee, else `RESTRICTED`. |
| `server/src/modules/job-cards/repository.ts` | Row mappers + SQL: `getFollowUpSource(...)` (status, customer, contact, `scheduled_at`, `started_at`, `staff_completed_at`, `manager_approved_at`, `type`, meeting outcome), `listFollowUps(...)` (children, reach-filtered), `getSourceContext(...)` (follow-up → source → meeting details), `childCount` subquery. Implements `JobHistoryReadPort` (F3; interface in new `history-port.ts`). |
| `server/src/modules/job-cards/history-port.ts` (new) | `interface JobHistoryReadPort { listCustomerJobs(...); countCustomerJobs(...); listStaffJobs(...) }` — narrow read port owned by the job-cards domain, implemented by `PostgresJobCardRepository`. |
| `server/src/modules/job-cards/service.ts` | `createFollowUp(actor, sourceId, input)` — claim `JOB_FOLLOW_UP_CREATE:<sourceId>`; eligibility + chain-depth walk (max persisted depth 10); insert with inherited customer + link; `JOB_CREATED` activity with `metadata.sourceJobCardId`; existing notifications path; realtime with extra keys. `listFollowUps(actor, jobCardId)`, `getSourceContext(actor, jobCardId)` (returns `sourceAccess` + `sourceJobPath`). |
| `server/src/modules/job-cards/handlers.ts` + `routes.ts` | `POST /api/job-cards/:sourceId/follow-ups`, `GET /api/job-cards/:id/follow-ups`, `GET /api/job-cards/:id/source-context`. **No** `/source` endpoint (design R9: full access reuses the existing `GET /api/job-cards/:sourceId`). |
| `server/src/modules/crm/types.ts` + `repository.ts` + `service.ts` + `handlers.ts` + `routes.ts` | `CustomerDetail` gains `openJobCount`, `completedJobCount` (staffScope-filtered); embedded arrays removed; `GET /api/customers/:customerId/jobs`; `CrmService` constructor gains `JobHistoryReadPort`. |
| `server/src/modules/people/repository.ts` + `service.ts` + `handlers.ts` + `routes.ts` | `GET /api/staff/me/jobs` + `GET /api/staff/:userId/jobs` (Admin/Manager any; STAFF self-only via existing guard style); `PeopleService` constructor gains `JobHistoryReadPort`. |
| `server/src/modules/calendar/repository.ts` + `types.ts` | `CALENDAR_LIST_SQL` LEFT JOIN to source `job_cards src` + `job_card_meeting_details md` (for `sourceOccurredAt`); `followUp` payload per canonical time model + management-only `sourceJobPath`. |
| `server/src/modules/realtime/event-mapper.ts` | `JOB_CREATED` mapping appends `job-detail:<sourceJobCardId>`, `customer-detail:<customerId>` when present. |
| `server/src/modules/job-cards/activity-presenter.ts` | No behavioral change required; `JOB_CREATED` metadata (`sourceJobCardId`) is bodyless-presented (verify in F1 with a test). |
| `server/src/modules/job-cards/validation.ts` | Register new route input schemas (Fastify JSON schema style used by the module). |
| `server/src/app.ts` | F1: `LOGGER_REDACT_PATHS` += `'req.body.followUpInstructions'` (next to existing `'req.body.body'`). F3: constructor wiring — `new CrmService(dependencies.crmRepository, jobCardRepository)` and `new PeopleService(dependencies.peopleRepository, ..., dependencies.reportsRepository, jobCardRepository)` where `jobCardRepository` satisfies `JobHistoryReadPort`; update `AppDependencies` shape only if needed. |

---

## 6. API contracts

### 6.1 `POST /api/job-cards/:sourceId/follow-ups` (new)

Request (`FollowUpCreateInput`):

```jsonc
{
  "clientActionId": "uuid",                       // required, idempotency key
  "type": "PRODUCT_DELIVERY | GENERAL_TASK | SALES_MEETING",
  "title": "string 1..255 non-whitespace",
  "followUpInstructions": "string 1..4000 non-whitespace",   // REQUIRED (D3); immutable after creation (D15)
  "scheduledAt": "ISO | null",                    // required for PRODUCT_DELIVERY, SALES_MEETING
  "scheduledEndsAt": "ISO | null",
  "assignedTo": "uuid",
  "priority": "low | normal | high | urgent",     // default normal
  "dueDate": "YYYY-MM-DD | null",                 // not allowed for SALES_MEETING
  // NO customerId: the server inherits source.customerId (design R6).
  // contactId must belong to the inherited customer.
  "contactId": "uuid | null",
  "engagementKind": "SALES_MEETING | CUSTOMER_VISIT | PRODUCT_DEMO | TRAINING | FOLLOW_UP | OTHER | null"
  // real JobCardEngagementKind enum (server/src/modules/job-cards/types.ts);
  // required for type SALES_MEETING, must be null for other types;
  // create-form default: source's engagementKind, or FOLLOW_UP when the source has none.
}
```

Responses:

- `201` — full `JobCardDetail` (now including `sourceJobCardId`, `followUpInstructions`, `sourceAccess`, `sourceJobPath`).
- `400 VALIDATION_ERROR`, `400 FOLLOW_UP_INSTRUCTIONS_REQUIRED`.
- `403 FORBIDDEN` — STAFF or cross-org.
- `404 JOB_CARD_NOT_FOUND` — source id not found / other org (anti-enumeration).
- `409 FOLLOW_UP_SOURCE_NOT_COMPLETED` — source not `COMPLETED`.
- `409 CONTACT_NOT_IN_CUSTOMER`, `409 CUSTOMER_INACTIVE`, `409 CONTACT_INACTIVE`, `409 ASSIGNEE_NOT_FOUND`.
- `409 JOB_FOLLOW_UP_CHAIN_DEPTH_EXCEEDED`.
- `409 ACTION_IN_PROGRESS` — duplicate concurrent claim.
- Idempotent replay — `201` with stored response.

### 6.2 `GET /api/job-cards/:id/follow-ups` (new)

`{ items: FollowUpListItem[], total, limit, offset }`; reach = `actorCanReachJob` on `:id`. `FollowUpListItem = JobCardListItem + { sourceJobCardId, followUpInstructions }`. Sort `created_at DESC, id`.

### 6.3 Source access mode (replaces any dedicated full-source endpoint)

No `/source` endpoint exists (design R9). Every follow-up-carrying response (follow-up detail, source-context) exposes:

```ts
sourceAccess: 'FULL' | 'RESTRICTED'
sourceJobPath: string | null   // non-null IFF sourceAccess === 'FULL'
```

- `FULL` — `ADMIN`/`MANAGER`, or the **source card's current assignee** (own-history reach via `actorCanReachJob`). The client navigates with `sourceJobPath` to the **existing** `GET /api/job-cards/:sourceId` route.
- `RESTRICTED` — everyone else with follow-up reach; no path is delivered; only the source-context DTO is available.
- Mode is derived per request from current role/assignment — no stored grants.

### 6.4 `GET /api/job-cards/:id/source-context` (new, restricted DTO)

Contract per design §6.2 (canonical time model: `sourcePlannedAt` = `scheduled_at`, `sourceOccurredAt` = `SALES_MEETING → meeting_at`, else `started_at`, fallback `staff_completed_at`, `sourceCompletedAt` = `manager_approved_at`; exact UI labels "Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi"). Response includes `sourceAccess` and `sourceJobPath` (§6.3). Reach: actor must reach `:id` (the follow-up). `404` when not a follow-up or source unreachable. Access mode derived from **current** `assigned_to`; reassignment re-derives.

### 6.5 `GET /api/customers/:customerId/jobs` (new)

Query: `status=open|completed|all` (default `all`), `limit` (default 20, max 100), `offset`. Response `Paginated<CustomerJobHistoryItem>` (shape per design §8.2). `staffScope` applied for `STAFF`; `childCount` `null` for `STAFF`. `404` when customer not found/other org. Data via `JobHistoryReadPort` (§5, F3). `CustomerDetail` DTO gains `openJobCount`/`completedJobCount`; embedded `openJobs`/`completedJobs` arrays are removed in the same slice.

### 6.6 Staff history (new)

Canonical routes (consistent with existing `/api/staff`, `/api/staff/me`, `/api/staff/:userId` conventions):

- `GET /api/staff/me/jobs?status=open|completed|all&limit&offset` — own history; `STAFF` and management.
- `GET /api/staff/:userId/jobs?status=open|completed|all&limit&offset` — any org staff; `ADMIN`/`MANAGER` only; `STAFF` on another user's id → `404` (existing own-profile guard style).

Same query/response shape as §6.5; `childCount` management-only; data via `JobHistoryReadPort`.

### 6.7 Calendar payload change

`JobCalendarEvent` gains `followUp: null | { sourceJobCardId, sourcePlannedAt, sourceOccurredAt, sourceCompletedAt, instructions }` (canonical time model, design §6.2) and management-only `sourceJobPath`. Backwards-compatible additive change (web parser tolerates optional fields).

---

## 7. Web surfaces

| Surface | Change |
|---|---|
| `web/src/paths.ts` | `newFollowUp: (sourceId: string) => \`/jobs/new-follow-up?source=${sourceId}\``. |
| `web/src/AppRouter.tsx` | Route for `/jobs/new-follow-up` → `FollowUpCreatePage` (management-guarded like the other create routes). |
| `web/src/jobs/jobs-api.ts` | `JobCard` parser gains `sourceJobCardId`, `followUpInstructions`, `sourceAccess`, `sourceJobPath`; new `createFollowUp()`; new parsers for `FollowUpListItem`, `RestrictedSourceContext`, `JobCardHistoryItem`. |
| `web/src/JobDetail.tsx` | (a) Management + `COMPLETED`: primary action "Takip işi oluştur" + (SALES_MEETING with `FOLLOW_UP_REQUIRED`) recommendation panel (Emphasized Card); (b) follow-up detail: "Takip" badge; (c) children panel "Takip işleri" (reach-filtered server-side); (d) chain breadcrumb (management only; staff see own reachable ancestors); (e) source panel: `sourceAccess: 'FULL'` → normal link via `sourceJobPath`; `'RESTRICTED'` → safe context panel with exact date labels ("Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi") and no source link. |
| `web/src/FollowUpCreatePage.tsx` (new, under `web/src/jobs/`) | Form per contract 6.1; source summary panel (safe structured info); pre-fills `scheduledAt = nextFollowUpAt` when source is SALES_MEETING with proposal and `engagementKind` from the source (or `FOLLOW_UP`); customer shown read-only (inherited server-side, never sent); loading/success/error states; mobile-first layout per visual language; 403/404/409 error mapping incl. `FOLLOW_UP_SOURCE_NOT_COMPLETED` and `ACTION_IN_PROGRESS`. |
| `web/src/CustomerDetail.tsx` | Replace embedded slices with paginated history (tabs open/completed/all, "Takip" badge, pagination controls); counts from new DTO fields. |
| `web/src/StaffProfiles.tsx` | "İş geçmişi" paginated section (self + management view), using `/api/staff/me/jobs` and `/api/staff/:userId/jobs`. |
| `web/src/calendar/CalendarPage.tsx` + `web/src/services/calendar-api.ts` | Follow-up indicator + management source deep link (`sourceJobPath`) / staff restricted context inline (planned/occurred/completed dates with exact labels + instructions, no source link). |
| `web/src/realtime/RealtimeProvider.tsx` | No change needed; existing invalidation by resource key covers new keys automatically (verify in runtime). |

---

## 8. Permission matrix

| Action | ADMIN | MANAGER | STAFF (assignee, performed source) | STAFF (assignee, not source) | STAFF (not assignee) |
|---|---|---|---|---|---|
| Create follow-up from `COMPLETED` source | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Create from non-`COMPLETED` source | ❌ 409 | ❌ 409 | — | — | — |
| View follow-up detail | ✅ | ✅ | ✅ | ✅ | ❌ 404 |
| View follow-up children | ✅ | ✅ | ✅ (own) | ✅ (own) | ❌ 404 |
| Source access mode (`sourceAccess`) | `FULL` + path | `FULL` + path | `FULL` + path (own history) | `RESTRICTED`, no path | ❌ 404 (no context either) |
| View full source (existing `GET /api/job-cards/:sourceId`) | ✅ | ✅ | ✅ (own history) | ❌ 404 | ❌ 404 |
| View restricted context (`/source-context`) | ✅ (FULL supersedes) | ✅ | ✅ | ✅ | ❌ 404 |
| View customer history | ✅ all | ✅ all | ✅ own rows/counts | ✅ own rows/counts | ✅ own rows/counts |
| View staff history (`/api/staff/me/jobs`, `/api/staff/:userId/jobs`) | ✅ any | ✅ any | ✅ self only | ✅ self only | ✅ self only |
| Calendar: follow-up event | ✅ all | ✅ all | ✅ own + context | ✅ own + context | ✅ own only |
| Calendar: `sourceJobPath` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `childCount` in history payloads | ✅ | ✅ | ❌ (null) | ❌ (null) | ❌ (null) |

All cross-org access resolves to `404`/`403` via existing reach rules; no new role logic beyond `assertCanCreateFollowUp` (design D2, D7) and `resolveSourceAccess` (design R9).

---

## 9. Idempotency

- **Claim:** `JOB_FOLLOW_UP_CREATE:<sourceJobCardId>` + `clientActionId` per actor — follows the `JOB_NOTE_ADD:<jobCardId>` precedent and reuses `executeCriticalAction` (`processed_actions` claim → insert → `JOB_CREATED` activity with the same `clientActionId` → notifications → realtime).
- Duplicate request → stored `201` response replay; concurrent duplicate → `409 ACTION_IN_PROGRESS`.
- The chain-depth walk happens inside the critical work; depth check failures mark the claim `failed` (existing pattern).
- No other new mutations: follow-up lifecycle uses existing per-command keys. **`follow_up_instructions` is immutable after creation (design D15): it is not part of the generic PATCH field set at all** — a patch attempting it yields `400 VALIDATION_ERROR` (unknown field), and no `JOB_FIELDS_UPDATED` path can touch it. F1 tests cover this.

---

## 10. Activity / audit

- `JOB_CREATED` on the follow-up carries `sourceJobCardId` in **`metadata` only** (`metadata.sourceJobCardId`) — single canonical field, not duplicated into `new_value` (design §13.5, R14); one activity record; source card untouched (append-only history).
- `JOB_ASSIGNED` fires only if management reassigns immediately after creation (existing path).
- No new event type; `job_card_activity_logs` CHECK constraints unchanged.
- Activity timeline on the follow-up works exactly like any JobCard (existing `GET /:id/activity`); presenter stays bodyless for `JOB_CREATED` metadata.

---

## 11. Notification / realtime reuse

| Event | Notifications | Realtime |
|---|---|---|
| Follow-up created (initial assignee) | `job.assigned` draft to assignee (`JOB_CREATED` mapping) — no new kind (design D11) | `job.created`; keys += `job-detail:<sourceId>`, `customer-detail:<customerId>` (design D12) |
| Reassignment right after creation | `job.reassigned` (`JOB_ASSIGNED` path) | existing reassignment mapping |
| Any later lifecycle event | existing kinds | existing keys |

SSE and web-push payloads remain bodyless (`entityId` only). Audience unchanged (`buildJobCardAudience`). No notification content ever carries source notes/outcome beyond the follow-up's own fields.

---

## 12. Implementation slices

### F1 — Linked data + server creation contract

- **Scope:** migration `022`; `types.ts`; `create-input.ts`; `policy.ts`; `repository.ts` (source/link queries); `service.ts` `createFollowUp` + `listFollowUps` + `getSourceContext`; `handlers.ts`/`routes.ts` (3 new routes; **no** `/source` route); validation schemas; activity presenter test; `migrate-runner.test.ts` update; **log redaction** in `server/src/app.ts`.
- **Changed files (server):** as listed; plus `server/src/app.ts` (`LOGGER_REDACT_PATHS` += `'req.body.followUpInstructions'`), `server/tests/migrate-runner.test.ts`, new `server/tests/job-card-follow-up.test.ts`, `server/tests/job-card-follow-up-activity.test.ts`, `server/tests/job-card-follow-up-policy.test.ts`, `server/tests/job-card-follow-up-idempotency.test.ts`, `server/tests/job-card-follow-up-log-privacy.test.ts`.
- **Tests:**
  - Migration contract: `022` in the exact ordered list, `expectedSchemaVersion` 22; behavior cases `root + instructions → rejected`, `follow-up + null instructions → rejected`, `root + null → accepted`, `follow-up + valid → accepted`.
  - Creation happy path (each type); instructions required (400); `engagementKind` enum validation + default; STAFF create → 403; source not COMPLETED → 409; contact not-in-inherited-customer → 409; **no `customerId` in the request (rejected as unknown field); server inherits source customer**; chain: **source at depth 10 rejects creation of depth-11 child** (409); self-link impossible; children list reach filtering; restricted context content + exclusions; `sourceAccess: 'RESTRICTED'` + `sourceJobPath: null` for non-source assignee; `'FULL'` + path for management **and for the source card's current assignee**; follow-up detail carries `sourceAccess`/`sourceJobPath`; instructions immutable (patch attempt → 400); replay + concurrent claim; activity record with `metadata.sourceJobCardId` only (not in `new_value`); realtime keys `job-detail:<source>` / `customer-detail:<customer>`; notification `job.assigned` (no new kind).
  - Log privacy: unique instruction marker → request/error logs must not contain it (with and without `LOGGER_REDACT_PATHS` regression guard).
- **Runtime scenarios:** seeded org; ADMIN creates follow-up for COMPLETED delivery; verify board/detail/activity; verify restricted context + access mode as second staff user and as the source's own assignee; verify 400/403/404/409 paths.
- **Completion gate:** `cd server && npm run build`, `cd server && npm test -- --run`, `cd server && npm run lint`; all green; contract tests updated.
- **Non-goals:** no web changes; no customer/staff/calendar endpoints (F3); no instruction editing.
- **PR:** single PR `feat: linked follow-up JobCard server contract` against `main`.

### F2 — Follow-up creation + JobDetail continuity UI

- **Scope:** `paths.ts`, `AppRouter.tsx`, `FollowUpCreatePage.tsx` (new), `JobDetail.tsx` (create action, badge, children panel, chain breadcrumb, source panel with `sourceAccess`/`sourceJobPath` modes), `jobs-api.ts` parsers; `MeetingDetails.tsx` untouched except navigation constants.
- **Changed files (web):** as listed; new `web/src/jobs/FollowUpCreatePage.tsx`, `web/src/jobs/follow-up-presentation.ts` (labels/badges incl. exact date labels "Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi"), new web tests for parser + form validation.
- **Tests:** web build; parser tests for new fields (`sourceAccess`, `sourceJobPath`, time model); form error mapping (409s); management-only action visibility; RESTRICTED panel renders no source link (component-level).
- **Runtime scenarios:** as ADMIN create follow-up from completed SALES_MEETING with `FOLLOW_UP_REQUIRED`; as STAFF open the follow-up: restricted panel visible with exact date labels, no source link; as the source card's own assignee: `FULL` mode with working link; as second STAFF (not assignee): 404 page; mobile viewport check.
- **Completion gate:** `cd web && npm run build`, `cd web && npm run lint`; server contract from F1 still green; manual flows verified (see §15).
- **Non-goals:** customer/staff/calendar surfaces (F3); instruction editing (immutable by design).
- **PR:** `feat: linked follow-up JobCard creation UI`.

### F3 — Customer / Staff / Calendar history integration

- **Scope:** new `server/src/modules/job-cards/history-port.ts` (`JobHistoryReadPort`) implemented by `PostgresJobCardRepository`; crm `types.ts`/`repository.ts`/`service.ts`/`handlers.ts`/`routes.ts` (constructor wiring, counts + `/jobs` endpoint, embedded arrays removed); people `repository.ts`/`service.ts`/`handlers.ts`/`routes.ts` (constructor wiring, `/api/staff/me/jobs` + `/api/staff/:userId/jobs`); **`server/src/app.ts` dependency wiring** for `CrmService` and `PeopleService` (+ test wiring in unit-test constructors); calendar `repository.ts`/`types.ts` (`followUp` payload per canonical time model, `sourceJobPath`); web `CustomerDetail.tsx`, `StaffProfiles.tsx`, `CalendarPage.tsx`, `calendar-api.ts`; realtime key `customer-detail:<id>`.
- **Changed files:** as listed; new `server/tests/crm-job-history.test.ts`, `server/tests/people-job-history.test.ts`, `server/tests/calendar-follow-up.test.ts`; updated `server/tests/crm-routes.test.ts` (embedded arrays removed), web parser/history tests.
- **Tests:** role-filtered rows + counts (staff sees only own); `childCount` null for STAFF; pagination (limit clamp, offset); staff self-only history (`/api/staff/:userId/jobs` → 404 for STAFF on others, `/api/staff/me/jobs` works); calendar payload (time model fields + management-only `sourceJobPath`); realtime invalidation; app-level wiring smoke test (services constructed with the port).
- **Runtime scenarios:** staff user opens customer with other staff's completed jobs → own rows only, counts exclude others; manager sees all + childCount; calendar shows follow-up indicator for manager with source link, staff without; staff profile history pagination.
- **Completion gate:** full command battery (server build/test/lint, web build/lint); no compatibility fallbacks retained.
- **Non-goals:** no new notification kinds; no calendar schema changes.
- **PR:** `feat: role-filtered follow-up history surfaces`.

### F4 — Runtime acceptance & evidence closeout

- **Scope:** end-to-end verification against real PostgreSQL + Fastify + Vite (test database seeded per AGENTS.md workflow), multi-role browser walkthrough, privacy scenario sweep, evidence capture. **F4 is a separate PR whose required persistent change is the canonical evidence artifact** `docs/evidence/linked-follow-up-jobcards/f4/README.md` (acceptance results, screenshots, payload/log captures, command outputs) — no empty PRs (design R-F4).
- **Steps:**
  1. Fresh schema via migrations 001–022; seed org with ADMIN, MANAGER, staff A, staff B, customer+contacts, products.
  2. As staff A: complete a PRODUCT_DELIVERY and a SALES_MEETING (`FOLLOW_UP_REQUIRED` + `nextFollowUpAt`).
  3. As ADMIN: create follow-ups (same assignee, different assignee, chain of 2, sibling); verify notifications (`job.assigned`) and realtime invalidation in two browser sessions.
  4. As staff B (follow-up assignee, not source): verify restricted context contents/exclusions, `sourceAccess: 'RESTRICTED'` with no `sourceJobPath`, calendar restricted context, customer history own-only.
  5. As staff A (source assignee): verify `sourceAccess: 'FULL'` + working source link.
  6. Negative sweep: staff create → 403; source not completed → 409; instructions missing → 400; instruction patch → 400; duplicate `clientActionId` → replay; source at depth 10 rejects depth-11 child → 409.
  7. Capture evidence: test logs, browser screenshots of restricted panel/calendar/customer history, network payload checks (bodyless SSE/notification payloads), **log-file check (instruction marker absent)**.
- **Completion gate:** all acceptance scenarios pass; `docs/evidence/linked-follow-up-jobcards/f4/README.md` committed with the evidence; `git diff --check` clean.
- **PR:** `test: linked follow-up JobCard runtime acceptance` (separate; includes the canonical evidence artifact — this decision is fixed, not deferred).

**PR sequencing rule:** F1 → F2 → F3 → F4, each against `main`, each gated by its completion gate. Design doc decisions are not re-negotiable in PR review unless a real defect is found (then a follow-up design amendment PR updates this document).

---

## 13. File-level change map (cumulative)

Server (new): `server/src/db/migrations/022_job_card_follow_up_links.sql`, `server/src/modules/job-cards/history-port.ts`, `server/tests/job-card-follow-up.test.ts`, `server/tests/job-card-follow-up-activity.test.ts`, `server/tests/job-card-follow-up-policy.test.ts`, `server/tests/job-card-follow-up-idempotency.test.ts`, `server/tests/job-card-follow-up-log-privacy.test.ts`, `server/tests/crm-job-history.test.ts`, `server/tests/people-job-history.test.ts`, `server/tests/calendar-follow-up.test.ts`.

Server (modified): `server/src/app.ts` (F1: `LOGGER_REDACT_PATHS` += `req.body.followUpInstructions`; F3: `CrmService`/`PeopleService` constructor wiring), `server/src/modules/job-cards/types.ts`, `create-input.ts`, `policy.ts`, `repository.ts`, `service.ts`, `handlers.ts`, `routes.ts`, `validation.ts`, `activity-presenter.ts` (only if presenter test demands); `server/src/modules/crm/{types,repository,service,handlers,routes}.ts`; `server/src/modules/people/{repository,service,handlers,routes}.ts`; `server/src/modules/calendar/{repository,types}.ts`; `server/src/modules/realtime/event-mapper.ts`; `server/tests/migrate-runner.test.ts`; `server/tests/crm-routes.test.ts` (embedded arrays removed).

Web (new): `web/src/jobs/FollowUpCreatePage.tsx`, `web/src/jobs/follow-up-presentation.ts`, web test files for parsers/form.

Web (modified): `web/src/paths.ts`, `web/src/AppRouter.tsx`, `web/src/JobDetail.tsx`, `web/src/jobs/jobs-api.ts`, `web/src/CustomerDetail.tsx`, `web/src/StaffProfiles.tsx`, `web/src/calendar/CalendarPage.tsx`, `web/src/services/calendar-api.ts`.

Docs (new, F4): `docs/evidence/linked-follow-up-jobcards/f4/README.md` — canonical evidence artifact (mandatory persistent change for F4; no empty PRs).

Docs (modified, after implementation): this plan's slice checkboxes marked done per AGENTS.md §11; design doc only on defect-driven amendments.

No dependency, package, or lockfile changes (AGENTS.md §10).

---

## 14. Test matrix

| Priority (AGENTS.md §9 order) | Scenario | Layer |
|---|---|---|
| 1 | Auth/role: STAFF create → 403; cross-org → 404/403 | server |
| 2 | Staff access boundaries: children/reach/context after reassignment | server |
| 3 | Follow-up creation: each type, management role | server + web |
| 4 | State machine: follow-up lifecycle identical to normal JobCard | server (existing lifecycle tests reused) |
| 5 | Invalid transition rejection: unchanged for follow-ups | server (existing) |
| 6 | Manager approval: follow-up needs approval like any card | server (existing) |
| 7 | Revision request: unchanged on follow-ups | server (existing) |
| 8 | Required fields: `followUpInstructions` required; type-specific scheduling | server + web |
| 9 | Activity log: `JOB_CREATED` + `metadata.sourceJobCardId`; no source mutation | server |
| 10 | Idempotency: replay + concurrent claim (`ACTION_IN_PROGRESS`) | server |
| 11 | Report correctness: follow-ups appear in existing reports (no report changes; regression only) | server (existing) |
| 12 | Web vertical flows: create → board → detail → source panel modes → customer history → calendar | runtime (F4) |
| — | Privacy: restricted context exclusions; `sourceAccess` modes; `childCount` null; bodyless payloads; no `sourceJobPath` for RESTRICTED | server + runtime |
| — | Log privacy: instruction marker absent from request/error logs | server (F1) + runtime (F4) |
| — | Migration: 001–022 order + schema version 22; iff CHECK behavior (4 cases) | server |

---

## 15. Runtime acceptance (F4 checklist)

1. `docker`-managed PostgreSQL with migrations 001–022 applied; seed per §12-F4.
2. `cd server && npm run build && npm test -- --run && npm run lint` — green.
3. `cd web && npm run build && npm run lint` — green.
4. Browser walkthrough (Chrome): flows listed in §12-F4 with two staff sessions + one manager session.
5. Network tab: notification/SSE payloads contain ids only; `/source-context` payload matches contract exactly (incl. `sourceAccess`/`sourceJobPath` and the three date fields).
6. Log files: a unique instruction marker sent during F1/F4 flows is absent from request and error logs (redaction proof).
7. Mobile viewport (375px): create form, restricted panel, calendar event, customer history usable.
8. Console: no errors/warnings on the touched pages.

---

## 16. Evidence requirements

- Every slice PR description lists: changed files, commands run with outputs, runtime scenario results.
- F4 PR commits the canonical evidence artifact `docs/evidence/linked-follow-up-jobcards/f4/README.md` (screenshots, payload/log captures, command outputs) — evidence is a committed file, not only a description.
- This documentation checkpoint's own evidence: `git diff --check` output, `git status --short` (only the two docs), PR URL + state, base/head SHAs, and the external-review revision commit resolving blockers 1–9 (see the PR description and the final handoff).

---

## 17. Risk register

| Risk | Mitigation |
|---|---|
| Restricted context accidentally expanded later | Contract fixed in design §6; server DTO is the single source; tests assert exact exclusions. |
| `childCount` leakage | Management-only field, server-computed, `null` for STAFF; tested in F3. |
| Reassignment race on follow-up (access mode) | Mode derived from current `assigned_to` inside the read transaction; no stored grants; tests cover post-reassignment and post-source-reassignment modes. |
| Source time model misleads users | Canonical derivation table (§6.4); exact UI labels; no single "previous visit date" field anywhere. |
| Chain depth abuse | Service walk (max persisted depth 10) + immutable link; DB CHECK prevents self-link; off-by-one test names fixed. |
| Migration drift (migrate-runner) | F1 updates the exact-list test in the same PR as the migration. |
| Counts revealing other staff work in customer detail | Counts reuse the exact `staffScope` predicate; F3 tests assert equality with filtered list. |
| Log leakage of `follow_up_instructions` | `LOGGER_REDACT_PATHS` entry + dedicated log-capture test (F1) + runtime log check (F4). |
| History read-model wiring drift | `JobHistoryReadPort` owned by job-cards; constructor injection in `app.ts` + unit-test wiring asserted in F3. |
| Web payload regression (calendar additive field) | Optional-field parsing; runtime check in F4. |
| Scope creep during implementation | Slice non-goals are binding; PRs must not touch unrelated modules (AGENTS.md §3). |

---

## 18. Rollout and merge gates

1. This documentation PR: **Draft**, base `main` at `33aa7997a24a335a773017e521002db86ff2bd90`. Merge only after external review (GPT-5.6) approves the design. Merging and staging/production moves are **not authorized** in this checkpoint.
2. F1–F4: separate PRs per slice; each requires its completion gate green and the previous slice merged.
3. No migration is ever edited after application; no production data migration beyond `022` is anticipated (design R15 rollback path is pre-production-only, explicitly approved by the user).
4. On completion of every slice, update this plan (AGENTS.md §11) and the design doc only if a defect-driven amendment was approved.

---

## 19. External review revision log

2026-07-31 — GPT-5.6 review returned `REVISE REQUIRED` (9 blockers + consistency findings); this revision resolves them as follows:

| Blocker / finding | Resolution |
|---|---|
| B1 iff CHECK one-directional | Migration now enforces both directions; 4-case behavior test added (plan §4, design §7.2). |
| B2 `/source` contract contradiction | Dedicated full-source endpoint removed; `sourceAccess`/`sourceJobPath` on follow-up responses; existing detail route serves `FULL` (design R9, plan §6.3). |
| B3 create API customer/engagement | `customerId` removed from request (server inherits); `FOLLOW_UP_CUSTOMER_MISMATCH` removed; `engagementKind` uses the real 6-value enum with explicit default (design R19, plan §6.1). |
| B4 "previous visit date" semantics | Canonical time model `sourcePlannedAt`/`sourceOccurredAt`/`sourceCompletedAt` + exact UI labels (design R17, plan §6.4). |
| B5 history read-model wiring | New `JobHistoryReadPort` in job-cards, constructor injection into CRM/People services, `app.ts` + test wiring in file map (plan §5, F3). |
| B6 instruction mutability | Immutable after creation (design D15); no PATCH surface; tests added (plan §9, F1). |
| B7 chain depth off-by-one | Precise depth model (root 0, max persisted 10); test named "source at depth 10 rejects creation of depth-11 child" (design §7.4, plan F1/F4). |
| B8 F4 artifact | F4 is a fixed separate PR with canonical evidence file `docs/evidence/linked-follow-up-jobcards/f4/README.md` (plan §12-F4, §13). |
| B9 log privacy | `LOGGER_REDACT_PATHS` += `req.body.followUpInstructions` (F1) + log-capture test + runtime log check (design §13.7, plan F1/§15). |
| Design status wording | Now "Ready for external review" (design header). |
| Route inconsistency | Canonical `/api/staff/me/jobs` + `/api/staff/:userId/jobs` everywhere (design §9.2, plan §6.6). |
| Activity duplicate field | `sourceJobCardId` in `metadata` only, not `new_value` (design §13.5, plan §10). |
