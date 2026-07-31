# Linked Follow-up JobCards — Design

- **Status:** Ready for external review (product direction approved; binding decisions confirmed; implementation gated on external review and PR #83 approval — revised per first and second external review findings, 2026-07-31)
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
| D6 | **Customer inheritance** | The follow-up inherits the source's customer **server-side**: `source.customerId` is copied by the server, never sent by the client (both may be null). Contacts must belong to that customer (existing rule). |
| D7 | **Staff own-history rule** | A `STAFF` actor may see only JobCards where they are the current assignee. This applies everywhere: board, detail, follow-ups list, customer history, staff profile history, calendar. |
| D8 | **Restricted source context** | A staff assignee who did **not** perform the source card gets a restricted, structured read-only view of the source: type, planned/occurred/completed dates, customer, contact, meeting outcome, and the follow-up instructions. Never note bodies, timeline, delivery details, attachments, other links, or other staff identity. |
| D9 | **No automatic copying** | Follow-up creation never copies notes, delivery items, meeting summaries, or any other content from the source. |
| D10 | **Proposal vs decision** | `nextFollowUpAt` (Sales Meeting) is a **Staff proposal**. The follow-up's `scheduledAt` is the **management-approved decision**. `FOLLOW_UP_REQUIRED` never auto-creates a JobCard. |
| D11 | **Notification reuse** | Follow-up creation reuses the existing `job.assigned` notification path (creation mapping). No new notification kind. |
| D12 | **Realtime reuse** | Follow-up creation reuses the existing `job.created` realtime event. No new event type. Payloads stay bodyless. |
| D13 | **Privacy invariant** | Follow-up linkage must never leak source details through calendar, notification, realtime, or list payloads to staff who cannot reach the source card. |
| D14 | **Canonical entry point** | The primary entry point for creating a follow-up is the **source JobCard detail page** (management view). Secondary entry points: customer history rows and the `FOLLOW_UP_REQUIRED` recommendation panel. |
| D15 | **Instruction immutability** | `follow_up_instructions` is immutable after creation (first version). If new guidance is needed, the manager adds a `GENERAL` operational note or edits the description under existing rules. No PATCH surface for instructions exists. |

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
3. The manager is taken to `/jobs/new-follow-up?source=<sourceId>`. The form is pre-filled from the source: customer shown read-only (inherited **server-side** from the source — the client never sends `customerId`), contact, suggested `scheduledAt`, suggested type. The `follow_up_instructions` field is mandatory and initially empty. If the source has **no customer**, the type selector offers only `GENERAL_TASK` (Repair 2: `PRODUCT_DELIVERY`/`SALES_MEETING` disabled with "Bu takip işi için müşteri bağlantısı bulunmadığından yalnız Genel Görev oluşturulabilir.").
4. The manager picks the assignee (same or different), priority, and completes the instructions.
5. On submit the server creates the follow-up in `NEW` with `source_job_card_id` set, writes a `JOB_CREATED` activity with `metadata.sourceJobCardId`, and emits the existing `job.created` realtime event (invalidation: `job-board`, `job-list`, `overview`, `reports`, `staff-profile:<assignee>`, `job-detail:<sourceId>`, `customer-detail:<customerId>`).
6. The assignee receives the standard `job.assigned` in-app notification. Nothing in the notification reveals source content.

### 4.2 Staff assignee sees only safe context

1. The staff user opens their new follow-up from the board.
2. A compact **"Önceki iş bağlamı"** panel shows: "Bu iş, 12 Tem 2026 tarihinde tamamlanan bir satış ziyaretinin takibidir." plus customer/contact, outcome badge, and the management instructions.
3. The panel contains no note bodies, no timeline, no delivery details, no other staff names, and no `sourceJobPath` (a `RESTRICTED` actor never receives a source link; the response carries `sourceAccess: 'RESTRICTED'` explicitly).
4. If the follow-up assignee can also reach the source card (management, or the same staff user who performed the source), the response carries `sourceAccess: 'FULL'` with `sourceJobPath`, and the panel shows a normal link to the existing source detail route instead.

### 4.3 Manager continues a chain

1. The follow-up completes (staff submits, manager approves).
2. The follow-up's detail now shows "Takip işi oluştur" again — the chain continues.
3. Chain navigation (breadcrumb over all authorized ancestors) is **management-only**. Staff never see ancestors, siblings, or other staff's children — only the immediate direct-source relationship of the follow-up they hold (see §5, §6.4, Repair 6).

### 4.4 Customer history (role-filtered)

1. The customer page lists all job history (open/completed tabs) with pagination.
2. Rows for follow-ups show a **"Takip"** badge. Management rows also show child counts and quick follow-up creation.
3. A `STAFF` viewer sees only their own JobCards for this customer — both rows and counts are filtered server-side; counts never leak other staff members' work.

### 4.5 Staff profile history

1. The staff profile page gains a **"İş geçmişi"** section (paginated).
2. `ADMIN`/`MANAGER` see any staff member's history; a `STAFF` user sees only their own profile.

### 4.6 Calendar

1. A follow-up scheduled for a future date appears in the calendar as a normal event.
2. Management events show a follow-up indicator and a link to the source; staff events show the restricted context (planned/occurred/completed dates with exact labels) inline, never a source link and never instructions (the calendar `followUpContext` carries dates and access mode only — §10.2).

---

## 5. Role visibility

| Actor | Source card (full detail) | Source access mode | Follow-up card | Children list | Create follow-up | Customer history | Staff history | Calendar event |
|---|---|---|---|---|---|---|---|---|
| `ADMIN` | ✅ any org card | `FULL` + `sourceJobPath` | ✅ | ✅ | ✅ any completed | ✅ all + counts | ✅ any staff | ✅ all |
| `MANAGER` | ✅ any org card | `FULL` + `sourceJobPath` | ✅ | ✅ | ✅ any completed | ✅ all + counts | ✅ any staff | ✅ all |
| `STAFF` (assignee of follow-up, performed source) | ✅ (existing detail route, own-history reach) | `FULL` + `sourceJobPath` | ✅ | ✅ (own cards) | ❌ `403` | ✅ own cards only | ✅ self only | ✅ own cards |
| `STAFF` (assignee of follow-up, did not perform source) | ❌ `404` (no path delivered) | `RESTRICTED` (no path) | ✅ | ✅ (own cards) | ❌ `403` | ✅ own cards only | ✅ self only | ✅ own cards + restricted context |
| `STAFF` (not assignee) | ❌ `404` | ❌ `404` (context also `404`) | ❌ `404` | ❌ `404` | ❌ `403` | ✅ own cards only | ✅ self only | ✅ own cards only |

Notes:

- "Own cards" for a staff user means `assigned_to = self` (existing `actorCanReachJob` rule in `server/src/modules/job-cards/policy.ts`).
- **No dedicated full-source endpoint exists.** `FULL` access is served by the existing `GET /api/job-cards/:sourceId` route under the existing `actorCanReachJob` rule; follow-up responses carry the nested `followUpContext` DTO (`sourceAccess` `FULL`/`RESTRICTED`, `sourceJobPath` non-null **iff** `FULL`).
- A follow-up that is `COMPLETED` or `CANCELLED` remains reachable by its assignee (own work history), and the restricted context stays available to that assignee.
- Reassignment of a follow-up transfers reach; the previous assignee loses access (existing reassignment semantics).
- All cross-organization attempts resolve to `404` / `403` exactly like existing routes (no enumeration).

---

## 6. Restricted source context

### 6.1 Why it exists

`actorCanReachJob` intentionally limits staff to their own cards. A follow-up assignee who did not perform the source card still needs **safe, useful history** to do the follow-up. The restricted context is the canonical answer: a deliberately minimal, structured, read-only DTO that never carries private history.

### 6.2 Contract (stable, canonical)

`JobCardDetail` carries a **nullable nested context** so root JobCards never expose an impossible access state:

```typescript
type JobCardFollowUpContext =
  | null
  | {
      sourceJobCardId: string;
      followUpInstructions: string;
      sourceAccess: 'FULL' | 'RESTRICTED';
      sourceJobPath: string | null;
      sourceContext: RestrictedSourceContext | null;
    };

type JobCardDetail = {
  // existing fields
  followUpContext: JobCardFollowUpContext;
};
```

Canonical behavior:

```text
root JobCard:
followUpContext = null

follow-up with FULL source access (management, or source card's current assignee):
sourceAccess = 'FULL'
sourceJobPath = /jobs/<sourceId>
sourceContext may contain the safe summary required by the UI

follow-up with RESTRICTED source access (current follow-up assignee, not otherwise authorized for the source):
sourceAccess = 'RESTRICTED'
sourceJobPath = null
sourceContext contains the restricted source DTO
```

The standalone endpoint `GET /api/job-cards/:id/source-context` remains canonical (it returns `RestrictedSourceContext` including `sourceAccess`/`sourceJobPath`); the detail embeds the same DTO via `followUpContext.sourceContext` so the UI needs no extra fetch. Reach: actor must reach `:id` (the follow-up). Returns `404` when the card is not a follow-up or the source is unreachable/removed.

Canonical source time model (never a single "previous visit date"):

| Field | Derivation |
|---|---|
| `sourcePlannedAt` | `source.scheduled_at` — the planned instant (may be null). |
| `sourceOccurredAt` | `SALES_MEETING` → `job_card_meeting_details.meeting_at`; other types → `started_at`; fallback → `staff_completed_at`. May be null. |
| `sourceCompletedAt` | `source.manager_approved_at` — canonical completion instant (may be null only for impossible rows). |

UI labels are exact: **"Planlanan tarih"**, **"Gerçekleşme tarihi"**, **"Tamamlanma tarihi"**. A single field must never be presented as "önceki ziyaret tarihi".

```jsonc
{
  "jobCardId": "uuid",                    // the follow-up
  "isFollowUp": true,
  "sourceAccess": "FULL | RESTRICTED",    // derived per §5
  "sourceJobPath": "/jobs/<sourceId> | null",  // non-null IFF sourceAccess === 'FULL'
  "source": {
    "sourceJobCardId": "uuid",
    "sourceType": "SALES_MEETING",
    "sourcePlannedAt": "2026-07-12T08:00:00.000Z",   // source.scheduled_at (planlanan tarih), may be null
    "sourceOccurredAt": "2026-07-12T09:15:00.000Z",  // meeting_at | started_at | staff_completed_at (gerçekleşme tarihi), may be null
    "sourceCompletedAt": "2026-07-31T09:34:50.000Z", // source.manager_approved_at (tamamlanma tarihi)
    "customer": { "id": "uuid", "name": "..." },     // null only when source had no customer
    "contact": { "id": "uuid", "name": "..." },      // null when source had no contact
    "outcome": "FOLLOW_UP_REQUIRED"                  // SALES_MEETING sources only; else null
  },
  "followUpInstructions": "management-provided instructions",
  "followUpCreatedAt": "2026-07-31T10:00:00.000Z"
}
```

`FULL` access does not need this endpoint's source fields for navigation: the client uses `sourceJobPath` with the **existing** `GET /api/job-cards/:sourceId` route (subject to the existing `actorCanReachJob` rule). No dedicated full-source endpoint exists.

### 6.3 Explicit exclusions

The restricted context **never** contains: note bodies, timeline/activity events, approval reasons, revision reasons, delivery items, attachments, engagement history, other follow-ups (siblings), chain navigation, `assignedTo`/`createdBy` identity, or any free-text beyond `follow_up_instructions`.

### 6.4 Access lifecycle

- Access mode is derived from **current** `assigned_to` and role: `FULL` for `ADMIN`/`MANAGER` and for the source card's current assignee; `RESTRICTED` otherwise. Reassignment of the follow-up re-derives the mode; reassignment of the source card itself changes who qualifies for `FULL`.
- If the source link is removed (planned rollback path only, see §15), the context returns `404`.
- The context is always served from the persisted source row + `job_card_meeting_details`; it is never cached client-side beyond normal HTTP caching rules.

### 6.5 Access lifetime (exact policy)

```text
Management:                                    FULL source access
Staff authorized by the existing source rule
  (source card's current assignee):            FULL source access
Current follow-up assignee, not otherwise
  authorized for the source:                   RESTRICTED direct-source context
Former follow-up assignee (after reassignment): no restricted access; loses access
  to the follow-up itself unless existing own-history rules preserve it
Unrelated Staff:                               no source knowledge (404)
Inactive user:                                 no access (cannot authenticate)
```

Follow-up lifecycle states (mode refers to the follow-up's own source context):

```text
NEW:           current assignee receives FULL or RESTRICTED per source authorization
ACCEPTED:      same
IN_PROGRESS:   same
COMPLETED:     current/final assignee retains RESTRICTED direct-source context
               for their own completed work history (FULL if they also hold the source)
CANCELLED:     the assigned Staff may continue to see their own cancelled follow-up
               JobCard; restricted source context is retained only when required to
               explain that historical assigned task; no new source permissions
               are granted
```

After reassignment:

```text
old assignee:  loses access to the active follow-up (and therefore its source
               context) unless existing own-history rules independently preserve it
               (e.g., the source card is their own past work)
new assignee:  receives the appropriate FULL/RESTRICTED source context immediately
```

All modes are derived per request from current persisted state — no stored grants, no access-duration concepts.

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

The "iff" contract is enforced in **both** directions: a root JobCard never carries instructions, and a follow-up always does.

```sql
-- self-link impossible
CHECK (source_job_card_id IS DISTINCT FROM id)
-- present-iff contract (both directions)
CHECK (
  (source_job_card_id IS NULL AND follow_up_instructions IS NULL)
  OR
  (source_job_card_id IS NOT NULL AND follow_up_instructions IS NOT NULL)
)
-- length/whitespace stays a separate constraint
CHECK (
  follow_up_instructions IS NULL
  OR (
    char_length(follow_up_instructions) BETWEEN 1 AND 4000
    AND follow_up_instructions ~ '[^[:space:]]'
  )
)
-- same organization
FOREIGN KEY (organization_id, source_job_card_id)
  REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT
```

The migration contract tests must prove all four cases: `root + instructions → rejected`, `follow-up + null instructions → rejected`, `root + null instructions → accepted`, `follow-up + valid instructions → accepted`.

### 7.3 Source mutability

The source card never changes when a follow-up is created. No `has_follow_up` flag, no counters on the source row — derived state only (`EXISTS` / child count), because derived state cannot drift (AGENTS.md §2.1).

### 7.4 Chain depth

Precise depth model:

```text
root depth = 0
first follow-up depth = 1
maximum persisted follow-up depth = 10
source at depth 10 → child creation attempt (new card would be depth 11) → 409
```

Service-level ancestor walk capped at **10** (`FOLLOW_UP_MAX_DEPTH_REACHED` → `409`). Cycles are impossible at creation (a new card is always a leaf; `source_job_card_id` is immutable), and the walk is defensive. Cross-row constraints (depth, completed-source eligibility, same-customer consistency) are enforced in the **service**, not claimed for PostgreSQL alone — no trigger is planned.

---

## 8. Customer history

### 8.1 Today

`GET /api/customers/:customerId` (`server/src/modules/crm/repository.ts` `getCustomerDetail`) embeds two fixed slices: `openJobs` and `completedJobs` (first 5 each), with a `staffScope` predicate (`AND assigned_to = $self` for staff). No pagination, no link metadata, and the embedded arrays cannot express role-filtered counts.

### 8.2 Target

- Add `openJobCount` and `completedJobCount` to `CustomerDetail` (role-filtered counts, same `staffScope`). Counts are computed as the `total` of status-filtered `listCustomerJobHistory` calls (open / completed) — **no separate count method exists** in the read port (see plan §5).
- Replace the embedded arrays with a new paginated endpoint `GET /api/customers/:customerId/jobs?status=open|completed|all&limit&offset` returning `PaginatedJobHistory` (`{ items, total, limit, offset }`, crm-consistent pagination — see plan §5).
- The history endpoint and the count fields exist **only when the `JobHistoryReadPort` is wired**; existing CRM endpoints stay available without it (conditional route registration, plan §5).
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

`GET /api/staff/me` and `GET /api/staff/:userId` return counters (`open`, `waitingApproval`, `revisionRequested`, `completedThisMonth`, `overdue`) via `StaffOperationalSummaryPort` in `server/src/modules/people/`. There is no job history list.

### 9.2 Target

The history endpoints are backed by a dedicated **`JobHistoryReadPort`** (`listCustomerJobHistory` / `listStaffJobHistory` returning `PaginatedJobHistory = { items, total, limit, offset }`); counters on `StaffOperationalSummaryPort` remain untouched. The port is optional in `AppDependencies` — history routes register only when it is wired (plan §5).

Canonical routes (consistent with the existing `/api/staff`, `/api/staff/me`, `/api/staff/:userId` convention):

- `GET /api/staff/me/jobs?status=open|completed|all&limit&offset` → own history (STAFF self; management may use it too).
- `GET /api/staff/:userId/jobs?status=open|completed|all&limit&offset` → any org staff history; `ADMIN`/`MANAGER` only (`requireAdminOrManager`); `STAFF` on another user's id resolves to `404` (existing own-profile pattern).

Item shape mirrors `CustomerJobHistoryItem` (including `followUp` link metadata and management-only `childCount`).

### 9.3 Web surface

`StaffProfiles.tsx` gains a paginated "İş geçmişi" section (own profile and management view), using the same visual language as the customer history list. This also directly serves AGENTS.md §3.6 (staff profile shows open/waiting/revision/completed jobs and delivery history).

---

## 10. Calendar behavior

### 10.1 Today

`GET /api/calendar/events` (`server/src/modules/calendar/repository.ts`, `CALENDAR_LIST_SQL` joins `job_cards`, `customers`, `users`) returns `JobCalendarEvent` with `relatedJobPath` and `jobCardId`. Reachability: staff see only their own `assigned_to`; management see org-wide.

### 10.2 Target

- `CALENDAR_LIST_SQL` gains a `LEFT JOIN` to the follow-up source (`job_cards src` on `src.organization_id = j.organization_id AND src.id = j.source_job_card_id`) and, for `sourceOccurredAt`, a `LEFT JOIN` to `job_card_meeting_details md` on the source card; selecting `j.source_job_card_id`, `j.follow_up_instructions`, `src.scheduled_at`, `src.started_at`, `src.staff_completed_at`, `src.manager_approved_at`, `md.meeting_at`.
- `JobCalendarEvent` gains an additive, nullable `followUpContext` using **exactly the same source-access decision as `JobCardDetail`** (§6.2, Repair 1):

```typescript
followUpContext:
  | null
  | {
      sourceAccess: 'FULL' | 'RESTRICTED';
      sourceJobPath: string | null;
      sourcePlannedAt: string | null;
      sourceOccurredAt: string | null;
      sourceCompletedAt: string | null;
    };
```

```text
ADMIN/MANAGER:                    FULL → sourceJobPath = /jobs/<sourceId> + dates
STAFF authorized for the source
  (source card's current assignee): FULL → sourceJobPath + dates
Follow-up owner not authorized
  for the source:                 RESTRICTED → sourceJobPath = null, dates only
Unrelated STAFF:                  null (no source knowledge; the event itself is
                                  visible only per the existing calendar reach rule)
```

- `followUpContext` is strictly additive calendar metadata: it contains no note bodies, no activity, no chain, and no other follow-up ids.
- No schema change, no new calendar entry type: the follow-up is a normal scheduled JobCard event.

### 10.3 Guardrails

- The restricted context rule applies: calendar payloads never carry instructions or source free-text.
- Date fields come from the source row/`job_card_meeting_details` only, with exact labels ("Planlanan tarih", "Gerçekleşme tarihi", "Tamamlanma tarihi") — no notes, no outcome in calendar payloads; the calendar shows date context only.
- `sourceJobPath` presence must match the detail view exactly (`FULL` yes, `RESTRICTED` no) — the two endpoints cannot disagree about access.

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
4. **No source-path leakage**: a `RESTRICTED` actor never receives `sourceJobPath` in any payload (follow-up detail, source-context, calendar, history lists). A `STAFF` actor who cannot reach the source card gets `404` from the existing source detail route — consistent with existing `forbidden()`→`404` handling in `handlers.ts`/`policy.ts`.
5. **No activity leakage**: the `JOB_CREATED` activity on the follow-up carries `sourceJobCardId` in **one canonical place only**: `metadata` (`metadata.sourceJobCardId`). It is not duplicated into `new_value`. No source content is written into activity metadata.
6. **No source mutation**: creating a follow-up never writes to the source row (no counters, no flags), so history stays append-only.
7. **Log privacy**: `follow_up_instructions` is added to the logger redaction paths (`LOGGER_REDACT_PATHS` in `server/src/app.ts`: `req.body.followUpInstructions`), and a log-capture test proves a unique instruction marker never appears in request/error logs.

---

## 14. Non-goals

Not authorized in this design (explicit non-goals for the future implementation):

- Auto-creation of follow-ups from any outcome, field, or notification.
- Creating follow-ups from `CANCELLED`, `IN_PROGRESS`, or `WAITING_APPROVAL` cards.
- Generic link table or multiple link kinds.
- Staff-authored follow-ups.
- Copying any source content (notes, items, summaries, attachments).
- Deleting or editing `source_job_card_id` after creation (immutable link).
- Editing `follow_up_instructions` after creation (immutable; guidance changes go through `GENERAL` operational notes or description edits under existing rules).
- Follow-up-specific delivery-item or approval rules — follow-ups are normal JobCards in lifecycle.
- Customer/contact UI changes beyond role-filtered pagination and link badges.
- Chain depth above 10 or UI for arbitrary chain graphs (management-only breadcrumb; staff see only the immediate direct-source relationship).
- `scheduledEndsAt` in the follow-up **create** request — creation accepts `scheduledAt` only; end time stays owned by the existing scheduling/update flow (Repair 4).
- Any new notification kind, realtime event type, or web-push surface.
- Mobile-native, offline, or drag/drop behavior changes.

---

## 15. Resolved decisions (ADR-style summary)

| # | Question | Resolution |
|---|----------|------------|
| R1 | Link storage | `job_cards.source_job_card_id` self-reference (Option A); no link table. |
| R2 | Instructions storage | Dedicated `job_cards.follow_up_instructions`; DB "iff" CHECK enforces both directions (root → NULL; follow-up → NOT NULL), length/whitespace in a separate CHECK. |
| R3 | Source eligibility | `COMPLETED` only; enforced in service + response `409`. |
| R4 | Creation authority | `ADMIN`/`MANAGER` only; `STAFF` → `403`. |
| R5 | Assignee | Any org staff user; no copy of source assignee. |
| R6 | Customer | Inherited server-side from the source (`source.customerId` copied by the server; client never sends `customerId`; both null allowed); contact must belong to the inherited customer. Customer-null × type matrix: source with customer → `GENERAL_TASK`/`PRODUCT_DELIVERY`/`SALES_MEETING` allowed; customerless source → `GENERAL_TASK` only, other types → `409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED` (Repair 2). |
| R7 | Multi-source | Not supported; one direct parent per card. |
| R8 | Chains | Supported; depth model root=0, max persisted depth=10 (source at 10 rejects depth-11 child, `409 FOLLOW_UP_MAX_DEPTH_REACHED`); siblings allowed; cycles impossible. |
| R9 | Staff visibility of source | No dedicated full-source endpoint. `JobCardDetail` carries nullable `followUpContext` (`null` for roots; `{sourceJobCardId, followUpInstructions, sourceAccess: 'FULL' \| 'RESTRICTED', sourceJobPath, sourceContext}` otherwise, Repair 1). `FULL` = management or the source card's current assignee, served by the existing `GET /api/job-cards/:sourceId` under `actorCanReachJob`; otherwise `RESTRICTED` via the source-context DTO. |
| R10 | Proposal → decision | `nextFollowUpAt` pre-fills `scheduledAt`; no auto-create. |
| R11 | Notifications | Reuse `job.assigned` / `job.reassigned`; no new kind. |
| R12 | Realtime | Reuse `job.created`; add `job-detail:<source>` and `customer-detail:<customer>` invalidation keys. |
| R13 | History surfaces | New paginated role-filtered endpoints `GET /api/customers/:customerId/jobs`, `GET /api/staff/me/jobs`, `GET /api/staff/:userId/jobs`; management-only child counts; read via a shared `JobHistoryReadPort` (`listCustomerJobHistory`/`listStaffJobHistory` → `PaginatedJobHistory { items, total, limit, offset }`); routes register only when the optional port is wired (see plan §5). |
| R21 | Detail DTO | `followUpContext` is nullable and nested in `JobCardDetail` (null for roots, Repair 1); the standalone source-context endpoint stays canonical; presenter/API schema/web parser/replay behave identically. |
| R22 | Create contract | No `customerId` in the create request (server inherits from source); no `scheduledEndsAt` in the create request (Repair 4); `clientActionId` required. |
| R23 | Chain visibility | Staff see only the immediate direct source (FULL link or RESTRICTED panel); no ancestor breadcrumb, no siblings, no other-staff children, no hidden chain length; management keeps full chain navigation (Repair 6). |
| R24 | Access lifetime | Derive mode per request from current role + `assigned_to`: FULL (management/source assignee), RESTRICTED (follow-up assignee not authorized for source), none (former assignee after reassignment, unrelated staff, inactive users); COMPLETED keeps restricted context for own history; CANCELLED keeps only what explains the historical assigned task (Repair-access). |
| R25 | Follow-up PATCH | Management may not change the inherited `customerId` on a follow-up via the generic PATCH (would break the same-customer chain rule); the source remains the single owner of customer/contact. |
| R14 | Activity | `JOB_CREATED` with `sourceJobCardId` in `metadata` only (single canonical field; not duplicated into `new_value`), on the follow-up only. |
| R15 | Rollback path | Only for pre-production reset tasks explicitly approved by the user: `UPDATE job_cards SET source_job_card_id = NULL, follow_up_instructions = NULL WHERE ...` — never in production migrations. |
| R16 | Primary UI entry | Source JobCard detail (management); secondary: customer history rows, `FOLLOW_UP_REQUIRED` recommendation panel. |
| R17 | Source time model | `sourcePlannedAt` = `scheduled_at`; `sourceOccurredAt` = `SALES_MEETING → meeting_at`, else `started_at`, fallback `staff_completed_at`; `sourceCompletedAt` = `manager_approved_at`. UI labels: "Planlanan tarih" / "Gerçekleşme tarihi" / "Tamamlanma tarihi". |
| R18 | Instruction mutability | Immutable after creation (first version); no PATCH surface; changes via `GENERAL` operational note or description under existing rules. |
| R19 | Engagement kind | `engagementKind` uses the real `JobCardEngagementKind` enum (`SALES_MEETING`, `CUSTOMER_VISIT`, `PRODUCT_DEMO`, `TRAINING`, `FOLLOW_UP`, `OTHER`); required for `SALES_MEETING`, null otherwise; create form pre-fills the source's engagement kind (or `FOLLOW_UP`). |
| R20 | Log privacy | `LOGGER_REDACT_PATHS` in `server/src/app.ts` gains `req.body.followUpInstructions`; log-capture test required. |

---

## 16. Verification expectations (checkpoint gate)

This checkpoint is **documentation-only**. The design and its decisions are considered verified when:

1. Both this design document and the implementation plan exist at the canonical paths and agree on every decision above.
2. The implementation plan cites exact repository facts (files, functions, migration numbers) that match the current tree at `33aa7997a24a335a773017e521002db86ff2bd90`.
3. `git diff --check` passes and the commit contains only the two documentation files.
4. External review (GPT-5.6) confirms the design before implementation starts.
5. All external-review blockers are resolved in the documentation (this revision resolves blockers 1–9 and the consistency findings of the 2026-07-31 review).
