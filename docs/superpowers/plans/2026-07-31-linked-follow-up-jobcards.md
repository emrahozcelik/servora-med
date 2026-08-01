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
| G4 | Staff cannot see any safe source context; full source is 404 for non-own staff. | Embedded `followUpContext` (`sourceSummary`) on `JobCardDetail`; no standalone endpoint. |
| G5 | Customer history has no pagination, no role-filtered counts, no link metadata. | New `/api/customers/:customerId/jobs` endpoint + DTO counts; web pagination. |
| G6 | Staff profile has counters but no job-history list. | New `/api/staff/:userId/jobs` endpoint + web section. |
| G7 | Calendar events carry no follow-up indicator or restricted context. | `CALENDAR_LIST_SQL` LEFT JOIN + narrow `CalendarFollowUpContext` payload field. |
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

Note: the iff CHECK is same-row (`source_job_card_id` lives on the same row), so it is fully expressible — consistent with existing CHECK style (`002`, `007`). The length/whitespace constraint stays separate so the iff CHECK stays purely structural. Cross-row rules (completed-source eligibility, chain depth ≤ 10, same-customer consistency) are enforced in the **service**, not claimed for PostgreSQL alone — no trigger is planned.

**Contract test:** extend `server/tests/migrate-runner.test.ts` migration list with `022_job_card_follow_up_links.sql` and `expectedSchemaVersion` to 22. Migration behavior tests must prove all four cases: `root + instructions → rejected`, `follow-up + null instructions → rejected`, `root + null instructions → accepted`, `follow-up + valid instructions → accepted`.

---

## 5. Server architecture

| File | Change |
|---|---|
| `server/src/modules/job-cards/types.ts` | Internal/persisted domain `JobCard` gains `sourceJobCardId: string \| null`, `followUpInstructions: string \| null`. **Public detail omits the raw fields (fourth-review contract):** `JobCardDetail = Omit<PersistedJobCardDetail, 'lifecycle' \| 'sourceJobCardId' \| 'followUpInstructions'> & { workflowContext: JobWorkflowContext; followUpContext: JobCardFollowUpContext \| null }` — extends the existing derivation pattern (`types.ts:163-165`); top-level `sourceJobCardId`/`followUpInstructions` never appear on the public detail; follow-up values reach the client only inside `followUpContext`. Canonical types: `FollowUpSourceSummary` (`sourceType`, `sourcePlannedAt`, `sourceOccurredAt`, `sourceCompletedAt`, `customer`, `contact`, `outcome` — never repeats `sourceAccess`/`sourceJobPath`/`followUpInstructions`/`sourceJobCardId`), `JobCardFollowUpContext` (`sourceJobCardId`, `followUpInstructions`, `sourceAccess: 'FULL' \| 'RESTRICTED'`, `sourceJobPath: string \| null`, `sourceSummary`). No `RestrictedSourceContext` DTO and no `sourceContext` field. New `FollowUpCreateInput` (no `customerId`, no `scheduledEndsAt` — Repair 4); `FollowUpCreateReceipt = { jobCardId: string }` (stable processed-action result, Repair 1); `FollowUpListItem = JobCardListItem + { followUp: { sourceJobCardId: string } \| null }` (narrow list metadata, matching `JobCardHistoryItem`); `JobCardHistoryItem` link metadata (`followUp: { sourceJobCardId } \| null`, `childCount: number \| null`). |
| `server/src/modules/job-cards/create-input.ts` | `normalizeFollowUpCreateInput` — validates instructions presence/length, type-specific `scheduledAt`/`dueDate`, `engagementKind` against the real enum, contact ownership against the **inherited** customer, assignee existence via existing lookups. No `customerId` in the input: the server copies `source.customerId` (design R6). **Customer-null × type matrix** (Repair 2): source with customer → `GENERAL_TASK`/`PRODUCT_DELIVERY`/`SALES_MEETING`; customerless source → `GENERAL_TASK` only, others → `409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`. No `scheduledEndsAt` field exists in the input (Repair 4). |
| `server/src/modules/job-cards/policy.ts` | `assertCanCreateFollowUp(actor)` → `STAFF` forbidden; `assertSourceEligible(source)` → `COMPLETED` only; `resolveSourceAccess(actor, source)` → `FULL` for management or the source card's current assignee, else `RESTRICTED`. `resolveSourceAccess` is the **single shared resolver** used by the JobDetail presenter and the calendar presenter (Repair 3). |
| `server/src/modules/job-cards/repository.ts` | Row mappers + SQL: `getFollowUpSource(...)` (status, customer, contact, `scheduled_at`, `started_at`, `staff_completed_at`, `manager_approved_at`, `type`, meeting outcome), `listFollowUps(...)` (management-only children), `childCount` subquery, `getFollowUpReceipt(...)` (stored `FollowUpCreateReceipt`), plus the current-state reads used for re-presentation after completion/replay. Implements `JobHistoryReadPort` (F3; interface in new `history-port.ts`) via `listCustomerJobHistory` / `listStaffJobHistory`. |
| `server/src/modules/job-cards/history-port.ts` (new) | ```typescript
interface JobHistoryReadPort {
  listCustomerJobHistory(input: CustomerJobHistoryInput): Promise<PaginatedJobHistory>;
  listStaffJobHistory(input: StaffJobHistoryInput): Promise<PaginatedJobHistory>;
}
type PaginatedJobHistory = { items: JobCardHistoryItem[]; total: number; limit: number; offset: number };
```
Narrow read port owned by the job-cards domain, implemented by `PostgresJobCardRepository`. No `countCustomerJobs`/`countStaffJobs` methods — counts are derived from `total` of status-filtered lists (Repair 5). `PaginatedJobHistory` uses the crm-consistent `{ items, total, limit, offset }` shape. |
| `server/src/modules/job-cards/service.ts` | `createFollowUp(actor, sourceId, input)` — **canonical orchestration (Repair 1):** claim `JOB_FOLLOW_UP_CREATE:<sourceId>` → validate (eligibility, chain-depth walk, max persisted depth 10 → `409 FOLLOW_UP_MAX_DEPTH_REACHED`) → insert with inherited customer + link → store `FollowUpCreateReceipt` (`{ jobCardId }`) → commit → publish committed realtime **once** → read current JobCard → present current `JobCardDetail` with **current** authorization. **Replay:** read stored receipt → create/publish nothing → read current state → derive `followUpContext` from current role/source reachability/assignment → return the current presenter result (or canonical 403/404 when now unauthorized). `listFollowUps(actor, jobCardId)` — **management-only guard: any `STAFF` actor gets `403 FORBIDDEN`** (fourth-review children contract). **No `getSourceContext` method** (standalone endpoint removed, Repair 2). **Access lifetime** (design §6.5): mode derived per request from current role/`assigned_to`; former assignee loses access after reassignment unless own-history rules preserve it; inactive users have no access. Follow-up `customerId` is **not** changeable via the generic PATCH (Repair R25). |
| `server/src/modules/job-cards/handlers.ts` + `routes.ts` | `POST /api/job-cards/:sourceId/follow-ups`, `GET /api/job-cards/:id/follow-ups` — exactly **2 new routes**. **No** `/source` route and **no** `/source-context` route (design R9/R21, Repair 2). Detail responses embed `followUpContext` (nullable; root → `null`). `GET /api/job-cards/:id/follow-ups` is **management-only**: any `STAFF` actor → `403 FORBIDDEN` (fourth-review children contract; enforced in the handler/service, not the UI). |
| `server/src/modules/crm/types.ts` + `repository.ts` + `service.ts` + `handlers.ts` + `routes.ts` | `CustomerDetail` gains `openJobCount`, `completedJobCount` (staffScope-filtered, derived from port totals); embedded arrays removed; `GET /api/customers/:customerId/jobs`; `CrmService` constructor gains `JobHistoryReadPort` (optional dependency; the `/jobs` route registers only when the port is present — existing CRM endpoints stay available without it, Repair 5). |
| `server/src/modules/people/repository.ts` + `service.ts` + `handlers.ts` + `routes.ts` | `GET /api/staff/me/jobs` + `GET /api/staff/:userId/jobs` (Admin/Manager any; STAFF self-only via existing guard style); `PeopleService` constructor gains `JobHistoryReadPort` (optional; same conditional registration rule). |
| `server/src/modules/calendar/repository.ts` + `types.ts` | `CALENDAR_LIST_SQL` LEFT JOIN to source `job_cards src` + `job_card_meeting_details md` (for `sourceOccurredAt`); **`j.follow_up_instructions` is never selected**; additive nullable `CalendarFollowUpContext: { sourceAccess, sourceJobPath, sourcePlannedAt, sourceOccurredAt, sourceCompletedAt } | null` — narrow calendar context (Repair 3), mode derived from the **same `resolveSourceAccess` used by JobDetail** (source-authorized Staff receive `FULL` + path; different-assignee Staff `RESTRICTED` + null path; unrelated Staff nothing). No instructions, no note bodies, no chain data. |
| `server/src/modules/realtime/event-mapper.ts` | `JOB_CREATED` mapping appends `job-detail:<sourceJobCardId>` **always** and `customer-detail:<customerId>` **only when the follow-up's inherited `customerId` is non-null** — never `customer-detail:null`, no `customer-detail:*` key for customerless `GENERAL_TASK` follow-ups (fourth-review conditional-key contract). |
| `server/src/modules/job-cards/activity-presenter.ts` | No behavioral change required; `JOB_CREATED` metadata (`sourceJobCardId`) is bodyless-presented (verify in F1 with a test). |
| `server/src/modules/job-cards/validation.ts` | Register new route input schemas (Fastify JSON schema style used by the module). |
| `server/src/app.ts` | F1: `LOGGER_REDACT_PATHS` += `'req.body.followUpInstructions'` (next to existing `'req.body.body'`). F3: `AppDependencies` gains `jobHistoryReadPort?: JobHistoryReadPort`; production composition passes `{ jobCardRepository, jobHistoryReadPort: jobCardRepository }`; `CrmService`/`PeopleService` receive the port and register the history routes conditionally; unit-test wiring asserts construction with and without the port. |

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
  // NO scheduledEndsAt: creation accepts scheduledAt only (Repair 4);
  // end time is owned by the existing scheduling/update flow.
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

**Customer-null × type matrix (Repair 2):**

```text
source.customerId != null  →  GENERAL_TASK | PRODUCT_DELIVERY | SALES_MEETING  (allowed)
source.customerId == null  →  GENERAL_TASK only
                              PRODUCT_DELIVERY / SALES_MEETING → 409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED
```

The web create form disables incompatible types for a customerless source with the exact explanation: "Bu takip işi için müşteri bağlantısı bulunmadığından yalnız Genel Görev oluşturulabilir."

Responses:

- `201` — current `JobCardDetail` (Repair 1: the stable `FollowUpCreateReceipt` is resolved first, then the **current** presenter runs; a follow-up always carries the nested `JobCardFollowUpContext` with `sourceAccess`/`sourceJobPath`/`sourceSummary`; roots never occur here).
- `400 VALIDATION_ERROR` — schema/type/engagement/title/length/dueDate violations (existing validation helper, `server/src/modules/job-cards/validation.ts`); `400 FOLLOW_UP_INSTRUCTIONS_REQUIRED` — instructions missing.
- `403 FORBIDDEN` — actor is `STAFF`, or assignee is inactive / not a `STAFF` role (existing `assertCanCreateForAssignee`, `policy.ts:107-110`).
- `404 JOB_CARD_NOT_FOUND` — source id not found or other org (anti-enumeration).
- `404 ASSIGNEE_NOT_FOUND` — assignee missing or other org (`getAssigneeForUpdate` null path, `service.ts:334-336`).
- `404 CUSTOMER_NOT_FOUND` — inherited source customer missing/other org; `409 CUSTOMER_INACTIVE` — inherited customer inactive.
- `404 CONTACT_NOT_FOUND` — contact missing/other org; `409 CONTACT_INACTIVE` — contact inactive; `409 CONTACT_NOT_IN_CUSTOMER` — contact does not belong to the inherited customer (existing rules, `service.ts:763-777`); `409 FOLLOW_UP_CONTACT_REQUIRES_CUSTOMER` — customerless source + `contactId` in request.
- `409 FOLLOW_UP_SOURCE_NOT_COMPLETED` — source not `COMPLETED`.
- `409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED` — customerless source with `PRODUCT_DELIVERY`/`SALES_MEETING` type (matrix above).
- `409 FOLLOW_UP_MAX_DEPTH_REACHED` — source at depth 10; the child would be depth 11.
- `409 ACTION_IN_PROGRESS` — duplicate concurrent claim.
- Idempotent replay (Repair 1) — `201` with the **current actor-safe `JobCardDetail`**: same mutation identity (same created JobCard id, same committed database mutation, no duplicate side effects), but **no guarantee of byte-identical actor-dependent presentation**. `followUpContext` is recomputed from current role/source reachability/assignment. If the original actor is no longer authorized at replay time, the canonical current `403`/`404` result is returned — the stored mutation response is never exposed.

Distinction (stable vs recomputed):

```text
idempotent mutation identity:   stable (jobCardId; single committed mutation)
authorization-dependent presentation: recomputed on every response
```

Exact contract tests must assert status + error code + response shape for every row above (no silent enum drift).

### 6.2 `GET /api/job-cards/:id/follow-ups` (new)

`{ items: FollowUpListItem[], total, limit, offset }`; **management-only: `STAFF` → `403 FORBIDDEN` regardless of card reach** (fourth-review children contract); Admin/Manager reach = `actorCanReachJob` on `:id`. `FollowUpListItem = JobCardListItem + { followUp: { sourceJobCardId: string } | null }` (narrow list metadata, matching `JobCardHistoryItem`). Sort `created_at DESC, id`.

### 6.3 Source access mode — canonical DTO (Repair 2)

No `/source` endpoint and no `/source-context` endpoint exist (design R9/R21). `JobCardDetail` carries the nullable nested `JobCardFollowUpContext`:

```ts
type FollowUpSourceSummary = {
  sourceType: JobCardType
  sourcePlannedAt: string | null
  sourceOccurredAt: string | null
  sourceCompletedAt: string
  customer: ReferenceCustomer | null
  contact: ReferenceContact | null
  outcome: MeetingOutcome | null
}

type JobCardFollowUpContext = {
  sourceJobCardId: string
  followUpInstructions: string
  sourceAccess: 'FULL' | 'RESTRICTED'
  sourceJobPath: string | null   // non-null IFF sourceAccess === 'FULL'
  sourceSummary: FollowUpSourceSummary
}

followUpContext: JobCardFollowUpContext | null
```

**Public detail omits the raw source fields (fourth-review contract):**

```ts
type JobCardDetail =
  Omit<PersistedJobCardDetail, 'lifecycle' | 'sourceJobCardId' | 'followUpInstructions'> & {
    workflowContext: JobWorkflowContext
    followUpContext: JobCardFollowUpContext | null
  }
```

`detail.sourceJobCardId` and `detail.followUpInstructions` **never exist** on the public response — every follow-up value reaches the client only inside `followUpContext`. The internal/persisted `JobCard` row model carries the raw columns (`source_job_card_id`, `follow_up_instructions`); the public derivation follows the existing `types.ts:163-165` Omit pattern, extended with the two raw fields.

- **Root JobCard:** `followUpContext: null` (an impossible access state is never exposed).
- **Follow-up, `FULL`** — `ADMIN`/`MANAGER`, or the **source card's current assignee** (own-history reach via `actorCanReachJob`). `sourceJobPath` = `/jobs/<sourceId>`; `sourceSummary` present. The client navigates with `sourceJobPath` to the **existing** `GET /api/job-cards/:sourceId` route.
- **Follow-up, `RESTRICTED`** — everyone else with follow-up reach. `sourceJobPath: null`; `sourceSummary` present (the safe summary only).
- **Invariants (parser-enforced):** `FULL` + null `sourceJobPath` → malformed, rejected; `RESTRICTED` + non-null `sourceJobPath` → malformed, rejected; follow-up + null `sourceSummary` → malformed, rejected.
- `sourceSummary` never repeats `sourceAccess`, `sourceJobPath`, `followUpInstructions`, or `sourceJobCardId`; no `RestrictedSourceContext` DTO exists.
- Mode is derived per request from current role/assignment and re-evaluated on **every** response, including idempotent replays (§6.4) — no stored grants, no stored presentation.

Canonical time model (design §6.2, R17 — never a single "previous visit date"): `sourcePlannedAt` = `scheduled_at`; `sourceOccurredAt` = `SALES_MEETING → meeting_at`, else `started_at`, fallback `staff_completed_at`; `sourceCompletedAt` = `manager_approved_at`. Exact UI labels: "Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi". `sourceCompletedAt` is non-null because the source is always `COMPLETED`.

### 6.4 Replay contract (Repair 1)

**Stable mutation receipt:**

```ts
type FollowUpCreateReceipt = { jobCardId: string }
```

The processed-action store (`processed_actions`) persists only this receipt — never `sourceAccess`, `sourceJobPath`, `sourceSummary`, `followUpInstructions` presentation, the full `JobCardDetail`, or actor-specific navigation links.

**First completion flow:**

```text
processed-action claim
→ validate and create follow-up atomically
→ store FollowUpCreateReceipt
→ commit
→ publish committed realtime once
→ read current JobCard
→ present current JobCardDetail using current actor authorization
```

**Replay flow:**

```text
processed-action replay
→ read stored FollowUpCreateReceipt
→ create/publish nothing (no JobCard, no link, no activity, no notification, no realtime, no SSE)
→ read the current JobCard state
→ derive followUpContext from current role, source reachability and assignment
→ return the current presenter result
```

**Replay authorization:** replay re-applies current read authorization.

```text
currently authorized:        return the current JobCardDetail
currently unauthorized:      return the canonical current 403/404 result
                             (anti-enumeration: 404 for staff on another's card;
                             403 for role denial) — never the stored mutation response
```

**Realtime behavior:** SSE publish occurs only on first successful commit; replay publishes nothing.

### 6.5 `GET /api/customers/:customerId/jobs` (new)

Query: `status=open|completed|all` (default `all`), `limit` (default 20, max 100), `offset`. Response `PaginatedJobHistory` (`{ items, total, limit, offset }`, crm-consistent shape, Repair 5). `staffScope` applied for `STAFF`; `childCount` `null` for `STAFF`. `404` when customer not found/other org. Data via `JobHistoryReadPort.listCustomerJobHistory` (§5, F3); the route registers only when the port is wired (`AppDependencies.jobHistoryReadPort`), and existing CRM endpoints stay available without it. `CustomerDetail` DTO gains `openJobCount`/`completedJobCount` derived from the port's status-filtered `total` (no separate count method); embedded `openJobs`/`completedJobs` arrays are removed in the same slice.

### 6.6 Staff history (new)

Canonical routes (consistent with existing `/api/staff`, `/api/staff/me`, `/api/staff/:userId` conventions):

- `GET /api/staff/me/jobs?status=open|completed|all&limit&offset` — own history; `STAFF` and management.
- `GET /api/staff/:userId/jobs?status=open|completed|all&limit&offset` — any org staff; `ADMIN`/`MANAGER` only; `STAFF` on another user's id → `404` (existing own-profile guard style).

Same query/response shape as §6.5 (`PaginatedJobHistory`); `childCount` management-only; data via `JobHistoryReadPort.listStaffJobHistory`; same conditional registration rule.

### 6.7 Calendar payload change (Repair 3)

`JobCalendarEvent` gains an additive, nullable **`CalendarFollowUpContext`** — a narrow, calendar-specific context derived from the **same `resolveSourceAccess` used by JobDetail** (no calendar-only authorization exception):

```ts
type CalendarFollowUpContext =
  | null
  | {
      sourceAccess: 'FULL' | 'RESTRICTED'
      sourceJobPath: string | null          // non-null IFF FULL
      sourcePlannedAt: string | null
      sourceOccurredAt: string | null
      sourceCompletedAt: string             // source always COMPLETED
    }
```

```text
Admin/Manager:                    FULL → sourceJobPath = /jobs/<sourceId> + dates
source-authorized Staff:          FULL → sourceJobPath + dates (legitimate source link)
different follow-up assignee:     RESTRICTED → sourceJobPath = null, dates only
unrelated Staff:                  event and source context not visible
```

No instructions, no note bodies, no `meetingSummary`, no activity, no chain data, no other follow-up ids, no hidden counts. Backwards-compatible additive change (web parser tolerates optional fields).

---

## 7. Web surfaces

| Surface | Change |
|---|---|
| `web/src/paths.ts` | `newFollowUp: (sourceId: string) => \`/jobs/new-follow-up?source=${sourceId}\``. |
| `web/src/AppRouter.tsx` | Route for `/jobs/new-follow-up` → `FollowUpCreatePage` (management-guarded like the other create routes). |
| `web/src/jobs/jobs-api.ts` | `JobCard` parser gains nullable `followUpContext` (single envelope: `sourceAccess`/`sourceJobPath`/`sourceSummary` — Repair 1/2; **no `sourceContext` field, no `RestrictedSourceContext` parser**); **top-level `sourceJobCardId`/`followUpInstructions` are not part of the public detail and are never parsed** (fourth-review contract — the web `JobCardDetail` type has no such fields); new `createFollowUp()`; new parsers for `FollowUpListItem`, `FollowUpSourceSummary`, `JobCardHistoryItem`. Root cards parse `followUpContext: null`; a follow-up never renders without the nested DTO. **Malformed combinations rejected by the parser:** `FULL` + null `sourceJobPath`, `RESTRICTED` + non-null `sourceJobPath`, follow-up + null `sourceSummary`. |
| `web/src/JobDetail.tsx` | (a) Management + `COMPLETED`: primary action "Takip işi oluştur" + (SALES_MEETING with `FOLLOW_UP_REQUIRED`) recommendation panel (Emphasized Card); (b) follow-up detail: "Takip" badge; (c) children panel "Takip işleri" (**management-only — never rendered for `STAFF` actors**, per fourth-review children contract); (d) chain breadcrumb (**management only** — staff see no ancestor breadcrumb, no siblings, no hidden chain length, Repair 6); (e) source panel from `followUpContext`: `null` (root) → no panel; `'FULL'` → normal link via `sourceJobPath`; `'RESTRICTED'` → safe context panel from `sourceSummary` with exact date labels ("Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi") and no source link. |
| `web/src/FollowUpCreatePage.tsx` (new, under `web/src/jobs/`) | Form per contract 6.1; source summary panel (safe structured info); pre-fills `scheduledAt = nextFollowUpAt` when source is SALES_MEETING with proposal and `engagementKind` from the source (or `FOLLOW_UP`); customer shown read-only (inherited server-side, never sent); **type selector disables `PRODUCT_DELIVERY`/`SALES_MEETING` for a customerless source** with exact explanation "Bu takip işi için müşteri bağlantısı bulunmadığından yalnız Genel Görev oluşturulabilir." (Repair 2); no `scheduledEndsAt` field (Repair 4); loading/success/error states; mobile-first layout per visual language; 403/404/409 error mapping incl. `FOLLOW_UP_SOURCE_NOT_COMPLETED`, `FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`, `FOLLOW_UP_MAX_DEPTH_REACHED`, `ACTION_IN_PROGRESS`. |
| `web/src/CustomerDetail.tsx` | Replace embedded slices with paginated history (tabs open/completed/all, "Takip" badge, pagination controls); counts from new DTO fields. |
| `web/src/StaffProfiles.tsx` | "İş geçmişi" paginated section (self + management view), using `/api/staff/me/jobs` and `/api/staff/:userId/jobs`. |
| `web/src/calendar/CalendarPage.tsx` + `web/src/services/calendar-api.ts` | Follow-up indicator + `followUpContext` handling: management/source-assignee deep link (`sourceJobPath`) or restricted dates-only context inline (planned/occurred/completed dates with exact labels, **no instructions, no source link**), per §6.7. |
| `web/src/realtime/RealtimeProvider.tsx` | No change needed; existing invalidation by resource key covers new keys automatically (verify in runtime). |

---

## 8. Permission matrix

| Action | ADMIN | MANAGER | STAFF (assignee, performed source) | STAFF (assignee, not source) | STAFF (not assignee) |
|---|---|---|---|---|---|
| Create follow-up from `COMPLETED` source | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Create from non-`COMPLETED` source | ❌ 409 | ❌ 409 | — | — | — |
| View follow-up detail | ✅ | ✅ | ✅ | ✅ | ❌ 404 |
| View follow-up children | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Source access mode (`sourceAccess`) | `FULL` + path | `FULL` + path | `FULL` + path (own history) | `RESTRICTED`, no path | ❌ 404 (no context either) |
| View full source (existing `GET /api/job-cards/:sourceId`) | ✅ | ✅ | ✅ (own history) | ❌ 404 | ❌ 404 |
| View restricted context (embedded `followUpContext.sourceSummary`) | ✅ (FULL supersedes) | ✅ | ✅ | ✅ | ❌ 404 |
| Chain navigation (breadcrumb over authorized ancestors) | ✅ full | ✅ full | ❌ none | ❌ none | ❌ none |
| View customer history | ✅ all | ✅ all | ✅ own rows/counts | ✅ own rows/counts | ✅ own rows/counts |
| View staff history (`/api/staff/me/jobs`, `/api/staff/:userId/jobs`) | ✅ any | ✅ any | ✅ self only | ✅ self only | ✅ self only |
| Calendar: follow-up event visible | ✅ all | ✅ all | ✅ own | ✅ own | ❌ not visible |
| Calendar: `CalendarFollowUpContext` mode | `FULL` + path | `FULL` + path | `FULL` + path (source assignee) | `RESTRICTED`, no path | not visible |
| `childCount` in history payloads | ✅ | ✅ | ❌ (null) | ❌ (null) | ❌ (null) |

Access lifetime (design §6.5): after reassignment the old assignee loses the follow-up (and its source context) unless existing own-history rules independently preserve it; the new assignee immediately receives the appropriate `FULL`/`RESTRICTED` mode. `COMPLETED` keeps restricted context for the final assignee's own work history. `CANCELLED` keeps only what explains the historical assigned task. Inactive users have no access.

All cross-org access resolves to `404`/`403` via existing reach rules; no new role logic beyond `assertCanCreateFollowUp` (design D2, D7) and `resolveSourceAccess` (design R9).

---

## 9. Idempotency

- **Claim:** `JOB_FOLLOW_UP_CREATE:<sourceJobCardId>` + `clientActionId` per actor — follows the `JOB_NOTE_ADD:<jobCardId>` precedent and reuses `executeCriticalAction` (`processed_actions` claim → insert → `JOB_CREATED` activity with the same `clientActionId` → notifications → realtime).
- **Stored receipt (Repair 1):** the processed-action result is the stable `FollowUpCreateReceipt = { jobCardId: string }` — never `sourceAccess`, `sourceJobPath`, `sourceSummary`, `followUpInstructions`, the full `JobCardDetail`, or actor navigation links.
- **Duplicate request (replay):** read receipt → **no** JobCard/link/activity/notification/realtime/SSE side effect → read current state → recompute `followUpContext` from current role/source reachability/assignment → return the **current** presenter result (`201` + current `JobCardDetail`). **No byte-identical response guarantee:** the mutation identity is stable, the authorization-dependent presentation is recomputed. Currently unauthorized actor → canonical current `403`/`404` (anti-enumeration), never the stored response. Concurrent duplicate → `409 ACTION_IN_PROGRESS`.
- The chain-depth walk happens inside the critical work; depth check failures mark the claim `failed` (existing pattern).
- No other new mutations: follow-up lifecycle uses existing per-command keys. **`follow_up_instructions` is immutable after creation (design D15): it is not part of the generic PATCH field set at all** — a patch attempting it yields `400 VALIDATION_ERROR` (unknown field), and no `JOB_FIELDS_UPDATED` path can touch it. F1 tests cover this.

---

## 10. Activity / audit

- `JOB_CREATED` on the follow-up carries `sourceJobCardId` in **`metadata` only** (`metadata.sourceJobCardId`) — single canonical field, not duplicated into `new_value` (design §13.5, R14); one activity record; source card untouched (append-only history). Metadata never stores actor-dependent values (`sourceAccess`, `sourceJobPath`, `followUpInstructions`, `sourceSummary`).
- **Replay creates no activity record** (Repair 1): activity rows are written only on the first committed mutation.
- `JOB_ASSIGNED` fires only if management reassigns immediately after creation (existing path).
- No new event type; `job_card_activity_logs` CHECK constraints unchanged.
- Activity timeline on the follow-up works exactly like any JobCard (existing `GET /:id/activity`); presenter stays bodyless for `JOB_CREATED` metadata.

---

## 11. Notification / realtime reuse

| Event | Notifications | Realtime |
|---|---|---|
| Follow-up created (initial assignee) | `job.assigned` draft to assignee (`JOB_CREATED` mapping) — no new kind (design D11) | `job.created`; keys += `job-detail:<sourceId>` **always**, `customer-detail:<customerId>` **only when the follow-up's inherited `customerId` is non-null — never `customer-detail:null`, no `customer-detail:*` key for customerless `GENERAL_TASK` follow-ups** (design D12, fourth-review conditional-key contract); **published once, on first commit only (Repair 1)** |
| Reassignment right after creation | `job.reassigned` (`JOB_ASSIGNED` path) | existing reassignment mapping |
| Any later lifecycle event | existing kinds | existing keys |
| Idempotent replay | **nothing** | **nothing** (no SSE, no invalidation) |

SSE and web-push payloads remain bodyless (`entityId` only). Audience unchanged (`buildJobCardAudience`). No notification content ever carries source notes/outcome beyond the follow-up's own fields.

---

## 12. Implementation slices

### F1 — Linked data + server creation contract

- **Scope:** migration `022`; `types.ts`; `create-input.ts`; `policy.ts`; `repository.ts` (source/link/receipt queries); `service.ts` `createFollowUp` + `listFollowUps`; `handlers.ts`/`routes.ts` (exactly **2 new routes**; **no** `/source` route and **no** `/source-context` route); validation schemas; activity presenter test; `migrate-runner.test.ts` update; **log redaction** in `server/src/app.ts`.
- **Changed files (server):** as listed; plus `server/src/app.ts` (`LOGGER_REDACT_PATHS` += `'req.body.followUpInstructions'`), `server/tests/migrate-runner.test.ts`, new `server/tests/job-card-follow-up.test.ts`, `server/tests/job-card-follow-up-activity.test.ts`, `server/tests/job-card-follow-up-policy.test.ts`, `server/tests/job-card-follow-up-idempotency.test.ts`, `server/tests/job-card-follow-up-log-privacy.test.ts`.
- **Tests:**
  - Migration contract: `022` in the exact ordered list, `expectedSchemaVersion` 22; behavior cases `root + instructions → rejected`, `follow-up + null instructions → rejected`, `root + null → accepted`, `follow-up + valid → accepted`. The iff CHECK is same-row, so PostgreSQL alone enforces it; cross-row rules (completed-source eligibility, depth, same-customer) are service-enforced and must NOT be claimed as DB-guaranteed without a trigger.
  - Creation happy path (each type); instructions required (400); `engagementKind` enum validation + default; STAFF create → 403; source not COMPLETED → 409; **customer-null × type matrix** (Repair 2): customerless source + `PRODUCT_DELIVERY`/`SALES_MEETING` → `409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`, customerless + `GENERAL_TASK` → 201; contact not-in-inherited-customer → 409; **no `customerId` in the request (rejected as unknown field); no `scheduledEndsAt` in the request (rejected as unknown field, Repair 4); server inherits source customer**; chain: **source at depth 10 rejects creation of depth-11 child** (409 `FOLLOW_UP_MAX_DEPTH_REACHED`); self-link impossible; **children endpoint management-only (fourth-review contract): exact test — staff owns the source and two follow-up children → `GET /api/job-cards/:id/follow-ups` returns `403 FORBIDDEN`, the source detail children panel is absent, each follow-up remains independently visible to its own assignee, and sibling relationship is never disclosed through any staff surface**; restricted context content + exclusions; `followUpContext` DTO tests: root detail → `null`; follow-up detail → nested `JobCardFollowUpContext` with `sourceAccess: 'RESTRICTED'` + `sourceJobPath: null` for non-source assignee; `'FULL'` + path for management **and for the source card's current assignee**; **public detail DTO contract (fourth-review contract): root detail has **no** top-level `sourceJobCardId` and **no** top-level `followUpInstructions` (raw fields absent; `followUpContext: null`); follow-up detail has **no** top-level raw source fields — `sourceJobCardId`/`followUpInstructions` exist **only** inside the nested `followUpContext`; `FollowUpListItem` exposes only the narrow `followUp: { sourceJobCardId: string } | null` metadata**; `sourceSummary` never repeats envelope fields; **no `RestrictedSourceContext` DTO, no `/source-context` route exists (route table asserts exactly 2 new routes)**; instructions immutable (patch attempt → 400); **idempotent replay contract (Repair 1): same `clientActionId` → same `jobCardId`, single committed mutation, no duplicate source link/activity/assignment notification/realtime/SSE; duplicate requests after access change re-derive `followUpContext` (initial FULL → replay after source-access loss → `RESTRICTED` or canonical 404/403; initial RESTRICTED → replay after legitimately gaining source access → `FULL`; follow-up reassigned → old actor replay → canonical 404, new actor → current mode; inactive actor → current auth policy)**; concurrent claim → `409 ACTION_IN_PROGRESS`; activity record with `metadata.sourceJobCardId` only (not in `new_value`, no access-mode metadata); realtime keys **`job-detail:<source>` always + `customer-detail:<customer>` only when the follow-up's inherited customer is non-null (exact tests: source with customer → `customer-detail:<customerId>` present; customerless `GENERAL_TASK` source → no `customer-detail:*` key, never `customer-detail:null`, `job-detail:<sourceId>` still present)** published once; notification `job.assigned` (no new kind); exact error-contract sweep (status + code + shape for every §6.1 row, incl. `404 ASSIGNEE_NOT_FOUND`, `403 FORBIDDEN` for inactive/non-STAFF assignee, `404/409` customer and contact rows).
  - Log privacy: unique instruction marker → request/error logs must not contain it (with and without `LOGGER_REDACT_PATHS` regression guard).
- **Runtime scenarios:** seeded org; ADMIN creates follow-up for COMPLETED delivery; verify board/detail/activity; verify restricted context + access mode as second staff user and as the source's own assignee; verify 400/403/404/409 paths; replay the same `clientActionId` and assert no duplicate side effects.
- **Completion gate:** `cd server && npm run build`, `cd server && npm test -- --run`, `cd server && npm run lint`; all green; contract tests updated.
- **Non-goals:** no web changes; no customer/staff/calendar endpoints (F3); no instruction editing; no `scheduledEndsAt` in the create contract.
- **PR:** single PR `feat: linked follow-up JobCard server contract` against `main`.

### F2 — Follow-up creation + JobDetail continuity UI

- **Status (2026-08-01):** Implementation and automated verification complete; focused in-app browser walkthrough completed against the real Fastify/Vite runtime and `servora_med_f2_test`. Full F4 matrix/evidence closeout remains pending; see the [`F2 review handoff`](../../evidence/linked-follow-up-jobcards/f2/README.md).
- **Review repair provenance (2026-08-01):** The previous external-review snapshot ended at `94215c9`; `14cfd02` closes source-switch isolation, status-0/retryable idempotency preservation, and children pagination with focused regression tests. No duplicate behavioral patch is required on top of that exact head.
- **Scope:** `paths.ts`, `AppRouter.tsx`, `FollowUpCreatePage.tsx` (new), `JobDetail.tsx` (create action, badge, children panel, **management-only chain breadcrumb**, source panel with nullable `followUpContext` modes), `jobs-api.ts` parsers; `MeetingDetails.tsx` untouched except navigation constants.
- **Changed files (web):** as listed; new `web/src/jobs/FollowUpCreatePage.tsx`, `web/src/jobs/follow-up-presentation.ts` (labels/badges incl. exact date labels "Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi"), new web tests for parser + form validation.
- **Tests:** web build; parser tests for nullable `followUpContext` (root → `null`, follow-up → nested `JobCardFollowUpContext` incl. `sourceAccess`/`sourceJobPath`/`sourceSummary`, time model; **malformed combinations rejected: `FULL` + null `sourceJobPath`, `RESTRICTED` + non-null `sourceJobPath`, follow-up + null `sourceSummary`**; **parser has no top-level `sourceJobCardId`/`followUpInstructions` fields — a public detail carrying raw top-level source fields is rejected by the parser**); form error mapping (409s incl. `FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`); **type disabling for customerless source** (exact explanation string asserted); management-only action visibility; **children panel rendered for Admin/Manager only — component test: staff actor on the source detail → children panel not rendered** (fourth-review contract); **no staff ancestor breadcrumb rendered for staff actors**; root `followUpContext: null` renders no source panel; RESTRICTED panel renders no source link (component-level).
- **Runtime scenarios:** as ADMIN create follow-up from completed SALES_MEETING with `FOLLOW_UP_REQUIRED`; as STAFF open the follow-up: restricted panel visible with exact date labels, no source link; as the source card's own assignee: `FULL` mode with working link; as second STAFF (not assignee): 404 page; **as STAFF on the source detail: children panel absent (and the children endpoint returns 403 if called directly); as ADMIN/MANAGER on the source detail: children panel present**; as STAFF on a chain card: no ancestor breadcrumb; mobile viewport check.
- **Completion gate:** `cd web && npm run build`, `cd web && npm run lint`; server contract from F1 still green; manual flows verified (see §15).
- **Non-goals:** customer/staff/calendar surfaces (F3); instruction editing (immutable by design); any staff chain navigation UI.
- **PR:** `feat: linked follow-up JobCard creation UI`.

### F3 — Customer / Staff / Calendar history integration

- **Scope:** new `server/src/modules/job-cards/history-port.ts` (`JobHistoryReadPort` with `listCustomerJobHistory`/`listStaffJobHistory` → `PaginatedJobHistory { items, total, limit, offset }`, Repair 5) implemented by `PostgresJobCardRepository`; crm `types.ts`/`repository.ts`/`service.ts`/`handlers.ts`/`routes.ts` (constructor wiring, counts derived from port totals + `/jobs` endpoint, embedded arrays removed); people `repository.ts`/`service.ts`/`handlers.ts`/`routes.ts` (constructor wiring, `/api/staff/me/jobs` + `/api/staff/:userId/jobs`); **`server/src/app.ts` dependency wiring** — `AppDependencies` gains optional `jobHistoryReadPort?: JobHistoryReadPort`, production composition passes `{ jobCardRepository, jobHistoryReadPort: jobCardRepository }`, history routes register only when the port is present, `CrmService`/`PeopleService` receive the port (+ wiring smoke tests with and without the port); calendar `repository.ts`/`types.ts` (additive nullable `CalendarFollowUpContext` per §6.7, mode from the **same `resolveSourceAccess` as `JobCardDetail`**, `CALENDAR_LIST_SQL` never selects `j.follow_up_instructions`); web `CustomerDetail.tsx`, `StaffProfiles.tsx`, `CalendarPage.tsx`, `calendar-api.ts`; realtime key `customer-detail:<id>`.
- **Changed files:** as listed; new `server/tests/crm-job-history.test.ts`, `server/tests/people-job-history.test.ts`, `server/tests/calendar-follow-up.test.ts`, `server/tests/history-wiring.test.ts` (app-level construction with and without the port); updated `server/tests/crm-routes.test.ts` (embedded arrays removed), web parser/history tests.
- **Tests:** role-filtered rows + counts (staff sees only own; counts equal status-filtered list totals — no hidden count leakage); `childCount` null for STAFF; pagination (limit clamp, offset, `PaginatedJobHistory` shape); staff self-only history (`/api/staff/:userId/jobs` → 404 for STAFF on others, `/api/staff/me/jobs` works); **calendar parity (Repair 3): same actor + same card → identical `sourceAccess` on detail and calendar; management FULL + path; source-authorized STAFF FULL + path (legitimate source link); different-assignee STAFF `RESTRICTED` + null path; unrelated STAFF → event/context not visible; no instructions field anywhere in the calendar payload**; realtime invalidation; wiring smoke test.
- **Runtime scenarios:** staff user opens customer with other staff's completed jobs → own rows only, counts exclude others; manager sees all + childCount; calendar shows follow-up indicator for manager and for source-authorized staff with source link, restricted dates-only (no link) for different-assignee staff, nothing for unrelated staff; staff profile history pagination; calendar/detail mode parity for the same actor.
- **Completion gate:** full command battery (server build/test/lint, web build/lint); no compatibility fallbacks retained.
- **Non-goals:** no new notification kinds; no calendar schema changes; no `JobHistoryReadPort` count methods (derived from list totals).
- **PR:** `feat: role-filtered follow-up history surfaces`.

### F4 — Runtime acceptance & evidence closeout

- **Scope:** end-to-end verification against real PostgreSQL + Fastify + Vite (test database seeded per AGENTS.md workflow), multi-role browser walkthrough, privacy scenario sweep, evidence capture. **F4 is a separate PR whose required persistent change is the canonical evidence artifact** `docs/evidence/linked-follow-up-jobcards/f4/README.md` (acceptance results, screenshots, payload/log captures, command outputs) — no empty PRs (design R-F4).
- **Steps:**
  1. Fresh schema via migrations 001–022; seed org with ADMIN, MANAGER, staff A, staff B, customer+contacts, products.
  2. As staff A: complete a PRODUCT_DELIVERY and a SALES_MEETING (`FOLLOW_UP_REQUIRED` + `nextFollowUpAt`).
  3. As ADMIN: create follow-ups (same assignee, different assignee, chain of 2, sibling); verify notifications (`job.assigned`) and realtime invalidation in two browser sessions; verify root detail renders `followUpContext: null`.
  4. As staff B (follow-up assignee, not source): verify restricted context contents/exclusions, `followUpContext.sourceAccess: 'RESTRICTED'` with no `sourceJobPath` (detail + calendar), customer history own-only, no ancestor breadcrumb on a chain card, **no children panel on the source detail and `GET /api/job-cards/:id/follow-ups` → 403 (fourth-review children contract: staff owns the source and two follow-up children → 403; each follow-up independently visible; no sibling disclosure)**.
  5. As staff A (source assignee): verify `followUpContext.sourceAccess: 'FULL'` + working source link (detail + calendar parity).
  6. Negative sweep: staff create → 403; source not completed → 409; instructions missing → 400; instruction patch → 400; duplicate `clientActionId` → replay (same `jobCardId`, **no duplicate activity/notification/realtime, no byte-identical requirement — context recomputed**); **replay after access change: source-assignee FULL → assignee reassigned away → replay returns `RESTRICTED` or canonical 404; restricted staff later assigned to source → replay returns `FULL`**; source at depth 10 rejects depth-11 child → 409 `FOLLOW_UP_MAX_DEPTH_REACHED`; **customerless source: `GENERAL_TASK` accepted, `PRODUCT_DELIVERY`/`SALES_MEETING` rejected → 409 `FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED` (and the UI disables those types with the exact explanation string); customerless follow-up emits no `customer-detail:*` realtime key, `job-detail:<sourceId>` still present**; **public detail shape: root and follow-up details carry no top-level `sourceJobCardId`/`followUpInstructions` (network payload check)**; inactive/non-STAFF assignee → 403; reassigned follow-up → old assignee loses context, new assignee gains the appropriate mode; cancelled follow-up visibility for its assignee; inactive user has no access.
  7. Capture evidence: test logs, browser screenshots of restricted panel/calendar/customer history, network payload checks (bodyless SSE/notification payloads), **log-file check (instruction marker absent)**.
- **Completion gate:** all acceptance scenarios pass; `docs/evidence/linked-follow-up-jobcards/f4/README.md` committed with the evidence; `git diff --check` clean.
- **PR:** `test: linked follow-up JobCard runtime acceptance` (separate; includes the canonical evidence artifact — this decision is fixed, not deferred).

#### F4 blocked checkpoint (2026-08-01)

- **Runtime acceptance (first external-review pass):** The external-review repair harness ran against fresh PostgreSQL, Fastify, Vite and installed Google Chrome. It recorded **145 PASS / 4 FAIL / 149 total**. The failures mapped to two product-runtime defects: an open management Children panel did not refresh its list after follow-up creation (`0 → 0`), and Calendar date/event cells were absent from the real Tab order, preventing Enter activation. Canonical evidence is [`docs/evidence/linked-follow-up-jobcards/f4/README.md`](../../evidence/linked-follow-up-jobcards/f4/README.md).
- **Closed evidence gaps (first pass):** The sanitized live POST field set and instruction fingerprint are asserted; receipt replay is exercised across `FULL → RESTRICTED → FULL` with unchanged activity/notification/realtime observations; management breadcrumb and Staff no-breadcrumb/no-fetch are asserted; JobDetail/customer history/staff history realtime refreshes have bounded quiet-window traces; form/error/history/FULL/RESTRICTED keyboard traces are recorded.
- **Scope (first pass):** F4 changed only synthetic seed/verification harnesses and evidence documentation. No migration, production behavior, API contract, notification kind, or F1/F2/F3 design decision changed.

#### F4 production repair (2026-08-01, external re-review decision)

- **Authority:** The external F4 re-review decision authorized narrow product repair for exactly two runtime defects; scope was limited to `web/src/jobs/FollowUpContinuity.tsx`, `web/src/ui/antd/ServoraCalendar.tsx`, `web/src/calendar/CalendarPage.tsx`, `web/src/styles.css`, focused web tests, and the acceptance harness/evidence. Server production code, migrations, API contracts, authorization rules, notification kinds and new realtime event types were **not** changed.
- **Repair 1 — Children panel realtime refresh:** `FollowUpContinuity.tsx` now subscribes through `useRealtimeInvalidation` to the existing `job-detail:<sourceId>` key already emitted by the F3 event mapper on follow-up creation. A generation counter guards against stale responses after remount/unsubscribe. Harness record `REALTIME-CHILDREN-PANEL-REFRESH` now observes `0 → 1` with a stable quiet window.
- **Repair 2 — Calendar keyboard access:** `ServoraCalendar.tsx` renders date cells as `<button aria-label="YYYY-MM-DD" aria-pressed>` and event summaries as `<button data-event-id>`; `CalendarPage.tsx` wires `onEventSelect` to the `event` deep-link URL parameter; `styles.css` adds button reset and `:focus-visible` outline. Harness records `KEYBOARD-CALENDAR-CELL`, `KEYBOARD-CALENDAR-EVENT` and `KEYBOARD-CALENDAR-EVENT-ACTIVATED` all **PASS**.
- **Final runtime acceptance:** **152 PASS / 0 FAIL / 152**, status `PASS`. Web suite: **101 files, 1193 tests passed**; web build passed. New tests cover realtime invalidation (refresh on invalidation, duplicate-cursor no-loop, stale-response guard, subscription lifecycle) and Calendar keyboard accessibility.
- **Gate:** Draft PR #87 remains **Draft** and now states it contains production repair. F4 closeout is recorded as PASS; external F4 re-review is **pending** on the exact head. PR Ready, merge, staging, production and cleanup remain not authorized until that re-review completes.

**PR sequencing rule:** F1 → F2 → F3 → F4, each against `main`, each gated by its completion gate. Design doc decisions are not re-negotiable in PR review unless a real defect is found (then a follow-up design amendment PR updates this document).

---

## 13. File-level change map (cumulative)

Server (new): `server/src/db/migrations/022_job_card_follow_up_links.sql`, `server/src/modules/job-cards/history-port.ts`, `server/tests/job-card-follow-up.test.ts`, `server/tests/job-card-follow-up-activity.test.ts`, `server/tests/job-card-follow-up-policy.test.ts`, `server/tests/job-card-follow-up-idempotency.test.ts`, `server/tests/job-card-follow-up-log-privacy.test.ts`, `server/tests/crm-job-history.test.ts`, `server/tests/people-job-history.test.ts`, `server/tests/calendar-follow-up.test.ts`.

Server (modified): `server/src/app.ts` (F1: `LOGGER_REDACT_PATHS` += `req.body.followUpInstructions`; F3: `AppDependencies.jobHistoryReadPort?` + conditional history-route registration + `CrmService`/`PeopleService` constructor wiring), `server/src/modules/job-cards/types.ts`, `create-input.ts`, `policy.ts`, `repository.ts`, `service.ts`, `handlers.ts`, `routes.ts`, `validation.ts`, `activity-presenter.ts` (only if presenter test demands); `server/src/modules/crm/{types,repository,service,handlers,routes}.ts`; `server/src/modules/people/{repository,service,handlers,routes}.ts`; `server/src/modules/calendar/{repository,types}.ts`; `server/src/modules/realtime/event-mapper.ts`; `server/tests/migrate-runner.test.ts`; `server/tests/crm-routes.test.ts` (embedded arrays removed).

Web (new): `web/src/jobs/FollowUpCreatePage.tsx`, `web/src/jobs/follow-up-presentation.ts`, web test files for parsers/form.

Web (modified): `web/src/paths.ts`, `web/src/AppRouter.tsx`, `web/src/JobDetail.tsx`, `web/src/jobs/jobs-api.ts`, `web/src/CustomerDetail.tsx`, `web/src/StaffProfiles.tsx`, `web/src/calendar/CalendarPage.tsx`, `web/src/services/calendar-api.ts`, `web/src/jobs/FollowUpContinuity.tsx` (F4 repair: realtime children-panel invalidation), `web/src/ui/antd/ServoraCalendar.tsx` (F4 repair: keyboard date/event buttons), `web/src/styles.css` (F4 repair: calendar button/focus styles), `web/tests/calendar-page.test.tsx` + `web/tests/follow-up-continuity.test.tsx` (F4 repair tests).

Docs (new, F4): `docs/evidence/linked-follow-up-jobcards/f4/README.md` — canonical evidence artifact (mandatory persistent change for F4; no empty PRs).

Docs (modified, after implementation): this plan's slice checkboxes marked done per AGENTS.md §11; design doc only on defect-driven amendments.

No dependency, package, or lockfile changes (AGENTS.md §10).

---

## 14. Test matrix

| Priority (AGENTS.md §9 order) | Scenario | Layer |
|---|---|---|
| 1 | Auth/role: STAFF create → 403; cross-org → 404/403 | server |
| 2 | Staff access boundaries: **children endpoint `403 FORBIDDEN` (management-only) + children panel absent; no top-level raw source fields on public detail (`Omit` contract)**; reach/context after reassignment; no hidden chain length; access lifetime (reassignment, cancelled, inactive) | server |
| 3 | Follow-up creation: each type, management role, customer-null × type matrix (`FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`) | server + web |
| 4 | State machine: follow-up lifecycle identical to normal JobCard | server (existing lifecycle tests reused) |
| 5 | Invalid transition rejection: unchanged for follow-ups | server (existing) |
| 6 | Manager approval: follow-up needs approval like any card | server (existing) |
| 7 | Revision request: unchanged on follow-ups | server (existing) |
| 8 | Required fields: `followUpInstructions` required; type-specific scheduling | server + web |
| 9 | Activity log: `JOB_CREATED` + `metadata.sourceJobCardId`; no source mutation | server |
| 10 | Idempotency: replay returns the same `jobCardId` with no duplicate side effects; replay after access change re-derives `followUpContext` (`FULL`↔`RESTRICTED`/canonical 404/403); concurrent claim → `ACTION_IN_PROGRESS` | server |
| 11 | Report correctness: follow-ups appear in existing reports (no report changes; regression only) | server (existing) |
| 12 | Web vertical flows: create → board → detail → source panel modes → customer history → calendar | runtime (F4) |
| — | Privacy: restricted context exclusions; `followUpContext` modes (`null` root / `FULL` / `RESTRICTED`); single envelope (no `RestrictedSourceContext`, **no top-level raw source fields on public detail**); calendar/detail mode parity (source-authorized Staff `FULL` on both); `childCount` null; **children panel/endpoint management-only (STAFF → 403, no sibling disclosure)**; **customerless follow-up emits no `customer-detail:*` key**; bodyless payloads; no `sourceJobPath` for RESTRICTED | server + runtime |
| — | Log privacy: instruction marker absent from request/error logs | server (F1) + runtime (F4) |
| — | Migration: 001–022 order + schema version 22; iff CHECK behavior (4 cases) | server |
| — | Exact error contract (§6.1): status + code + shape for every row incl. `404 ASSIGNEE_NOT_FOUND`, `403 FORBIDDEN` (inactive/non-STAFF assignee), `404/409` customer/contact rows, `FOLLOW_UP_MAX_DEPTH_REACHED` | server |

---

## 15. Runtime acceptance (F4 checklist)

1. `docker`-managed PostgreSQL with migrations 001–022 applied; seed per §12-F4.
2. `cd server && npm run build && npm test -- --run && npm run lint` — green.
3. `cd web && npm run build && npm run lint` — green.
4. Browser walkthrough (Chrome): flows listed in §12-F4 with two staff sessions + one manager session.
5. Network tab: notification/SSE payloads contain ids only; follow-up detail payload carries the nested `JobCardFollowUpContext`; root detail carries `followUpContext: null`; calendar payload carries `CalendarFollowUpContext` per §6.7; a duplicate `clientActionId` request returns the same `jobCardId` with no second realtime/notification.
6. Log files: a unique instruction marker sent during F1/F4 flows is absent from request and error logs (redaction proof).
7. Mobile viewport (375px): create form, restricted panel, calendar event, customer history usable.
8. Console: no errors/warnings on the touched pages.
9. Access-lifetime sweep: reassigned follow-up (old assignee loses context, new assignee gains appropriate mode); cancelled follow-up visible to its assignee without new source permissions; inactive user cannot authenticate into any context.
10. Chain-visibility sweep: staff on a chain card sees the immediate source relationship only — no ancestor breadcrumb, no sibling cards, no children panel, no chain length hint; management sees the full breadcrumb and the children panel (children endpoint `403 FORBIDDEN` for STAFF).

---

## 16. Evidence requirements

- Every slice PR description lists: changed files, commands run with outputs, runtime scenario results.
- F4 PR commits the canonical evidence artifact `docs/evidence/linked-follow-up-jobcards/f4/README.md` (screenshots, payload/log captures, command outputs) — evidence is a committed file, not only a description.
- This documentation checkpoint's own evidence: `git diff --check` output, `git status --short` (only the two docs), PR URL + state, base/head SHAs, and the external-review revision commits resolving blockers 1–9, the second-review repairs 1–6, and the third-review repairs 1–3 (see the PR description and the final handoff).

---

## 17. Risk register

| Risk | Mitigation |
|---|---|
| Restricted context accidentally expanded later | Contract fixed in design §6; server DTO is the single source; tests assert exact exclusions. |
| `childCount` leakage | Management-only field, server-computed, `null` for STAFF; tested in F3. |
| Reassignment race on follow-up (access mode) | Mode derived from current `assigned_to` inside the read transaction; no stored grants; tests cover post-reassignment and post-source-reassignment modes. |
| Source time model misleads users | Canonical derivation table (§6.3); exact UI labels; no single "previous visit date" field anywhere. |
| Chain depth abuse | Service walk (max persisted depth 10) + immutable link; DB CHECK prevents self-link; off-by-one test names fixed. |
| Migration drift (migrate-runner) | F1 updates the exact-list test in the same PR as the migration. |
| Counts revealing other staff work in customer detail | Counts reuse the exact `staffScope` predicate; F3 tests assert equality with filtered list. |
| Log leakage of `follow_up_instructions` | `LOGGER_REDACT_PATHS` entry + dedicated log-capture test (F1) + runtime log check (F4). |
| Generic PATCH changing a follow-up's inherited `customerId` (breaks same-customer chain rule) | Follow-up `customerId` is immutable via PATCH — the source remains the single owner of customer/contact (design R25); F1 test asserts the patch attempt yields `400 VALIDATION_ERROR`. |
| History routes registered without the read port | `jobHistoryReadPort?` optional in `AppDependencies`; routes register only when present; wiring smoke test covers both states (F3). |
| Calendar/detail access-mode drift | Single `resolveSourceAccess` shared by both presenters; consistency test asserts same actor → same mode on both endpoints; source-authorized Staff receive `FULL` on both (F3). |
| History read-model wiring drift | `JobHistoryReadPort` owned by job-cards; constructor injection in `app.ts` + unit-test wiring asserted in F3. |
| Web payload regression (calendar additive field) | Optional-field parsing; runtime check in F4. |
| Stale replay leaks actor-specific view (Repair 1) | Receipt stores only `{ jobCardId }`; every completion/replay re-runs current read authorization + presenter; access-change scenarios tested in F1/F4. |
| DTO drift between docs/slices (Repair 2) | One `JobCardFollowUpContext` envelope + one `resolveSourceAccess` resolver + parser rejects impossible combos; both docs use the same exact DTO names. |
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
| B4 "previous visit date" semantics | Canonical time model `sourcePlannedAt`/`sourceOccurredAt`/`sourceCompletedAt` + exact UI labels (design R17, plan §6.3). |
| B5 history read-model wiring | New `JobHistoryReadPort` in job-cards, constructor injection into CRM/People services, `app.ts` + test wiring in file map (plan §5, F3). |
| B6 instruction mutability | Immutable after creation (design D15); no PATCH surface; tests added (plan §9, F1). |
| B7 chain depth off-by-one | Precise depth model (root 0, max persisted 10); test named "source at depth 10 rejects creation of depth-11 child" (design §7.4, plan F1/F4). |
| B8 F4 artifact | F4 is a fixed separate PR with canonical evidence file `docs/evidence/linked-follow-up-jobcards/f4/README.md` (plan §12-F4, §13). |
| B9 log privacy | `LOGGER_REDACT_PATHS` += `req.body.followUpInstructions` (F1) + log-capture test + runtime log check (design §13.7, plan F1/§15). |
| Design status wording | Now "Ready for external review" (design header). |
| Route inconsistency | Canonical `/api/staff/me/jobs` + `/api/staff/:userId/jobs` everywhere (design §9.2, plan §6.6). |
| Activity duplicate field | `sourceJobCardId` in `metadata` only, not `new_value` (design §13.5, plan §10). |

2026-07-31 — Second GPT-5.6 review returned a new repair set; this revision resolves it as follows:

| Repair | Resolution |
|---|---|
| Repair 1 — nullable `followUpContext` DTO | `JobCardDetail` gains nullable nested `JobCardFollowUpContext` (`null` for roots; `{ sourceJobCardId, followUpInstructions, sourceAccess, sourceJobPath, sourceContext }` otherwise); presenter/API/web parser/replay identical for the nested DTO and the standalone endpoint (design §6.2, R21; plan §5/§6.3, F1/F2). *(Standalone-endpoint wording superseded by third-review Repair 2 below.)* |
| Repair 2 — null-customer × type matrix | Customerless source → `GENERAL_TASK` only; other types → `409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`; UI disables incompatible types with the exact explanation string (design §15 R22/R2, plan §6.1, F1/F2). |
| Repair 3 — exact error contract | Canonical table with status + code for actor/source/assignee/customer/contact/type rows; verified against real code (`ASSIGNEE_NOT_FOUND` 404 `service.ts:335`, `assertCanCreateForAssignee` 403 `policy.ts:107-110`, `validateJobReferences` `service.ts:763-777`); exact contract tests required (plan §6.1, F1). |
| Repair 4 — `scheduledEndsAt` removal | Creation accepts `scheduledAt` only; end time stays in the existing scheduling/update flow; `scheduledEndsAt` rejected as unknown field (plan §6.1, F1/F2 non-goals). |
| Repair 5 — complete `JobHistoryReadPort` | `listCustomerJobHistory`/`listStaffJobHistory` → `PaginatedJobHistory { items, total, limit, offset }` (crm-consistent); no count methods (totals derived); optional `AppDependencies.jobHistoryReadPort?`; conditional route registration; CRM/People injection; wiring tests (design §8.2/§9.2/R13; plan §5/§6.5-6.6, F3). |
| Repair 6 — staff chain visibility | Staff see the immediate direct-source relationship only; no ancestor breadcrumb, no siblings, no hidden chain length; management keeps full navigation; journeys, matrix, F2/F3, runtime scenarios updated (design §4.3/R23; plan §7-§8, F2/F4). |
| Calendar consistency | Same source-access decision as `JobCardDetail`; additive nullable `followUpContext { sourceAccess, sourceJobPath, sourcePlannedAt, sourceOccurredAt, sourceCompletedAt }`; no instructions/notes/chain (design §10.2-10.3; plan §6.7, F3). |
| Access lifetime | Exact lifecycle/reassignment/cancelled/inactive policy, derived per request, no stored grants (design §6.5, R24; plan §8, F4). |
| Migration/CHECK verification | iff CHECK two-way same-row + separate length/whitespace CHECK + 4-case behavior test; cross-row rules service-enforced, not claimed as DB-guaranteed without a trigger (plan §4, F1). |
| F1–F4 slice updates | All slices updated with DTO/matrix/error-contract/port/calendar/access-lifetime scope and tests (plan §12). |
| Consistency search | `rg` sweep over both docs (§14 of the task contract): `followUpContext` nullable for roots, no `customerId`/`scheduledEndsAt` in create, matrix explicit, cross-org 404, no staff ancestor breadcrumbs, calendar uses JobDetail access mode, port pagination complete, exact error codes. |

2026-07-31 — Third GPT-5.6 review returned a new repair set (access-safe replay, DTO normalization, calendar parity); this revision resolves it as follows:

| Repair | Resolution |
|---|---|
| Repair 1 — access-safe replay | Processed-action result is the stable `FollowUpCreateReceipt = { jobCardId }` only — never `sourceAccess`/`sourceJobPath`/`sourceSummary`/`followUpInstructions` presentation or the full `JobCardDetail`. First completion: claim → create → store receipt → commit → publish realtime once → read current JobCard → present current `JobCardDetail` with **current** authorization. Replay: read receipt → create/publish nothing → re-derive `followUpContext` from current role/source reachability/assignment → return the current presenter result; unauthorized at replay → canonical current 403/404 (anti-enumeration). **No byte-identical response guarantee** — stable mutation identity vs recomputed presentation (design §6.6; plan §6.1, §6.4, §9, §11, §12-F1/F4). |
| Repair 2 — normalized single DTO | One `JobCardFollowUpContext` envelope (`sourceJobCardId`, `followUpInstructions`, `sourceAccess`, `sourceJobPath`, `sourceSummary: FollowUpSourceSummary`); **no `RestrictedSourceContext` DTO, no `sourceContext` field**; **standalone `GET /api/job-cards/:id/source-context` removed from the initial version** (supersedes the second-review log wording that kept the endpoint — no retained "for future use"); root → `null`, `FULL` → path + summary, `RESTRICTED` → null path + summary; `sourceSummary` never repeats envelope fields and excludes source Staff identity; parser rejects impossible combos (`FULL`+null path, `RESTRICTED`+path, follow-up+null summary) (design §6.2-6.3, §15 R9/R21; plan §5/§6.3/§7/§8, F1/F2). |
| Repair 3 — calendar parity | Calendar uses the **same `resolveSourceAccess` as JobDetail**; named `CalendarFollowUpContext` (narrow: `sourceAccess`/`sourceJobPath`/3 dates); management AND source-authorized Staff get `FULL` + path (legitimate source link — "Staff never receives a source link in Calendar" statements removed); different-assignee Staff `RESTRICTED` no path; unrelated Staff event/context not visible; `CALENDAR_LIST_SQL` never selects `j.follow_up_instructions`; permission-matrix `❌ (FULL only if source assignee)` cells replaced with exact values; F4 parity tests (design §10.2-10.3, §15 R27; plan §6.7, §8, §12-F3/F4). |
| Privacy threats added | Stale-replay threat (#8): receipt-only store + current read auth + current presenter on every completion/replay. DTO-drift threat (#9): single envelope + single resolver + rejecting parser. Calendar-parity threat (#10): shared resolver + parity tests, no calendar authorization widening (design §13). |
| Consistency search | `rg` sweep over both docs (§12 of the task contract): no `RestrictedSourceContext`/`sourceContext`/`/source-context` route/`Staff never`/byte-identical-replay leftovers; identical DTO names in both docs. |

2026-07-31 — Fourth GPT-5.6 review returned `REVISE REQUIRED` (3 narrow contract gaps); this revision resolves them as follows:

| Contract gap | Resolution |
|---|---|
| Gap 1 — raw source fields on public detail | The internal/persisted domain `JobCard` keeps `sourceJobCardId`/`followUpInstructions`; the **public** `JobCardDetail` omits both at the top level: `JobCardDetail = Omit<PersistedJobCardDetail, 'lifecycle' \| 'sourceJobCardId' \| 'followUpInstructions'> & { workflowContext; followUpContext: JobCardFollowUpContext \| null }` (extends the real `types.ts:163-165` derivation). Web parser never parses top-level raw fields; list/history surfaces use the narrow `followUp: { sourceJobCardId: string } \| null` metadata (`FollowUpListItem`). F1 asserts root detail (top-level raw fields absent, `followUpContext: null`) and follow-up detail (raw fields only inside `followUpContext`) (design §6.2; plan §5/§6.2-6.3/§7/§12-F1, §14). |
| Gap 2 — staff children list contradiction | Children endpoint and children panel are **management-only** in the initial version: `GET /api/job-cards/:id/follow-ups` → `403 FORBIDDEN` for any `STAFF` actor; panel not rendered for Staff. Exact test: staff owns the source and two follow-up children → 403 on the endpoint, panel absent, each follow-up independently visible, no sibling disclosure. Design role matrix, R23, §4.3/§5/§13, GET authorization, F1 API tests, F2 panel test, F4 privacy scenarios all updated (design §5/R23; plan §6.2/§7-§8/§12-F1/F2/F4, §14-§15). |
| Gap 3 — customerless realtime key conditioning | `job-detail:<sourceJobCardId>` is **always** added; `customer-detail:<customerId>` is added **only when the inherited `customerId` is non-null** — never `customer-detail:null`, no `customer-detail:*` key for customerless `GENERAL_TASK` follow-ups. Identical conditional wording in design §4.1 journey, §12.2, D12/R12, plan §5 event-mapper, §11 event table, F1 test matrix; F1 exact tests: source with customer → key present; customerless source → no `customer-detail:*` key, `job-detail:<sourceId>` still present. |
