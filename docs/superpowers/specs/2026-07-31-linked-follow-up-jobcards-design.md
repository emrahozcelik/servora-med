# Linked Follow-up JobCards — Design

- **Status:** Approved (checkpoint design; implementation planned separately)
- **Date:** 2026-07-31
- **Scope:** Product design and binding decisions for Linked Follow-up JobCards. The implementation plan lives in [`2026-07-31-linked-follow-up-jobcards.md`](../plans/2026-07-31-linked-follow-up-jobcards.md).
- **Predecessors:**
  - [`2026-07-12-customers-contacts-design.md`](2026-07-12-customers-contacts-design.md) — line 50: "completed work creates a linked follow-up JobCard instead of reopening the completed record" (deferred decision, resolved here).
  - [`2026-07-15-sales-meeting-design.md`](2026-07-15-sales-meeting-design.md) — `nextFollowUpAt` semantics; `FOLLOW_UP_REQUIRED` outcome.
  - [`2026-07-17-job-acceptance-scheduling-design.md`](2026-07-17-job-acceptance-scheduling-design.md) — reassignment boundaries; `ACCEPTED` semantics.
  - [`2026-07-29-job-lifecycle-operational-notes-design.md`](2026-07-29-job-lifecycle-operational-notes-design.md) — note privacy; secondary-surface privacy; "Optional linked follow-up JobCards require a separate product gate and PR" (this document is that gate).
  - [`2026-07-26-servora-ant-visual-language.md`](2026-07-26-servora-ant-visual-language.md) — Canvas/Section/Card/Emphasized Card/Raised Layer for all web surfaces below.

---

## 1. Purpose

A JobCard that reaches `COMPLETED` is immutable business history: it cannot be reopened, its delivery items and notes are shared append-only history, and its lifecycle is closed. When work is not finished in one card — a follow-up visit, a second delivery, a re-approach after `FOLLOW_UP_REQUIRED` — the system must create a **new, linked follow-up JobCard** instead of reopening or copying the completed record.

This design defines:

1. What a Linked Follow-up JobCard is (the only supported relationship kind between JobCards).
2. Who may create it, from which sources, with which mandatory content.
3. How visibility and privacy work for every surface (board, detail, customer, staff profile, calendar, notifications, realtime).
4. How the existing Sales Meeting `nextFollowUpAt` proposal becomes a management-approved follow-up.
5. The canonical data model, API contracts, and implementation slices (in the plan document).

The system treats every JobCard as a first-class standalone unit of work. The link is **metadata about history**, never a coupling that changes lifecycle rules.

---

## 2. Approved product decisions

| # | Decision | Binding rule |
|---|----------|--------------|
| D1 | **Source eligibility** | Only `COMPLETED` JobCards can be follow-up sources. `CANCELLED` and unfinished sources are rejected with `409 FOLLOW_UP_SOURCE_NOT_COMPLETED`. |
| D2 | **Creation authority** | Only `ADMIN` and `MANAGER` can create a follow-up JobCard. `STAFF` receives `403 FORBIDDEN` even on their own cards. |
| D3 | **Mandatory instructions** | Every follow-up JobCard must carry explicit management-provided follow-up instructions stored in a dedicated structured field (`follow_up_instructions`), enforced at the database, service, and API layers. |
| D4 | **Assignee freedom** | Management may assign the follow-up to the same staff user or a different one. Assigning to a different user follows the existing reassignment semantics (card created in `NEW`; no acceptance to clear). |
| D5 | **Multiple children and chains** | One source may have many follow-ups (siblings). A follow-up may itself become a source once `COMPLETED` (chain). Self-links are impossible; cycles are impossible by construction; depth is capped at 10 to bound traversal. |
| D6 | **Customer consistency** | The follow-up inherits the source's customer (`customerId` must equal the source's `customerId` — both may be null). Contacts must belong to that customer (existing rule). |
| D7 | **Staff own-history rule** | A `STAFF` actor may see only JobCards where they are the current assignee. This applies everywhere: board, detail, follow-ups list, customer history, staff profile history, calendar. |
| D8 | **Restricted source context** | A staff assignee who did **not** perform the source card gets a restricted, structured read-only view of the source: type, completion date, planned visit date, customer, contact, meeting outcome, and the follow-up instructions. Never note bodies, timeline, delivery details, attachments, other links, or other staff identity. |
| D9 | **No automatic copying** | Follow-up creation never copies notes, delivery items, meeting summaries, or any other content from the source. |
| D10 | **Proposal vs decision** | `nextFollowUpAt` (Sales Meeting) is a **Staff proposal**. The follow-up's `scheduledAt` is the **management-approved decision**. `FOLLOW_UP_REQUIRED` never auto-creates a JobCard. |
| D11 | **Notification reuse** | Follow-up creation reuses the existing `job.assigned` notification path (creation mapping). No new notification kind. |
| D12 | **Realtime reuse** | Follow-up creation reuses the existing `job.created` realtime event. No new event type. Payloads stay bodyless. |
| D13 | **Privacy invariant** | Follow-up linkage must never leak source details through calendar, notification, realtime, or list payloads to staff who cannot reach the source card. |
| D14 | **Canonical entry point** | The primary entry point for creating a follow-up is the **source JobCard detail page** (management view). Secondary entry points: customer history rows and the `FOLLOW_UP_REQUIRED` recommendation panel. |

---

## 3. Terminology

- **Source JobCard** — the `COMPLETED` card that a follow-up originates from.
- **Follow-up JobCard** — a new card with `source_job_card_id` pointing at the source. It is a normal JobCard in every lifecycle sense (statuses, approval, delivery items, notes, activity).
- **Sibling follow-ups** — multiple follow-up cards sharing the same source.
- **Follow-up chain** — a follow-up that is itself `COMPLETED` and has its own follow-up. `source_job_card_id` points at the direct parent only; ancestry is derived by traversal.
- **Restricted source context** — the safe, structured summary of the source shown to a staff assignee who could not reach the source card.
- **Own history** — for a `STAFF` actor, the set of JobCards where `assigned_to = self`.

---

## 4. User journeys

### 4.1 Manager creates a follow-up after a completed delivery

1. Manager opens the completed `PRODUCT_DELIVERY` JobCard (board → detail).
2. The detail shows the primary action **"Takip işi oluştur"** (enabled because the card is `COMPLETED` and the actor is management).
3. The manager is taken to `/jobs/new-follow-up?source=<sourceId>`. The form is pre-filled from the source: customer locked to the source customer, contact, suggested `scheduledAt`, suggested type. The `follow_up_instructions` field is mandatory and initially empty.
4. The manager picks the assignee (same or different), priority, and completes the instructions.
5. On submit the server creates the follow-up in `NEW` with `source_job_card_id` set, writes a `JOB_CREATED` activity with `metadata.sourceJobCardId`, and emits the existing `job.created` realtime event (invalidation: `job-board`, `job-list`, `overview`, `reports`, `staff-profile:<assignee>`, `job-detail:<sourceId>`, `customer-detail:<customerId>`).
6. The assignee receives the standard `job.assigned` in-app notification. Nothing in the notification reveals source content.

### 4.2 Staff assignee sees only safe context

1. The staff user opens their new follow-up from the board.
2. A compact **"Önceki iş bağlamı"** panel shows: "Bu iş, 12 Tem 2026 tarihinde tamamlanan bir satış ziyaretinin takibidir." plus customer/contact, outcome badge, and the management instructions.
3. The panel contains no note bodies, no timeline, no delivery details, no other staff names, no link to the full source card (a `STAFF` actor gets `404` on the full source endpoint).
4. If the same staff user had performed the source card, the panel shows a normal link to the source detail instead (they can reach it).

### 4.3 Manager continues a chain

1. The follow-up completes (staff submits, manager approves).
2. The follow-up's detail now shows "Takip işi oluştur" again — the chain continues.
3. A chain breadcrumb on the detail shows ancestor cards (management only; staff see only their own reachable ancestors).

### 4.4 Customer history (role-filtered)

1. The customer page lists all job history (open/completed tabs) with pagination.
2. Rows for follow-ups show a **"Takip"** badge. Management rows also show child counts and quick follow-up creation.
3. A `STAFF` viewer sees only their own JobCards for this customer — both rows and counts are filtered server-side; counts never leak other staff members' work.

### 4.5 Staff profile history

1. The staff profile page gains a **"İş geçmişi"** section (paginated).
2. `ADMIN`/`MANAGER` see any staff member's history; a `STAFF` user sees only their own profile.

### 4.6 Calendar

1. A follow-up scheduled for a future date appears in the calendar as a normal event.
2. Management events show a follow-up indicator and a link to the source; staff events show the restricted context (previous visit date + instructions) inline, never a source link.

---

## 5. Role visibility

| Actor | Source card (full detail) | Restricted source context | Follow-up card | Children list | Create follow-up | Customer history | Staff history | Calendar event |
|---|---|---|---|---|---|---|---|---|
| `ADMIN` | ✅ any org card | ✅ (full supersedes) | ✅ | ✅ | ✅ any completed | ✅ all + counts | ✅ any staff | ✅ all |
| `MANAGER` | ✅ any org card | ✅ (full supersedes) | ✅ | ✅ | ✅ any completed | ✅ all + counts | ✅ any staff | ✅ all |
| `STAFF` (assignee of follow-up, performed source) | ✅ source + follow-up | ✅ (via full view) | ✅ | ✅ (own cards) | ❌ `403` | ✅ own cards only | ✅ self only | ✅ own cards |
| `STAFF` (assignee of follow-up, did not perform source) | ❌ `404` | ✅ restricted DTO | ✅ | ✅ (own cards) | ❌ `403` | ✅ own cards only | ✅ self only | ✅ own cards + restricted context |
| `STAFF` (not assignee) | ❌ `404` | ❌ `404` | ❌ `404` | ❌ `404` | ❌ `403` | ✅ own cards only | ✅ self only | ✅ own cards only |

Notes:

- "Own cards" for a staff user means `assigned_to = self` (existing `actorCanReachJob` rule in `server/src/modules/job-cards/policy.ts`).
- A follow-up that is `COMPLETED` or `CANCELLED` remains reachable by its assignee (own work history), and the restricted context stays available to that assignee.
- Reassignment of a follow-up transfers reach; the previous assignee loses access (existing reassignment semantics).
- All cross-organization attempts resolve to `404` / `403` exactly like existing routes (no enumeration).

---

## 6. Restricted source context

### 6.1 Why it exists

`actorCanReachJob` intentionally limits staff to their own cards. A follow-up assignee who did not perform the source card still needs **safe, useful history** to do the follow-up. The restricted context is the canonical answer: a deliberately minimal, structured, read-only DTO that never carries private history.

### 6.2 Contract (stable, canonical)

`GET /api/job-cards/:id/source-context` — `:id` is the **follow-up** card. Reach: actor must reach the follow-up card (own assignee or management). Returns `404` when the card is not a follow-up or the source is unreachable/removed.

```jsonc
{
  "jobCardId": "uuid",                    // the follow-up
  "isFollowUp": true,
  "source": {
    "sourceJobCardId": "uuid",
    "sourceType": "SALES_MEETING",
    "completedAt": "2026-07-31T09:34:50.000Z",   // source.manager_approved_at
    "scheduledAt": "2026-07-12T08:00:00.000Z",   // source.scheduled_at (planned visit), may be null
    "customer": { "id": "uuid", "name": "..." }, // null only when source had no customer
    "contact": { "id": "uuid", "name": "..." },  // null when source had no contact
    "outcome": "FOLLOW_UP_REQUIRED"              // SALES_MEETING sources only; else null
  },
  "followUpInstructions": "management-provided instructions",
  "followUpCreatedAt": "2026-07-31T10:00:00.000Z"
}
```

### 6.3 Explicit exclusions

The restricted context **never** contains: note bodies, timeline/activity events, approval reasons, revision reasons, delivery items, attachments, engagement history, other follow-ups (siblings), chain navigation, `assignedTo`/`createdBy` identity, or any free-text beyond `follow_up_instructions`.

### 6.4 Access lifecycle

- Access is derived from **current** `assigned_to`; reassignment revokes it from the previous assignee.
- If the source link is removed (planned rollback path only, see §15), the context returns `404`.
- The context is always served from the persisted source row + `job_card_meeting_details.outcome`; it is never cached client-side beyond normal HTTP caching rules.

---

## 7. Data ownership

### 7.1 Canonical model: self-referencing column (Option A)

One column on `job_cards`:

- `source_job_card_id UUID NULL` — direct parent link.
- `follow_up_instructions TEXT NULL` — mandatory management instructions, present **iff** `source_job_card_id` is set (database-enforced).

Rationale for rejecting the generic `job_card_links` table (Option B):

- Only **one** relationship kind exists in the product vocabulary (follow-up-of). A generic link table would add a table, a new authorization surface, and new payload shapes for zero product value (YAGNI, AGENTS.md §1.2).
- The column keeps the relationship under the existing `job_cards` row security and the existing `UNIQUE (organization_id, id)` pattern.
- Follow-up instructions belong to the card itself, so they live on the row, not in a link table.

### 7.2 Integrity rules (database level)

```sql
-- self-link impossible
CHECK (source_job_card_id IS DISTINCT FROM id)
-- every follow-up carries instructions
CHECK (source_job_card_id IS NULL OR follow_up_instructions IS NOT NULL)
-- same organization
FOREIGN KEY (organization_id, source_job_card_id)
  REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT
```

### 7.3 Source mutability

The source card never changes when a follow-up is created. No `has_follow_up` flag, no counters on the source row — derived state only (`EXISTS` / child count), because derived state cannot drift (AGENTS.md §2.1).

### 7.4 Chain depth

Service-level ancestor walk capped at **10** (`JOB_FOLLOW_UP_CHAIN_DEPTH_EXCEEDED` → `409`). Cycles are impossible at creation (a new card is always a leaf; `source_job_card_id` is immutable), and the walk is defensive.

---

## 8. Customer history

### 8.1 Today

`GET /api/customers/:customerId` (`server/src/modules/crm/repository.ts` `getCustomerDetail`) embeds two fixed slices: `openJobs` and `completedJobs` (first 5 each), with a `staffScope` predicate (`AND assigned_to = $self` for staff). No pagination, no link metadata, and the embedded arrays cannot express role-filtered counts.

### 8.2 Target

- Add `openJobCount` and `completedJobCount` to `CustomerDetail` (role-filtered counts, same `staffScope`).
- Replace the embedded arrays with a new paginated endpoint `GET /api/customers/:customerId/jobs?status=open|completed|all&limit&offset` returning `Paginated<CustomerJobHistoryItem>`.
- Item shape (role-filtered server-side):

```jsonc
{
  "id": "uuid",
  "title": "string",
  "type": "PRODUCT_DELIVERY | GENERAL_TASK | SALES_MEETING",
  "status": "string",
  "priority": "string",
  "scheduledAt": "ISO | null",
  "dueDate": "YYYY-MM-DD | null",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "assignee": { "id": "uuid", "name": "string" },
  "followUp": { "sourceJobCardId": "uuid" } | null,
  "childCount": 2                  // ADMIN/MANAGER only; null for STAFF
}
```

- `childCount` is `null` for `STAFF` to avoid leaking the existence of other staff members' cards.
- Web `CustomerDetail.tsx` moves from the embedded slices to this endpoint with pagination; the embedded arrays are removed from the DTO in the same slice (server + web + tests together, no compatibility fallback per AGENTS.md §2.2).

### 8.3 Guardrails

- Counts and rows apply the exact same `staffScope` — counts can never reveal other staff work.
- Sort: `created_at DESC, id` for stable pagination (keyset not required at MVP volume; offset pagination matches the codebase's existing list pagination style).
- `limit` clamped (default 20, max 100).

---

## 9. Staff history

### 9.1 Today

`GET /api/people/me` and `GET /api/people/:userId` return counters (`open`, `waitingApproval`, `revisionRequested`, `completedThisMonth`, `overdue`) via `StaffOperationalSummaryPort` in `server/src/modules/people/`. There is no job history list.

### 9.2 Target

`GET /api/people/:userId/jobs?status=open|completed|all&limit&offset` → `Paginated<StaffJobHistoryItem>`:

- `ADMIN`/`MANAGER`: any staff user in the organization (existing `getStaffProfile` authorization, `requireAdminOrManager`).
- `STAFF`: only `userId = self`; anything else resolves to `404` (existing own-profile pattern).
- Item shape mirrors `CustomerJobHistoryItem` (including `followUp` link metadata and management-only `childCount`).

### 9.3 Web surface

`StaffProfiles.tsx` gains a paginated "İş geçmişi" section (own profile and management view), using the same visual language as the customer history list. This also directly serves AGENTS.md §3.6 (staff profile shows open/waiting/revision/completed jobs and delivery history).

---

## 10. Calendar behavior

### 10.1 Today

`GET /api/calendar/events` (`server/src/modules/calendar/repository.ts`, `CALENDAR_LIST_SQL` joins `job_cards`, `customers`, `users`) returns `JobCalendarEvent` with `relatedJobPath` and `jobCardId`. Reachability: staff see only their own `assigned_to`; management see org-wide.

### 10.2 Target

- `CALENDAR_LIST_SQL` gains a `LEFT JOIN` to the follow-up source (`job_cards src` on `src.organization_id = j.organization_id AND src.id = j.source_job_card_id`), selecting `j.source_job_card_id`, `j.follow_up_instructions`, `src.scheduled_at`, `src.manager_approved_at`.
- `JobCalendarEvent` gains `followUp: null | { sourceJobCardId, previousVisitScheduledAt, completedAt, instructions }`.
- Management payload additionally gains `sourceJobPath` (deep link to the full source detail). Staff payloads never include `sourceJobPath`.
- No schema change, no new calendar entry type: the follow-up is a normal scheduled JobCard event.

### 10.3 Guardrails

- The restricted context rule applies: `instructions` are the follow-up's own `follow_up_instructions` (management-authored for this follow-up), never source free-text.
- `previousVisitScheduledAt`/`completedAt` come from the source row only — no notes, no outcome beyond what the restricted context allows (outcome is not added to calendar payloads; the calendar shows date context only).

---

## 11. Sales Meeting integration

### 11.1 Today

`job_card_meeting_details` (`007_sales_meeting.sql`) stores `meeting_at`, `outcome` (incl. `FOLLOW_UP_REQUIRED`), `meeting_summary`, `next_follow_up_at` with constraint `next_follow_up_at > meeting_at`. The Sales Meeting design (`2026-07-15-sales-meeting-design.md`) defines `nextFollowUpAt` as a proposal, not a booking.

### 11.2 Target

- **No auto-creation**: `FOLLOW_UP_REQUIRED` and/or `nextFollowUpAt` never create a JobCard automatically. The decision remains with management (D10).
- The management view of a `COMPLETED` `SALES_MEETING` source with `outcome = FOLLOW_UP_REQUIRED` shows a **recommendation panel**: outcome badge, proposed `nextFollowUpAt`, and the primary action "Takip işi oluştur".
- The follow-up create form pre-fills `scheduledAt = nextFollowUpAt` as a default (still editable; the approved decision may differ).
- `meeting_details` never link to a JobCard and are not copied into the follow-up (D9). The restricted context exposes only the `outcome` enum.

---

## 12. Notification / realtime policy

### 12.1 Notifications (in-app)

Reuse the existing mapping in `server/src/modules/notifications/policy.ts`:

| Situation | Existing kind | Draft text | Recipients |
|---|---|---|---|
| Follow-up created, first assignee | `job.assigned` (via `JOB_CREATED` → `job.assigned` mapping) | standard "size atandı" draft | assignee |
| Follow-up created, then reassigned by management | `job.reassigned` (existing `JOB_ASSIGNED` path) | standard reassignment draft | new assignee |

No new notification kind is added (`021_job_card_note_added_notification_kind.sql` added `JOB_NOTE_ADDED`; follow-up creation intentionally adds nothing). Draft payloads stay `entityType: 'job-card'`, `entityId: <followUpId>` — bodyless, so no source details can leak.

### 12.2 Realtime (SSE/web-push)

Reuse `job.created` (`server/src/modules/realtime/event-mapper.ts`, `JOB_CREATED` entry) with bodyless payload. Additional invalidation resource keys appended for follow-up creation:

- `job-detail:<sourceJobCardId>` — the source detail shows the children panel.
- `customer-detail:<customerId>` — customer history rows change.

Existing keys already cover `job-board`, `job-list`, `overview`, `reports`, `staff-profile:<afterAssigneeId>`. Audience rules (`audience.ts`, `buildJobCardAudience`) stay unchanged: `afterAssigneeId` + `ADMIN`/`MANAGER` roles, org-scoped. No event ever carries source content.

---

## 13. Privacy

1. **Bodyless by construction**: notification and realtime payloads carry ids only; the UI fetches data through permission-checked endpoints. This matches the existing architecture (AGENTS.md §5).
2. **Structured data beats free text**: `follow_up_instructions` is the *only* new free-text field, it is management-only and per-card, and it is the canonical substitute for copying source notes (D9).
3. **Role-filtered lists and counts**: customer history, staff history, children lists, and calendar payloads apply `actorCanReachJob`-equivalent filtering server-side. `childCount` is management-only.
4. **404 discipline**: staff get `404` for full source endpoints (`/api/job-cards/:id/source`) so the existence of a source card is not revealed — consistent with existing `forbidden()`→`404` handling in `handlers.ts`/`policy.ts`.
5. **No activity leakage**: the `JOB_CREATED` activity on the follow-up carries `metadata.sourceJobCardId`, which is safe (it identifies the source by id, reachable via the restricted context). No source content is written into activity metadata.
6. **No source mutation**: creating a follow-up never writes to the source row (no counters, no flags), so history stays append-only.

---

## 14. Non-goals

Not authorized in this design (explicit non-goals for the future implementation):

- Auto-creation of follow-ups from any outcome, field, or notification.
- Creating follow-ups from `CANCELLED`, `IN_PROGRESS`, or `WAITING_APPROVAL` cards.
- Generic link table or multiple link kinds.
- Staff-authored follow-ups.
- Copying any source content (notes, items, summaries, attachments).
- Deleting or editing `source_job_card_id` after creation (immutable link).
- Follow-up-specific delivery-item or approval rules — follow-ups are normal JobCards in lifecycle.
- Customer/contact UI changes beyond role-filtered pagination and link badges.
- Chain depth above 10 or UI for arbitrary chain graphs (breadcrumb only).
- Any new notification kind, realtime event type, or web-push surface.
- Mobile-native, offline, or drag/drop behavior changes.

---

## 15. Resolved decisions (ADR-style summary)

| # | Question | Resolution |
|---|----------|------------|
| R1 | Link storage | `job_cards.source_job_card_id` self-reference (Option A); no link table. |
| R2 | Instructions storage | Dedicated `job_cards.follow_up_instructions`; DB `CHECK` enforces presence for follow-ups. |
| R3 | Source eligibility | `COMPLETED` only; enforced in service + response `409`. |
| R4 | Creation authority | `ADMIN`/`MANAGER` only; `STAFF` → `403`. |
| R5 | Assignee | Any org staff user; no copy of source assignee. |
| R6 | Customer | Must equal source customer (both null allowed); contact must belong to customer. |
| R7 | Multi-source | Not supported; one direct parent per card. |
| R8 | Chains | Supported; depth cap 10; siblings allowed; cycles impossible. |
| R9 | Staff visibility of source | Restricted context DTO; full source only for management or own-past-work. |
| R10 | Proposal → decision | `nextFollowUpAt` pre-fills `scheduledAt`; no auto-create. |
| R11 | Notifications | Reuse `job.assigned` / `job.reassigned`; no new kind. |
| R12 | Realtime | Reuse `job.created`; add `job-detail:<source>` and `customer-detail:<customer>` invalidation keys. |
| R13 | History surfaces | New paginated customer + staff history endpoints; management-only child counts. |
| R14 | Activity | `JOB_CREATED` with `metadata.sourceJobCardId` on the follow-up only. |
| R15 | Rollback path | Only for pre-production reset tasks explicitly approved by the user: `UPDATE job_cards SET source_job_card_id = NULL, follow_up_instructions = NULL WHERE ...` — never in production migrations. |
| R16 | Primary UI entry | Source JobCard detail (management); secondary: customer history rows, `FOLLOW_UP_REQUIRED` recommendation panel. |

---

## 16. Verification expectations (checkpoint gate)

This checkpoint is **documentation-only**. The design and its decisions are considered verified when:

1. Both this design document and the implementation plan exist at the canonical paths and agree on every decision above.
2. The implementation plan cites exact repository facts (files, functions, migration numbers) that match the current tree at `33aa7997a24a335a773017e521002db86ff2bd90`.
3. `git diff --check` passes and the commit contains only the two documentation files.
4. External review (GPT-5.6) confirms the design before implementation starts.
