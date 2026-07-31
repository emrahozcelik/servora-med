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

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_instructions_check
  CHECK (source_job_card_id IS NULL OR follow_up_instructions IS NOT NULL);

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

Note: the instructions-presence CHECK is same-row (`source_job_card_id` lives on the same row), so it is fully expressible — consistent with existing CHECK style (`002`, `007`).

**Contract test:** extend `server/tests/migrate-runner.test.ts` migration list with `022_job_card_follow_up_links.sql` and `expectedSchemaVersion` to 22.

---

## 5. Server architecture

| File | Change |
|---|---|
| `server/src/modules/job-cards/types.ts` | `JobCard` + `sourceJobCardId: string \| null`, `followUpInstructions: string \| null`. New `FollowUpCreateInput`; new `RestrictedSourceContext` DTO; `FollowUpListItem`; `JobCardHistoryItem` link metadata (`followUp: { sourceJobCardId } \| null`, `childCount: number \| null`). |
| `server/src/modules/job-cards/create-input.ts` | `normalizeFollowUpCreateInput` (validates instructions presence/length, type-specific `scheduledAt`/`dueDate`, customer/contact ownership, assignee existence via existing lookups). |
| `server/src/modules/job-cards/policy.ts` | `assertCanCreateFollowUp(actor)` → `STAFF` forbidden; `assertSourceEligible(source)` → `COMPLETED` only. |
| `server/src/modules/job-cards/repository.ts` | Row mappers + SQL: `getFollowUpSource(organizationId, sourceId)` (status + customer/contact + `scheduled_at` + `manager_approved_at` + `type` + meeting outcome), `listFollowUps(actor, jobCardId, pagination)` (children, reach-filtered), `listJobCardHistory(orgId, where, limit, offset)` shared by customer/staff history, `countJobCardHistory(orgId, where)`, `getRestrictedSourceContext(...)` (join follow-up → source → meeting outcome), `childCount` subquery. |
| `server/src/modules/job-cards/service.ts` | `createFollowUp(actor, sourceId, input)` — claim `JOB_FOLLOW_UP_CREATE:<sourceId>`; eligibility + chain-depth walk (cap 10); insert with link; `JOB_CREATED` activity with `metadata.sourceJobCardId`; existing notifications path; realtime with extra keys. `listFollowUps(actor, jobCardId)`, `getSourceCard(actor, jobCardId)` (management-only), `getSourceContext(actor, jobCardId)`. |
| `server/src/modules/job-cards/handlers.ts` + `routes.ts` | `POST /api/job-cards/:sourceId/follow-ups`, `GET /api/job-cards/:id/follow-ups`, `GET /api/job-cards/:id/source`, `GET /api/job-cards/:id/source-context`. |
| `server/src/modules/crm/types.ts` + `repository.ts` + `handlers.ts` + `routes.ts` | `CustomerDetail` gains `openJobCount`, `completedJobCount` (staffScope-filtered); embedded arrays removed; `GET /api/customers/:customerId/jobs`. |
| `server/src/modules/people/repository.ts` + `service.ts` + `handlers.ts` + `routes.ts` | `GET /api/staff/:userId/jobs` (Admin/Manager any; STAFF self-only via existing guard style); reuses `listJobCardHistory`. |
| `server/src/modules/calendar/repository.ts` + `types.ts` | `CALENDAR_LIST_SQL` LEFT JOIN to source; `followUp` payload + management-only `sourceJobPath`. |
| `server/src/modules/realtime/event-mapper.ts` | `JOB_CREATED` mapping appends `job-detail:<sourceJobCardId>`, `customer-detail:<customerId>` when present. |
| `server/src/modules/job-cards/activity-presenter.ts` | No behavioral change required; `JOB_CREATED` metadata is bodyless-presented (verify in F1 with a test). |
| `server/src/modules/job-cards/validation.ts` | Register new route input schemas (Fastify JSON schema style used by the module). |

---

## 6. API contracts

### 6.1 `POST /api/job-cards/:sourceId/follow-ups` (new)

Request (`FollowUpCreateInput`):

```jsonc
{
  "clientActionId": "uuid",                       // required, idempotency key
  "type": "PRODUCT_DELIVERY | GENERAL_TASK | SALES_MEETING",
  "title": "string 1..255 non-whitespace",
  "followUpInstructions": "string 1..4000 non-whitespace",   // REQUIRED (D3)
  "scheduledAt": "ISO | null",                    // required for PRODUCT_DELIVERY, SALES_MEETING
  "scheduledEndsAt": "ISO | null",
  "assignedTo": "uuid",
  "priority": "low | normal | high | urgent",     // default normal
  "dueDate": "YYYY-MM-DD | null",                 // not allowed for SALES_MEETING
  "customerId": "uuid",                           // MUST equal source customerId (D6)
  "contactId": "uuid | null",                     // must belong to customer
  "engagementKind": "SALES_MEETING | null"        // SALES_MEETING only
}
```

Responses:

- `201` — full `JobCardDetail` (now including `sourceJobCardId`, `followUpInstructions`).
- `400 VALIDATION_ERROR`, `400 FOLLOW_UP_INSTRUCTIONS_REQUIRED`.
- `403 FORBIDDEN` — STAFF or cross-org.
- `404 JOB_CARD_NOT_FOUND` — source id not found / other org (anti-enumeration).
- `409 FOLLOW_UP_SOURCE_NOT_COMPLETED` — source not `COMPLETED`.
- `409 FOLLOW_UP_CUSTOMER_MISMATCH`, `409 CONTACT_NOT_IN_CUSTOMER`, `409 CUSTOMER_INACTIVE`, `409 CONTACT_INACTIVE`, `409 ASSIGNEE_NOT_FOUND`.
- `409 JOB_FOLLOW_UP_CHAIN_DEPTH_EXCEEDED`.
- `409 ACTION_IN_PROGRESS` — duplicate concurrent claim.
- Idempotent replay — `201` with stored response.

### 6.2 `GET /api/job-cards/:id/follow-ups` (new)

`{ items: FollowUpListItem[], total, limit, offset }`; reach = `actorCanReachJob` on `:id`. `FollowUpListItem = JobCardListItem + { sourceJobCardId, followUpInstructions }`. Sort `created_at DESC, id`.

### 6.3 `GET /api/job-cards/:id/source` (new, management-only)

Full `JobCardDetail` of the source; `ADMIN`/`MANAGER` only. `STAFF` → `404` (never reveals existence). `404` when `:id` is not a follow-up.

### 6.4 `GET /api/job-cards/:id/source-context` (new, restricted DTO)

Contract per design §6.2. Reach: actor must reach `:id` (the follow-up). `404` when not a follow-up or source unreachable. Access derived from **current** `assigned_to`; reassignment revokes (server derives, no stored grants).

### 6.5 `GET /api/customers/:customerId/jobs` (new)

Query: `status=open|completed|all` (default `all`), `limit` (default 20, max 100), `offset`. Response `Paginated<CustomerJobHistoryItem>` (shape per design §8.2). `staffScope` applied for `STAFF`; `childCount` `null` for `STAFF`. `404` when customer not found/other org. `CustomerDetail` DTO gains `openJobCount`/`completedJobCount`; embedded `openJobs`/`completedJobs` arrays are removed in the same slice.

### 6.6 `GET /api/staff/:userId/jobs` (new)

Same query/response shape; `ADMIN`/`MANAGER` any org staff; `STAFF` self-only (else `404`).

### 6.7 Calendar payload change

`JobCalendarEvent` gains `followUp: null | { sourceJobCardId, previousVisitScheduledAt: string | null, completedAt: string | null, instructions: string | null }`; management-only `sourceJobPath`. Backwards-compatible additive change (web parser tolerates optional fields).

---

## 7. Web surfaces

| Surface | Change |
|---|---|
| `web/src/paths.ts` | `newFollowUp: (sourceId: string) => \`/jobs/new-follow-up?source=${sourceId}\``. |
| `web/src/AppRouter.tsx` | Route for `/jobs/new-follow-up` → `FollowUpCreatePage` (management-guarded like the other create routes). |
| `web/src/jobs/jobs-api.ts` | `JobCard` parser gains `sourceJobCardId`, `followUpInstructions`; new `createFollowUp()`; new parsers for `FollowUpListItem`, `RestrictedSourceContext`, `JobCardHistoryItem`. |
| `web/src/JobDetail.tsx` | (a) Management + `COMPLETED`: primary action "Takip işi oluştur" + (SALES_MEETING with `FOLLOW_UP_REQUIRED`) recommendation panel (Emphasized Card); (b) follow-up detail: "Takip" badge; (c) children panel "Takip işleri" (reach-filtered server-side); (d) chain breadcrumb (management); (e) staff: restricted source-context panel (Section + Card, safe fields only). |
| `web/src/FollowUpCreatePage.tsx` (new, under `web/src/jobs/`) | Form per contract 6.1; source summary panel (safe structured info); pre-fills `scheduledAt = nextFollowUpAt` when source is SALES_MEETING with proposal; customer locked to source customer; loading/success/error states; mobile-first layout per visual language; 403/404/409 error mapping incl. `FOLLOW_UP_SOURCE_NOT_COMPLETED` and `ACTION_IN_PROGRESS`. |
| `web/src/CustomerDetail.tsx` | Replace embedded slices with paginated history (tabs open/completed/all, "Takip" badge, pagination controls); counts from new DTO fields. |
| `web/src/StaffProfiles.tsx` | "İş geçmişi" paginated section (self + management view). |
| `web/src/calendar/CalendarPage.tsx` + `web/src/services/calendar-api.ts` | Follow-up indicator + management source deep link (`sourceJobPath`) / staff restricted context inline (previous visit date + instructions). |
| `web/src/realtime/RealtimeProvider.tsx` | No change needed; existing invalidation by resource key covers new keys automatically (verify in runtime). |

---

## 8. Permission matrix

| Action | ADMIN | MANAGER | STAFF (assignee, performed source) | STAFF (assignee, not source) | STAFF (not assignee) |
|---|---|---|---|---|---|
| Create follow-up from `COMPLETED` source | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Create from non-`COMPLETED` source | ❌ 409 | ❌ 409 | — | — | — |
| View follow-up detail | ✅ | ✅ | ✅ | ✅ | ❌ 404 |
| View follow-up children | ✅ | ✅ | ✅ (own) | ✅ (own) | ❌ 404 |
| View full source (`/source`) | ✅ | ✅ | ✅ (own history) | ❌ 404 | ❌ 404 |
| View restricted context (`/source-context`) | ✅ (full supersedes) | ✅ | ✅ | ✅ | ❌ 404 |
| View customer history | ✅ all | ✅ all | ✅ own rows/counts | ✅ own rows/counts | ✅ own rows/counts |
| View staff history (`/api/staff/:userId/jobs`) | ✅ any | ✅ any | ✅ self only | ✅ self only | ✅ self only |
| Calendar: follow-up event | ✅ all | ✅ all | ✅ own + context | ✅ own + context | ✅ own only |
| Calendar: `sourceJobPath` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `childCount` in history payloads | ✅ | ✅ | ❌ (null) | ❌ (null) | ❌ (null) |

All cross-org access resolves to `404`/`403` via existing reach rules; no new role logic beyond `assertCanCreateFollowUp` (design D2, D7).

---

## 9. Idempotency

- **Claim:** `JOB_FOLLOW_UP_CREATE:<sourceJobCardId>` + `clientActionId` per actor — follows the `JOB_NOTE_ADD:<jobCardId>` precedent and reuses `executeCriticalAction` (`processed_actions` claim → insert → `JOB_CREATED` activity with the same `clientActionId` → notifications → realtime).
- Duplicate request → stored `201` response replay; concurrent duplicate → `409 ACTION_IN_PROGRESS`.
- The chain-depth walk happens inside the critical work; depth check failures mark the claim `failed` (existing pattern).
- No other new mutations: follow-up lifecycle uses existing per-command keys; `PATCH` of `follow_up_instructions` (management-only, while `NEW`/`ACCEPTED`) is a plain `JOB_FIELDS_UPDATED` mutation like other fields (no new claim; matches existing `patch` behavior).

---

## 10. Activity / audit

- `JOB_CREATED` on the follow-up, `new_value` including `sourceJobCardId`, `metadata.sourceJobCardId` — one canonical activity record; source card untouched (append-only history, design §13.6).
- `JOB_ASSIGNED` fires only if management reassigns immediately after creation (existing path).
- No new event type; `job_card_activity_logs` CHECK constraints unchanged.
- Activity timeline on the follow-up works exactly like any JobCard (existing `GET /:id/activity`).

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

- **Scope:** migration `022`; `types.ts`; `create-input.ts`; `policy.ts`; `repository.ts` (source/link queries); `service.ts` `createFollowUp` + `listFollowUps` + `getSourceCard` + `getSourceContext`; `handlers.ts`/`routes.ts` (4 new routes); validation schemas; activity presenter test; `migrate-runner.test.ts` update.
- **Changed files (server):** as listed; plus `server/tests/migrate-runner.test.ts`, new `server/tests/job-card-follow-up.test.ts`, `server/tests/job-card-follow-up-activity.test.ts`, `server/tests/job-card-follow-up-policy.test.ts`, `server/tests/job-card-follow-up-idempotency.test.ts`.
- **Tests:** creation happy path (each type); instructions required (400); STAFF create → 403; source not COMPLETED → 409; customer mismatch/contact not-in-customer → 409; chain depth 10 → 409; self-link impossible; children list reach filtering; restricted context content + exclusions; `/source` 404 for STAFF; replay + concurrent claim; activity record + `metadata.sourceJobCardId`; realtime keys `job-detail:<source>` / `customer-detail:<customer>`; notification `job.assigned` (no new kind); migration list now 001–022.
- **Runtime scenarios:** seeded org; ADMIN creates follow-up for COMPLETED delivery; verify board/detail/activity; verify restricted context as second staff user; verify 404/409 paths.
- **Completion gate:** `cd server && npm run build`, `cd server && npm test -- --run`, `cd server && npm run lint`; all green; contract tests updated.
- **Non-goals:** no web changes; no customer/staff/calendar endpoints.
- **PR:** single PR `feat: linked follow-up JobCard server contract` against `main`.

### F2 — Follow-up creation + JobDetail continuity UI

- **Scope:** `paths.ts`, `AppRouter.tsx`, `FollowUpCreatePage.tsx` (new), `JobDetail.tsx` (create action, badge, children panel, chain breadcrumb, restricted context panel), `jobs-api.ts` parsers; `MeetingDetails.tsx` untouched except navigation constants.
- **Changed files (web):** as listed; new `web/src/jobs/FollowUpCreatePage.tsx`, `web/src/jobs/follow-up-presentation.ts` (labels/badges), new web tests for parser + form validation.
- **Tests:** web build; parser tests for new fields; form error mapping (409s); management-only action visibility (component-level).
- **Runtime scenarios:** as ADMIN create follow-up from completed SALES_MEETING with `FOLLOW_UP_REQUIRED`; as STAFF open the follow-up: restricted panel visible, source link absent; as second STAFF (not assignee): 404 page; mobile viewport check.
- **Completion gate:** `cd web && npm run build`, `cd web && npm run lint`; server contract from F1 still green; manual flows verified (see §15).
- **Non-goals:** customer/staff/calendar surfaces (F3).
- **PR:** `feat: linked follow-up JobCard creation UI`.

### F3 — Customer / Staff / Calendar history integration

- **Scope:** crm `types.ts`/`repository.ts`/`handlers.ts`/`routes.ts` (counts + `/jobs` endpoint, embedded arrays removed); people `repository.ts`/`service.ts`/`handlers.ts`/`routes.ts` (`/api/staff/:userId/jobs`); calendar `repository.ts`/`types.ts` (`followUp` payload, `sourceJobPath`); web `CustomerDetail.tsx`, `StaffProfiles.tsx`, `CalendarPage.tsx`, `calendar-api.ts`; realtime key `customer-detail:<id>`.
- **Changed files:** as listed; new `server/tests/crm-job-history.test.ts`, `server/tests/people-job-history.test.ts`, `server/tests/calendar-follow-up.test.ts`; updated `server/tests/crm-routes.test.ts` (embedded arrays removed), web parser/history tests.
- **Tests:** role-filtered rows + counts (staff sees only own); `childCount` null for STAFF; pagination (limit clamp, offset); staff self-only history; calendar payload + management-only `sourceJobPath`; realtime invalidation.
- **Runtime scenarios:** staff user opens customer with other staff's completed jobs → own rows only, counts exclude others; manager sees all + childCount; calendar shows follow-up indicator for manager with source link, staff without; staff profile history pagination.
- **Completion gate:** full command battery (server build/test/lint, web build/lint); no compatibility fallbacks retained.
- **Non-goals:** no new notification kinds; no calendar schema changes.
- **PR:** `feat: role-filtered follow-up history surfaces`.

### F4 — Runtime acceptance & evidence closeout

- **Scope:** end-to-end verification against real PostgreSQL + Fastify + Vite (test database seeded per AGENTS.md workflow), multi-role browser walkthrough, privacy scenario sweep, evidence capture.
- **Steps:**
  1. Fresh schema via migrations 001–022; seed org with ADMIN, MANAGER, staff A, staff B, customer+contacts, products.
  2. As staff A: complete a PRODUCT_DELIVERY and a SALES_MEETING (`FOLLOW_UP_REQUIRED` + `nextFollowUpAt`).
  3. As ADMIN: create follow-ups (same assignee, different assignee, chain of 2, sibling); verify notifications (`job.assigned`) and realtime invalidation in two browser sessions.
  4. As staff B (follow-up assignee, not source): verify restricted context contents/exclusions, 404 on `/source`, calendar restricted context, customer history own-only.
  5. Negative sweep: staff create → 403; source not completed → 409; instructions missing → 400; duplicate `clientActionId` → replay; depth 11 → 409.
  6. Capture evidence: test logs, browser screenshots of restricted panel/calendar/customer history, network payload checks (bodyless SSE/notification payloads).
- **Completion gate:** all acceptance scenarios pass; evidence artifacts attached to the F4 PR description; `git diff --check` clean.
- **PR:** `test: linked follow-up JobCard runtime acceptance` (or appended to F3 if gate policy allows — decided by the implementer at that point; default: separate).

**PR sequencing rule:** F1 → F2 → F3 → F4, each against `main`, each gated by its completion gate. Design doc decisions are not re-negotiable in PR review unless a real defect is found (then a follow-up design amendment PR updates this document).

---

## 13. File-level change map (cumulative)

Server (new): `server/src/db/migrations/022_job_card_follow_up_links.sql`, `server/tests/job-card-follow-up.test.ts`, `server/tests/job-card-follow-up-activity.test.ts`, `server/tests/job-card-follow-up-policy.test.ts`, `server/tests/job-card-follow-up-idempotency.test.ts`, `server/tests/crm-job-history.test.ts`, `server/tests/people-job-history.test.ts`, `server/tests/calendar-follow-up.test.ts`.

Server (modified): `server/src/modules/job-cards/types.ts`, `create-input.ts`, `policy.ts`, `repository.ts`, `service.ts`, `handlers.ts`, `routes.ts`, `validation.ts`, `activity-presenter.ts` (only if presenter test demands); `server/src/modules/crm/{types,repository,handlers,routes}.ts`; `server/src/modules/people/{repository,service,handlers,routes}.ts`; `server/src/modules/calendar/{repository,types}.ts`; `server/src/modules/realtime/event-mapper.ts`; `server/tests/migrate-runner.test.ts`; `server/tests/crm-routes.test.ts` (embedded arrays removed).

Web (new): `web/src/jobs/FollowUpCreatePage.tsx`, `web/src/jobs/follow-up-presentation.ts`, web test files for parsers/form.

Web (modified): `web/src/paths.ts`, `web/src/AppRouter.tsx`, `web/src/JobDetail.tsx`, `web/src/jobs/jobs-api.ts`, `web/src/CustomerDetail.tsx`, `web/src/StaffProfiles.tsx`, `web/src/calendar/CalendarPage.tsx`, `web/src/services/calendar-api.ts`.

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
| 12 | Web vertical flows: create → board → detail → restricted context → customer history → calendar | runtime (F4) |
| — | Privacy: restricted context exclusions; `childCount` null; bodyless payloads; `/source` 404 | server + runtime |
| — | Migration: 001–022 order + schema version 22 | server |

---

## 15. Runtime acceptance (F4 checklist)

1. `docker`-managed PostgreSQL with migrations 001–022 applied; seed per §12-F4.
2. `cd server && npm run build && npm test -- --run && npm run lint` — green.
3. `cd web && npm run build && npm run lint` — green.
4. Browser walkthrough (Chrome): flows listed in §12-F4 with two staff sessions + one manager session.
5. Network tab: notification/SSE payloads contain ids only; `/source-context` payload matches contract exactly.
6. Mobile viewport (375px): create form, restricted panel, calendar event, customer history usable.
7. Console: no errors/warnings on the touched pages.

---

## 16. Evidence requirements

- Every slice PR description lists: changed files, commands run with outputs, runtime scenario results.
- F4 PR attaches screenshots + payload captures.
- This documentation checkpoint's own evidence: `git diff --check` output, `git status --short` (only the two docs), PR URL + state, base/head SHAs (see the PR description and the final handoff).

---

## 17. Risk register

| Risk | Mitigation |
|---|---|
| Restricted context accidentally expanded later | Contract fixed in design §6; server DTO is the single source; tests assert exact exclusions. |
| `childCount` leakage | Management-only field, server-computed, `null` for STAFF; tested in F3. |
| Reassignment race on follow-up (context revoke) | Context derived from current `assigned_to` inside the read transaction; no stored grants; test covers post-reassignment access. |
| Chain depth abuse | Service walk cap 10 + immutable link; DB CHECK prevents self-link. |
| Migration drift (migrate-runner) | F1 updates the exact-list test in the same PR as the migration. |
| Counts revealing other staff work in customer detail | Counts reuse the exact `staffScope` predicate; F3 tests assert equality with filtered list. |
| Web payload regression (calendar additive field) | Optional-field parsing; runtime check in F4. |
| Scope creep during implementation | Slice non-goals are binding; PRs must not touch unrelated modules (AGENTS.md §3). |

---

## 18. Rollout and merge gates

1. This documentation PR: **Draft**, base `main` at `33aa7997a24a335a773017e521002db86ff2bd90`. Merge only after external review (GPT-5.6) approves the design. Merging and staging/production moves are **not authorized** in this checkpoint.
2. F1–F4: separate PRs per slice; each requires its completion gate green and the previous slice merged.
3. No migration is ever edited after application; no production data migration beyond `022` is anticipated (design R15 rollback path is pre-production-only, explicitly approved by the user).
4. On completion of every slice, update this plan (AGENTS.md §11) and the design doc only if a defect-driven amendment was approved.
