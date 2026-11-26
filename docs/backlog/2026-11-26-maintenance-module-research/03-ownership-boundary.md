# 03 — Maintenance (Bakım) ownership boundary and integration points

> **Supersession (2026-11-26 owner review):** [07 — Owner-approved product direction](07-owner-approved-product-direction.md) governs the proposed product scope and disabled-state contract. This note preserves historical research at 89bf6b1. Use MOD-003 (#520 merged), `legacyEnvKey: null`, `FRESH_INSTALL`, migration 075; no new registry key migration. #513 is merged but does not make all dispatch exhaustive. Add a service-case layer (asset → case → visits/JobCards); disabled standalone management is denied, scoped active-visit completion writes and authorized historical evidence reads remain available. See 07 §§2–4 for the precise boundary; the proposed generic API and site model below are not accepted implementation details.

Research note. **Nothing here is implemented or approved.** All code claims are
against `origin/main` @ `89bf6b1` unless another ref is named. Everything marked
**inference** or **recommendation** is mine, not policy.

## Summary (10 lines)

1. The owner's hypothesis holds with one qualification: **assignment, lifecycle,
   approval, audit and authorization stay in core JobCard** (MOD-001 §1), and the
   **device service history lives in the Maintenance module**. The qualification:
   the *type-specific payload of one visit* (checklist answers, measurements,
   frozen report) must also live in Maintenance, keyed by `job_card_id` — exactly
   the shape `weekly_reports` already uses (`051_weekly_report_foundation.sql:25-45`).
2. Recommended integration: **a new `MAINTENANCE` JobCard type** whose per-visit
   data lives in a Maintenance-owned 1:1 table. Reusing `GENERAL_TASK` looks
   cheaper but silently drops occupancy, early-start, real submission readiness
   and report separation (see §3).
3. Adding a type is now *compile-checked* by PR #513 (`assertNeverJobCardValue`,
   `submission-policy.ts` unhandled-type throw), so the V11 silent-inheritance risk
   is closed by the same change that adds the type.
4. Occupancy does **not** come free: the core occupancy SQL lists only
   `SALES_MEETING`/`PRODUCT_DELIVERY` (`job-cards/occupancy.ts:70`). A maintenance
   visit must be added there plus `isPlannedIntervalJobType`
   (`job-card-duration.ts:42-44`) and `CANONICAL_JOB_DURATION_MS` (`:5-8`).
5. Customers/CRM has **no site or address entity** — one free-text `address` per
   customer (`002_delivery_tracer.sql:9-17`, `crm/types.ts:12-28`). A device-at-site
   concept therefore needs its own Maintenance-owned row, not a CRM reuse.
6. Warehouse owns stock movements (MOD-001 §2). Maintenance records the *parts
   used fact*; the stock effect is a separate, port-mediated projection that must
   work with Warehouse disabled, enabled, and externally-authoritative.
7. Under MOD-002 a disable must keep data, FK, audit and history intact, stop new
   creation, and **not** weaken a core rule — SCH-001 is the precedent for what
   happens when a module flag is allowed to change a core invariant.
8. Three integration points are *not* free and are easy to miss:
   `realtime_events` "exactly one source" CHECK (`017_calendar.sql:234-239`),
   `audit_events` subject/event-type CHECKs (`060_...:94-99`, `061_...:52-74`),
   and the hand-maintained restore relation list (`backup/restore/postgres.ts:11-25`).
9. Photos/attachments have **no owner and no infrastructure** in this repo today;
   that is a new subsystem, not a field on a form (§2, row "photos/attachments").
10. Nine decisions are needed before implementation; they are listed in
    "Open questions for the owner".

---

## 1. Method, scope and evidence rules

Read for this note:

| Source | Used for |
| --- | --- |
| `DECISIONS.md` MOD-001 (1991), MOD-002 (3735), SCH-001 (3671), UI-002 (102), JOB-007 (2992), DOM-001 (337), DOM-004 (534), SALE-001 (1966) | binding boundary rules |
| `docs/features/operator-module-pilot.md` | module state contract, fail-closed, restore |
| `server/src/modules/installation-modules/{registry,state,takeover}.ts` | registry/state mechanics |
| `server/src/modules/job-cards/{types,policy,submission-policy,occupancy,job-card-duration,create-input,follow-up-policy,assignment-offer-policy,routes}.ts` | what a new type touches |
| `server/src/modules/people/offboarding.ts` | staff-leave integration |
| `server/src/modules/crm/{types,repository,service}.ts` | customer/site/contact truth |
| `server/src/modules/products/types.ts` | spare-part reference shape |
| `server/src/modules/backup/restore/{postgres,operator-reset}.ts` | restore contract |
| `server/src/db/migrations/002,007,017,051,057,060,061,074` | schema constraints |
| `docs/backlog/2026-11-25-core-modules-architecture-research.md` §3b, §4, §5, §5a | V5/V11, disable semantics, occupancy contribution |
| `origin/refactor/job-card-exhaustive-dispatch` (PR #513, OPEN) | compile-time exhaustiveness |
| `origin/refactor/weekly-report-submission` (OPEN) | module-owns-its-submission precedent |

Not read in depth (out of scope for this note): `DESIGN.md`, `PRODUCT.md`,
`PRODUCT_REQUIREMENTS.md` lifecycle diagram is used only for the status set. No
UI implementation is proposed here, so UI-001/UI-003 review gates do not apply.

Evidence levels used: **observed** = read in the files above; **inference** =
my reasoning from observed code; **recommendation** = my proposal, needs owner
approval; **UNVERIFIED** = not checked.

**Relationship to the sibling notes in this folder.** `01-jobcard-type-impact.md`
(dispatch-point inventory), `02-scope-options.md` (scope cuts),
`04-regulation-and-industry.md` (regulatory record requirements) and
`06-cross-module-and-web-impact.md` (cross-module/web hit table) are written in
parallel by other sessions. This note is the ownership/boundary view and
deliberately does not restate their inventories. Where they overlap, note that
`06` §5.1 independently reaches the same hypothesis test result as §3.4 here
(visit stays in JobCard; device/service history in the module). One refinement to
`06` §5.2: a maintenance report should **not** be a second aggregate over
`job_cards`; either extend the existing buckets or add a Maintenance-owned route
that reads its own tables — see §2 row 21 and §8.

---

## 2. Q1 — Ownership table

"Owner" answers *who may write the authoritative value*. Reads are always
organization-scoped; a foreign module reads through a port or a scoped query, never
through a shared mutable column (MOD-001 §1, `SERVORA_MED_SCHEMA_DRAFT.md:467-508`).

| # | Concept | Owner | Why | Binding rule |
| --- | --- | --- | --- | --- |
| 1 | Device / installed-base record (identity of one physical unit at a customer) | **Maintenance** | It is a service-lifecycle object: install date, warranty window, service history. It is not a job, not a stock balance, and not a catalog row. | Inference from MOD-001 §2 (Warehouse owns *stock* serial identity, not installed assets) + DOM-004 (catalog is informational). New decision needed. |
| 2 | Device-at-site location | **Maintenance** (site row), address master later **Customers** | CRM has no site entity today; only `customers.address` free text (`002_delivery_tracer.sql:13-15`, `crm/types.ts:20-22`). A hospital with three buildings cannot be modelled. The *service location* is Maintenance's; a future CRM address book would become the master. | Observed gap + recommendation. See §4. |
| 3 | Maintenance plan (interval, template, owner, active flag) | **Maintenance** | Pure domain data of the module; no job identity involved. | MOD-001 §2 analogue; UI-002 forbids a generic settings bag, so it must be typed columns. |
| 4 | Plan schedule / next due date | **Maintenance** | It is *plan* state, not staff occupancy. SCH-001 §1 keeps *job* planning core; a plan's `next_due` is not a booking. | SCH-001 §1 (core = job intervals + occupancy) — inference: plan dates stay in the module. |
| 5 | Service visit job (identity, title, customer, assignee, planned interval) | **Core JobCard** | "Core/JobCard owns job identity, staff assignment, lifecycle, manager approval, operational records, audit and authorization." | MOD-001 §1 (`DECISIONS.md:2016-2021`) |
| 6 | Assignment (offer, accept, decline, release, reassign) | **Core JobCard** | Same. Also the acceptance window is a job policy, not a module policy. | MOD-001 §1; JOB-010; `policy.ts:86-151` |
| 7 | Lifecycle (NEW→…→COMPLETED, invalidate) | **Core JobCard** | Same. `INVALIDATED` exists as an ADMIN-only historical command. | MOD-001 §1; `policy.ts:21-23,42-44,86-151`; `types.ts:11-25` |
| 8 | Manager approval / revision | **Core JobCard** | Same; a module-specific approval would fork the workflow. | MOD-001 §1; `policy.ts:404-406` |
| 9 | Checklist template (versioned question set) | **Maintenance** | Content of the service discipline, not a workflow rule. | Inference + UI-002 (typed, not JSON bag if avoidable). |
| 10 | Checklist answers for one visit | **Maintenance**, frozen at submission | Same shape as weekly-report submission freeze: the submitted copy is immutable history. | Precedent `weekly-reports/submission.ts` (branch) + `051_...:25-45`; core only asks "is it complete" via a contribution. |
| 11 | Measurements (readings with unit) | **Maintenance** | Device telemetry captured by staff; not a job field. | Inference. |
| 12 | Photos / attachments | **nobody today** — needs a new decision | No upload path, no object storage for domain files, no virus/access model. `grep -rn "multipart\|attachment\|upload" server/src` returns only backup/R2 and the PDF filename helper. | Observed absence. Blocking for any "photo evidence" requirement. |
| 13 | Signature (customer sign-off) | **Maintenance** (captured fact) | It is evidence attached to the visit report, not a lifecycle transition. Legal weight is a regulation question (note 04). | Inference; owner decision needed. |
| 14 | Service report PDF | **Maintenance**, frozen at approval | Same pattern as the weekly-report PDF: server-rendered from a frozen snapshot, `pdfmake` already a dependency (`server/package.json:43`, `weekly-reports/pdf/renderer.ts:1-40`). | Inference; no new dependency required. |
| 15 | Warranty (start/end, terms text) | **Maintenance** | Dates + terms on the device. Explicitly **not** Accounting: DOM-001 forbids financial tracking, and MOD-001 §3 limits Accounting to commercial documents. | DOM-001 (`DECISIONS.md:337-358`); MOD-001 §3 |
| 16 | Spare part used (product reference + quantity + serial/lot text) | **Maintenance** records the fact; product identity is a **snapshot** | Mirrors `job_card_delivery_items` snapshots (`002_delivery_tracer.sql:147-152`): a later product rename/deactivation must not rewrite history. | DOM-004 ("deactivation blocks future selection but does not rewrite historical delivery snapshots", `DECISIONS.md:554-557`) |
| 17 | Stock decrement / balance / reservation | **Warehouse only** | "A future Warehouse module will own … physical quantities, reservations …, stock in/out movements … lot/serial/expiry". | MOD-001 §2 (`DECISIONS.md:2022-2031`) |
| 18 | Audit (who changed what, durable) | **Core `audit_events`** for job lifecycle; **Maintenance** appends its own rows to the same table | `audit_events` is the single audit table with `subject_type`/`event_type` CHECKs; CRM and Products already append there (`crm/types.ts:170-176`, `products/types.ts:78-82`). | `060_crm_duplicate_review_decisions.sql:94-99` (`subject_type`), `061_weekly_report_removal.sql:52-74` (`event_type`) — both need new values |
| 19 | Activity log (per-visit timeline) | **Core `job_card_activity_logs`** | The visit timeline is the JobCard timeline; a second timeline would fork history. Plan/device-level mutations need their own log (precedent: `calendar_event_activity_logs`, `017_calendar.sql:90-106`). | Observed precedent. |
| 20 | Notifications | **notifications module** (core infrastructure) | Notification rows derive from `realtime_events`; the module supplies the event. Existing notifications are not module-gated (no capability check in `notifications/service.ts`). | `notifications/types.ts:6-43`; `017_calendar.sql:219-239` |
| 21 | Reports | **reports module** for cross-module operational counts; **Maintenance** for device/plan-specific reports | Reports is already the single read model over `job_cards` (`reports/repository.ts:344,2494-2521`). A second aggregate over the same table is an SSOT break. | `reports/ports.ts`; DOM-006 (operational only, no revenue) |

**Ancillary concepts that must be decided but have no natural owner yet:**

| Concept | Note |
| --- | --- |
| Technician competence / authorization per device family | Regulation-driven (note 04). If required, it is a Maintenance-owned reference table, not a role. It must not extend `users.role` (MOD-002 §1 precedent: a fourth role breaks `role !== 'STAFF'` checks). |
| Visit outcome / "device healthy" verdict | Belongs to the visit (Maintenance), not to the JobCard status. Approval is core; the *verdict* is domain data. |
| Calibration certificate | Either an attachment (blocked, row 12) or a structured record (Maintenance). Needs the regulation note. |

---

## 3. Q2 — Two integration designs for "a maintenance visit is a JobCard"

### 3.1 Design (a) — new `MAINTENANCE` JobCard type + module-owned detail table

Shape:

```
job_cards (type = 'MAINTENANCE')            -- core: identity, assignee, lifecycle, approval
  └─ maintenance_visits (1:1, organization_id + job_card_id UNIQUE)
       device_id, plan_id, checklist_template_version,
       measurements[], parts_used[], signed_by, signed_at, report_snapshot...
```

The 1:1 keying is not invented: `weekly_reports` is exactly this
(`UNIQUE (organization_id, job_card_id)`, `051_weekly_report_foundation.sql:43-45`),
and `job_card_meeting_details` is the core-side version
(`007_sales_meeting.sql:17-27`).

Cost (all observed, all compile-time or one-line):

| Site | Effect |
| --- | --- |
| `job_cards_type_check` | new migration recreating the CHECK (current list at `057_sale_from_visit.sql:5-8`) |
| `submission-policy.ts:388-390` | **build fails** until a maintenance submission contribution exists (PR #513) |
| `policy.ts:144-146` + `assertNeverJobCardValue` | **build fails** until the status dispatch is total (PR #513) |
| `follow-up-policy.ts:86-96` | **build fails** (`Record<JobCardType, JobCardType>`) |
| `job-card-duration.ts:5-8`, `:42-44` | must add duration + planned-interval membership |
| `occupancy.ts:70-72` | must add the type or the visit never conflicts |
| `reports/repository.ts:344` | one entry in `PRODUCTIVE_WORK_TYPES`, or an explicit exclusion |
| `web/src/jobs/job-labels.ts:17-23` | **build fails** |
| `web/src/jobs/job-workflow-presentation.ts:706-717` | **build fails** (no default branch) |
| `web/src/jobs/follow-up-presentation.ts:37-45` | **build fails** |
| `create-input.ts:36-40,50-61` | the generic `POST /` must still reject the type; creation goes through a dedicated route (precedent: `/product-deliveries`, `/sales`, `/weekly-reports` at `routes.ts:20-25`) |

Advantages: the type is visible to the board (status-driven, `repository.ts:5947-5990`),
to `/available-slots`, to conflict checks, to reports, and to the approval queue
with zero extra plumbing. One vocabulary member, no "is this really maintenance?"
join.

Disadvantage: a `MAINTENANCE` value exists in every deployment, including those
where the module is off. This is already the accepted norm — `WEEKLY_REPORT` and
`SALE` exist with no public creation route until their slice opens.

### 3.2 Design (b) — reuse an existing type + `maintenance_visits` link table

Two sub-variants:

| Reused type | What breaks |
| --- | --- |
| `GENERAL_TASK` | Not a planned-interval type (`job-card-duration.ts:42-44`), excluded from occupancy SQL (`occupancy.ts:70`), so **no conflict detection and no slot search**; submission readiness is title-only (`submission-policy.ts:371-383`), so a visit submits with an empty checklist unless core is modified anyway; reports count it indistinguishably from tasks; no early-start tolerance (`policy.ts:54-56`); the UI shows "Genel görev". |
| `SALES_MEETING` | Drags meeting semantics: structured result required, and `CUSTOMER_VISIT`/`FOLLOW_UP` engagement kinds trigger **mandatory follow-up proposals** (`follow-up-policy.ts:104-119`). A service visit would have to fabricate meeting data or opt out of core rules, which is exactly V11 in reverse. |
| `SALE` / `WEEKLY_REPORT` | Not a fit at all (financial agreement / staff report). |

The decisive point: design (b) claims "no core change" but **cannot deliver
occupancy without changing `occupancy.ts`**. Adding `GENERAL_TASK` to the
occupancy type list would change behaviour for every existing general task — a far
wider blast radius than adding one type. And it forces every reader to join the
link table or silently mis-classify the row (the V11 failure mode moved from
compile time to runtime).

### 3.3 Comparison against the constraints named in the task

| Constraint | (a) new type | (b) reuse + link |
| --- | --- | --- |
| V11 / PR #513 exhaustiveness | **Closed by the compiler** | Not closed; the type still has no branch and the module must patch dispatch anyway |
| SCH-001 occupancy | One line in the shared reader; single definition preserved | Requires touching the shared reader for an existing type |
| JOB-007 occupied-end semantics | Free (same SQL expression) | Free only if the type is in the list |
| Submission readiness | Explicit contribution per type | Core must consult a Maintenance reader from `evaluateSubmission` |
| Approval | Unchanged core path | Unchanged, but the reviewer sees the wrong type |
| Reports | Separable bucket | Merged into `GENERAL_TASK` |
| Board / filters / labels | First-class | Generic |
| Disable story | Type exists, no create route → same as `WEEKLY_REPORT` today | Visit rows still look like tasks; the module link is invisible when hidden |

### 3.4 Recommendation

**Design (a)**, with these specifics:

1. New `MAINTENANCE` type in `JOB_CARD_TYPES` (`types.ts:29`) + migration for
   `job_cards_type_check`.
2. Per-visit data in **Maintenance-owned** `maintenance_visits` keyed
   `UNIQUE (organization_id, job_card_id)`, FK
   `(organization_id, job_card_id) → job_cards(organization_id, id) ON DELETE RESTRICT`.
   RESTRICT, not CASCADE: there is no JobCard delete path at all
   (`routes.ts` has `invalidate`, no `DELETE`), and destructive cascades would
   violate the append-only history rule (AGENTS.md §6, DOM-005).
3. Submission readiness by **contribution**: the module exports
   `evaluateMaintenanceSubmission(...)`; `submission-policy.ts` calls it in the
   new `MAINTENANCE` branch. Precedent: `weekly-reports/submission.ts` on
   `origin/refactor/weekly-report-submission`.
4. Add the type to `occupancy.ts`, `isPlannedIntervalJobType`,
   `CANONICAL_JOB_DURATION_MS`, and (once) to `PRODUCTIVE_WORK_TYPES`.
5. Do **not** add the type to `isAssignmentOfferJobType`
   (`assignment-offer-policy.ts:35-37`) in the first slice. A maintenance visit
   is a confirmed appointment; the acceptance window is an optional later
   decision (open question Q-A).
6. Do **not** grant maintenance visits `acceptsEarlyStart`
   (`policy.ts:54-56`) in the first slice; a technician arriving early is the
   same question as the assignment window.

---

## 4. Q3 — Customers / CRM: sites, addresses, and the read port

### 4.1 Observed facts

- `customers` has **one** free-text `address` plus `city`, `district` and
  `notes`; no `customer_sites`, no `customer_addresses`, no geocoordinates
  (`002_delivery_tracer.sql:5-27`; the full table list from the migrations shows
  `customers`, `contacts` and nothing address-like).
- `Contact` has `name`, `title`, `phone`, `email`, `isPrimary`, `isActive`
  (`crm/types.ts:30-43`). Contacts belong to a customer, not to a location.
- The only coordinate data is per-action evidence: `job_action_locations`
  (`013_create_job_action_locations.sql:5-35`), whose CHECK restricts it to
  `JOB_STARTED` (and later also submission). It is *evidence of where a staff
  member was*, not a serviceable address book.
- Customer delete is guarded by `customerHasAnyJobs`, which reads `job_cards`
  only (`crm/repository.ts:187-193`, `crm/service.ts:380-386`). `hasOperationHistory`
  is also `job_cards`-only (`crm/repository.ts:410-413`).
- Contact history additionally counts meeting/sale references
  (`crm/repository.ts:424-430`).

### 4.2 Consequence

A device that lives at "Blok B, 3. kat" cannot be expressed today. Two options:

| Option | Verdict |
| --- | --- |
| Maintenance-owned `maintenance_sites` (customer FK + label + address fields + optional contact FK) | **Recommended for the first slice.** It is service-location data, and it can later be reconciled with a CRM address book without touching device or plan rows. |
| Reuse `customers.address` | Rejected: one address per customer; rewriting it would rewrite history of previous service locations. |

**SSOT guard:** if CRM later adds addresses, `maintenance_sites` must not remain a
competing master. The migration path is: add `crm_address_id` to the site row,
keep the local columns as a snapshot, and read the master through a port. Write
this in the decision now, not later.

### 4.3 Narrow read port Maintenance needs

Maintenance needs *display and eligibility* data, not write access. Minimal
projection (follows the `SaleReadPort` style, `job-cards/sale-reader.ts:33-37`):

```
interface MaintenanceCustomerPort {
  customer(actor, organizationId, customerId): Promise<{
    id; name; customerType; status;              // 'prospect'|'active'|'inactive'
    city; district; address;                     // display + default site
    assignedStaffUserId; assignedStaffName;
    primaryContact: { id; name; title; phone } | null;
  } | null>;
}
```

Rules for that port (all inferred from existing code):

- Single statement, organization-scoped, returns `null` for cross-org (the
  service layer turns `null` into `404`, exactly like `crm/service.ts` and
  `job-cards` lookups).
- No write. Assignee changes stay with CRM/offboarding.
- Inactive customer must **not** block an existing device's visits; it blocks
  *new* device registration only, mirroring DOM-004's deactivation rule.

---

## 5. Q4 — Warehouse / Stock: spare parts

### 5.1 The binding split

MOD-001 §2 is explicit: Warehouse owns physical quantities, movements,
reservations and lot/serial/expiry, and "the same operational stock quantity must
not be managed as independent authoritative state in two systems"
(`DECISIONS.md:2022-2031`). MOD-001 §4 forbids building a generic event bus or
outbox before a concrete consumer exists.

Therefore: **Maintenance never writes a quantity or a balance.** It writes one
durable operational fact ("these parts were used on this visit") and, when
stock is enabled, a stock owner turns that fact into a movement.

### 5.2 What Maintenance records, in every mode

One row per used part on the visit, always present regardless of Warehouse
state:

| Column | Rule |
| --- | --- |
| `product_id` | FK to `products` (organization-scoped). Product may be inactive later. |
| `product_name_snapshot`, `product_sku_snapshot`, `product_model_snapshot` | mandatory snapshots, mirroring `job_card_delivery_items` (`002_delivery_tracer.sql:147-152`) and DOM-004 |
| `quantity` | positive; integer or 3-decimal — must match the existing delivery-item convention, see open question Q-C |
| `unit_snapshot` | nullable, per DOM-004 ("unit has no invented default") |
| `serial_no` / `lot_no` (text) | optional, free text: this is *what was installed*, not a stock identity |
| `source` | `MANUAL` in the first slice; `WAREHOUSE` only when a movement reference exists |

This is the record a service report prints and the record an auditor reads. It is
never a stock balance.

### 5.3 Mode matrix

| Deployment mode | What Maintenance does | What the operator sees |
| --- | --- | --- |
| Warehouse **disabled** | Records the parts-used fact only. UI copy must say "stok düşülmez" so nobody assumes a decrement happened. | "Kullanılan parçalar" list on the visit |
| Warehouse **enabled, Servora is stock authority** | Calls a narrow Warehouse port **inside the same transaction** that submits/approves the visit; the port writes the movement and returns its id; Maintenance stores the returned reference (nullable column reserved from day one) | same list + a link to the movement |
| Warehouse **enabled, external ERP is authority** | Records the fact and marks it `PENDING_EXTERNAL`; no local decrement. MOD-001 §2: "The single stock source of truth is set explicitly per deployment/integration mode." | same list + "harici sistemde işlenecek" |

### 5.4 The narrow contract (only what is needed)

Do **not** design Warehouse here. The only thing Maintenance needs from it is one
write port with a narrow input and an idempotent, transactional shape — the
`CustomerAssignmentCleanupPort` pattern (caller owns the transaction, provider
writes its own tables inside it; research §3b calls this "the correct pattern for
cross-module writes"):

```
interface SparePartConsumptionPort {           // implemented by Warehouse
  consumeForVisit(client: PoolClient, input: {
    organizationId; jobCardId;                    // idempotency anchor
    occurredAt: Date;
    lines: Array<{ productId; quantity; unitSnapshot; serialNo; lotNo; lineKey }>;
  }): Promise<Array<{ lineKey; movementId: string }>>;   // throws → whole submit rolls back
}
```

Idempotency anchor: the visit's submission is already idempotent (core
`processed_actions` + `job_cards.version`), so Warehouse can key on
`(organization_id, job_card_id, lineKey)` rather than inventing a second claim. If
Warehouse cannot honour that, the port must return a conflict instead of
double-decrementing (AGENTS.md §7).

**Do not** call the port from the visit *create* path. Parts are consumed when the
work is submitted for approval, so a cancelled or revised visit never moves stock.

---

## 6. Q5 — Enable / disable under MOD-002

### 6.1 What MOD-002 actually guarantees today

| Mechanism | Observed behaviour |
| --- | --- |
| State | one typed row per registry key in `installation_module_state`; no `organization_id`; not a JSON bag (`074_...:51-66`) |
| Read | one primary-key read per request, no cache; missing row or DB error is **fail-closed** (`state.ts:42-49,86-102`) |
| Disabled | module's own API answers `404 NOT_FOUND`; unreadable state answers `503 MODULE_STATE_UNAVAILABLE` (`overview/service.ts:14-24`) |
| Env | taken over once at startup; afterwards the DB is the only source (`takeover.ts:20-57`, call site `index.ts:321-327`) |
| Restore | operator sessions revoked and accounts deactivated before traffic; **module state returns to the backup instant** (pilot §9) |

### 6.2 Proposed semantics for Maintenance

| Concern | On disable | On re-enable | Basis |
| --- | --- | --- | --- |
| Devices, plans, visit detail rows, history | **kept, untouched, never deleted** | unchanged | research §4 item 4 ("data, FK, audit and idempotency records are preserved") |
| New device / plan / visit creation | blocked (`404` for the module's own routes; create menu entry hidden) | allowed again | MOD-002 §7 pattern |
| Plan-driven auto-creation | worker must check state **inside the claim transaction**, not only at tick start | resumes from the *current* due period | research §4 item 4 ("checking the flag at tick start does not resolve the race between bulk claim and submission") |
| Already-created visits | **stay operable**: start, submit, approve, revise, cancel keep working | n/a | SCH-001 §1 lesson: a module flag must not change a core workflow rule. Blocking approval would strand `WAITING_APPROVAL` rows |
| Visit type-specific writes (checklist, measurements, report) for an *existing* visit | **stay available** | n/a | Same reason; otherwise an `IN_PROGRESS` visit becomes unsubmittable and can only be cancelled |
| Occupancy of a maintenance visit | **still occupies** its assignee (it is an active core job) | n/a | SCH-001 §1 (occupancy is core, jobs always occupy) |
| Notifications already generated | readable; `in_app_notifications` is not capability-gated | n/a | observed `notifications/service.ts` (no flag read) |
| Scheduled reminders / next-due alerts | stop firing | do **not** mass-replay missed reminders; at most one "you are overdue by N periods" nudge | SCH-001 §2 analogue + research §4 item 4 ("pending reminders are not collectively revived") |
| Reports | historical visits keep counting (they are `job_cards` rows) | unchanged | reports read `job_cards`, not the module |
| Web | hide create entry, hide plan/device screens, **keep rendering historical visits and their detail tabs (read-only)** | screens return; no data migration | `web/src/jobs/NewJobMenu.tsx:61-70` shows the create option only when a handler is passed |
| `503` (state unreadable) | module's own routes `503`; **core JobCard routes unaffected** | — | MOD-002 §5 says "the module's API answers 503"; a core route must not inherit that |

**Hard rule (recommendation):** module gating must never be applied to
`/api/job-cards/*`. Those routes are core; if a maintenance visit exists, its
lifecycle must not depend on a module row that can be missing after a partial
restore.

### 6.3 Offboarding (staff leaves)

Observed: offboarding is one transaction with a **hash-bound plan** enumerating
`jobs`, `customers`, `calendar`, `followUps`, `reminders`, `jobConversations`
(`offboarding.ts:78-118,191-210`), and it **writes into many module tables
directly** (V5). Two distinct maintenance concerns:

1. **Open maintenance visits** — these are `job_cards` rows, so the existing
   `jobs` plan/decision machinery covers them with no change
   (`offboarding.ts:580-596`; the SQL excludes `WEEKLY_REPORT` and report-backed
   rows only). Their type does not matter.
2. **Plan ownership** — a maintenance plan has a responsible user
   (`owner_user_id`). Offboarding does **not** know about it. Two options:
   - **blocker** (recommended): refuse offboarding while the target owns an
     active plan, with a typed error and a paginated blocker list — exactly the
     weekly-report blocker precedent (`offboarding.ts:42-48,1050-1071`,
     `OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION`). The blocker must state how
     to resolve it (reassign the plan owner or deactivate the plan).
   - **transfer** (rejected for V1): silently re-owning a plan has no correct
     default and changes who is accountable for a regulated service interval.

Why a blocker is not "just a 409": the plan hash is computed over a fixed field
set (`offboarding.ts:179-193`). Adding a plan decision list changes the hash
input, which invalidates every in-flight preview. A blocker needs no hash change;
it is read inside the same transaction (`assertWeeklyReportsResolved` pattern).

### 6.4 Restore

- Database dumps are whole-database `pg_dump -Fc`
  (`backup/engine.ts:264`), so new tables are backed up with no extra work.
- Restore **verification** is a hard-coded relation list
  (`backup/restore/postgres.ts:11-25,289-293`). Maintenance tables must be added
  there or a restore can pass while silently missing the module's core tables.
  Recommendation: add the two or three *root* tables (devices, plans, visits),
  not every child table.
- Module state: returns to the backup instant (pilot §9). Consequence: a restore
  can re-enable a module the operator had switched off, or vice versa. The
  deploy/restore runbook must say so, and the operator UI must show
  `source`/`updatedAt` (it already returns them, pilot §12).
- A pre-Maintenance backup restores through the verified-release flow; first start
  on the new head must create the module row (see §7.2). If the row is missing and
  a takeover event exists, `takeover.ts:40-50` already fails closed — reuse that
  invariant rather than inventing a second one.

### 6.5 Fresh install

Nothing is copied from production (no data import path exists; the first admin is
created by a one-shot bootstrap CLI, never by a migration —
`SERVORA_MED_SCHEMA_DRAFT.md:548`). A fresh install has **no** maintenance row
until first start, so the "no env key" decision in §7.2 determines the default.
Report it in the install runbook either way.

---

## 7. Q6 — Registry descriptor fields actually needed

### 7.1 What the Overview pilot has

`registry.ts:7-24`: `key`, `label` (Turkish), `capability` (the
`user.capabilities` field it drives), `legacyEnvKey` (takeover source). Explicitly
**no** prerequisites, dependency graph, worker hooks, menu metadata or dynamic
loading (`registry.ts:1-6`).

### 7.2 Proposed Maintenance descriptor

| Field | Value | Why it is concretely needed |
| --- | --- | --- |
| `key` | `'MAINTENANCE'` | registry identity; also the value in `installation_module_state.module_key`, whose CHECK is `IN ('OVERVIEW')` today (`074_...:59`) |
| `label` | `'Bakım'` | operator-facing Turkish label |
| `capability` | `'maintenance'` | the web must hide navigation and create entries; `AuthenticatedCapabilities` already carries one boolean per module (`capabilities/types.ts:1-8`, `web/src/services/api.ts:19-26`) |
| `legacyEnvKey` | **none needed** — but the descriptor type must allow absence | There is no historical `MAINTENANCE_ENABLED`. `takeOverInstallationModules` iterates the registry and reads `legacy[module.capability]` from a fixed object typed `{ overviewDashboard: boolean }` (`takeover.ts:20-29`). A module with no env key must be created explicitly, not silently defaulted inside takeover |

**That last row is the only real design change to MOD-002 mechanics.** Two clean
options:

| Option | Mechanics | Cost |
| --- | --- | --- |
| **A. `legacyEnvKey?: string` + explicit `defaultEnabled: false`** | takeover creates the row with `source = INSTALL_DEFAULT` and `enabled = defaultEnabled`; the existing "missing row + takeover event ⇒ stop" invariant still holds | one nullable field, one default field, one new CHECK value |
| **B. no takeover entry; row created on first operator enable** | reader returns `null` → treated as disabled; but then `state.ts:93-96` logs "row is missing" as an error on every request and `/api/operator/modules` reports it, and MOD-002 §5 says a missing row is a **failure** state, not "off" | conflicts with MOD-002 §5; not recommended |

Recommendation: **Option A**, with `source = INSTALL_DEFAULT` added to
`installation_module_state_source_check` (`074_...:61-62`). Do **not** label an
install default `ENV_TAKEOVER` — `source` would then lie about where the value came
from, and the operator audit trail (`MODULE_STATE_TAKEN_OVER`) would claim a
takeover that never happened. This is a small, explicit migration.

### 7.3 Fields deliberately *not* needed yet

| Rejected field | Reason |
| --- | --- |
| `prerequisites: ['WAREHOUSE']` | MOD-001 makes Warehouse optional per deployment; Maintenance must work with it disabled (§5.3). A prerequisite would make the module unusable on the majority of installs and requires the dependency graph MOD-002 forbids. |
| `workers: [...]` | The plan worker can read `ModuleStateReader` inside its claim transaction. Research §4 item 6 says add worker fields when the need is real; a single-worker module does not justify a hook list. |
| `menu` metadata | Navigation is derived from `capabilities` in `web/src/shell/navigation-model.ts:89`. |
| `migrationChain` | Migrations are global and ordered (`server/src/db/migrations`); per-module chains are explicitly out of scope (research §4 item 6). |
| `routes` list | Routes are always registered and gated in the service (MOD-002 §7 "routes stay always registered"). |

---

## 8. Consequence map — every place a new type touches

Observed touch points for a new `JobCardType`, in the order they will fail or
silently misbehave. "Compile" means the build stops; "silent" means it does not.

| File | Line | Failure mode |
| --- | --- | --- |
| `server/src/modules/job-cards/types.ts` | 29 | source of truth |
| `server/src/db/migrations/*` | new | `job_cards_type_check` (`057_sale_from_visit.sql:5-8`) |
| `server/src/modules/job-cards/submission-policy.ts` | 388-390 | compile (PR #513) |
| `server/src/modules/job-cards/policy.ts` | 144-146 | compile (PR #513) |
| `server/src/modules/job-cards/follow-up-policy.ts` | 86-96 | compile |
| `server/src/modules/job-cards/job-card-duration.ts` | 5-8, 42-44 | silent: no canonical duration, no planned-interval rule |
| `server/src/modules/job-cards/occupancy.ts` | 70-72 | silent: no conflict detection, no slot search |
| `server/src/modules/job-cards/assignment-offer-policy.ts` | 35-37 | silent: no acceptance window |
| `server/src/modules/job-cards/create-input.ts` | 36-40, 50-61, 380 | silent at compile; runtime rejects the type in the generic `POST /` (`exactRecord`) — creation needs its own route |
| `server/src/modules/reports/repository.ts` | 344, 380-437 | silent: absent from workload buckets |
| `server/src/modules/reports/repository.ts` | 2494-2521 | automatic (groups by `j.type`) |
| `web/src/jobs/job-labels.ts` | 17-23 | compile |
| `web/src/jobs/job-workflow-presentation.ts` | 706-717 | compile |
| `web/src/jobs/follow-up-presentation.ts` | 37-45 | compile |
| `web/src/jobs/scheduling.ts` | 9 | silent (optional duration map) |

Cross-cutting tables that need additive CHECK changes:

| Table | Constraint | Where |
| --- | --- | --- |
| `audit_events` | `subject_type` (add `MAINTENANCE_DEVICE`, `MAINTENANCE_PLAN`) | `060_crm_duplicate_review_decisions.sql:94-99` |
| `audit_events` | `event_type` (add device/plan events) | `061_weekly_report_removal.sql:52-74` |
| `realtime_events` | `realtime_events_activity_source_check` — currently "exactly one of job activity / calendar activity / calendar reminder" | `017_calendar.sql:234-239` |
| `installation_module_state` | `module_key IN (...)` | `074_...:59` |
| `operator_audit_events` | `module_key` | `074_...:86-87` |

Two of these deserve a warning:

- **`realtime_events`**: a plan-level notification ("service due in 7 days") has no
  legitimate source row today. Options: (i) extend the CHECK with a fourth
  maintenance activity source; (ii) only emit notifications for *visits* (which
  are jobs → their activity already works). Recommendation for V1: **(ii)**, plus
  a plan-due notification only if the owner accepts the CHECK extension. Do not
  invent a fake `job_card_activity_logs` row to satisfy the FK.
- **`processed_actions`** requires `user_id NOT NULL`
  (`002_delivery_tracer.sql:199-209`). A scheduler has no user, so plan-driven
  auto-creation **cannot** use `processed_actions`. It needs its own uniqueness
  claim, e.g. `UNIQUE (organization_id, plan_id, due_period_start)` on the visit
  row. This is the single most likely place to accidentally create duplicate
  visits.

Other integration surfaces:

| Surface | Impact |
| --- | --- |
| Demo-data purge plan | the analyzer enumerates tables by hand and fails on FK `23503` at purge time (`demo-data/analyzer.ts:569`); maintenance tables referencing demo datasets must be added |
| Restore relation list | `backup/restore/postgres.ts:11-25` (see §6.4) |
| Customers delete | add a composite `ON DELETE RESTRICT` FK; also decide whether `hasOperationHistory`/`customerHasAnyJobs` should count devices (recommendation: yes for `hasOperationHistory`, so the UI does not offer a delete that then 409s) |
| Offboarding | §6.3 |
| Lock order | `SERVORA_MED_SCHEMA_DRAFT.md:505` documents `users -> customers -> contacts -> job_cards`; the new order must be stated explicitly (recommendation: `users -> customers -> maintenance_devices -> maintenance_plans -> job_cards`) |

---

## 9. Open questions for the owner

Numbered for reference; each is a decision, not a preference.

**Q-A. Assignment window and early start for maintenance visits.**
Today only `PRODUCT_DELIVERY`/`SALES_MEETING` get the acceptance window
(`assignment-offer-policy.ts:35-37`) and the 30-minute early-start tolerance
(`policy.ts:52-56`). A service appointment is a booked slot with a customer
present. Should a maintenance visit behave like a delivery (window + early start)
or like a general task (no window, exact time)? *Recommendation: like a delivery,
but in a second slice — the first slice ships without it to keep the diff small.*

**Q-B. Device identity vs Warehouse serial identity.**
MOD-001 §2 gives Warehouse lot/serial/expiry. Maintenance needs a stable device
identity that survives a Warehouse being enabled later, disabled, or replaced by
an external ERP. Is the device's serial a Maintenance-owned string (a snapshot)
with an optional future reference to a Warehouse serial, or must the device be
created *from* a Warehouse serial when Warehouse is on? *Recommendation: the
former; the device is the installed asset, the serial is its historical attribute.*

**Q-C. Spare-part quantity shape.**
`job_card_delivery_items.quantity` is `NUMERIC(12,3)` with whole units enforced at
the API layer (`SERVORA_MED_SCHEMA_DRAFT.md:490`), while `SALE` quantity is an
integer 1–999999999 (SALE-QTY-001). Spare parts are discrete items, so integer is
the natural choice — but the same product may appear in both flows. *Recommendation:
integer for parts used; do not reuse the sale quantity parser.*

**Q-D. Attachments.**
Photos and scanned service forms need upload, storage, access control and backup
participation. None exists. Is photo evidence in scope for the first slice, and if
so is a filesystem/R2-backed store with per-organization scoping acceptable
(reusing the backup R2 adapter, `backup/r2.ts`), or is it deferred? *Recommendation:
defer; a service report PDF with structured fields covers most of the need.*

**Q-E. Signature.**
Is a typed name + timestamp enough, or is a drawn signature required? A drawn
signature is an image → depends on Q-D.

**Q-F. Plan-due notifications.**
Do we notify on plan due dates (requires extending
`realtime_events_activity_source_check`), or only on visits (free, since visits are
jobs)? *Recommendation: visits only in the first slice.*

**Q-G. Site model.**
Maintenance-owned `maintenance_sites` now, or wait for a CRM address book? A
hospital chain with several buildings will force the question early. *Recommendation:
Maintenance-owned now, with the `crm_address_id` migration path written into the
decision.*

**Q-H. Customer deactivation.**
Should an inactive customer block creating a *new device*, and should it block
scheduling a *visit* for an existing device? *Recommendation: block new devices,
allow visits — the installed base must still be serviced.*

**Q-I. Module default on a fresh install.**
MOD-002 took the env value for Overview. Maintenance has no env key. Default off
(operator enables after install) or default on (the module is part of the sold
product)? This decides the `INSTALL_DEFAULT` source value in §7.2.

---

## 10. Unverified items

| Item | Why unverified |
| --- | --- |
| PR #513 will merge as reviewed | I read the branch diff (`git diff origin/main...origin/refactor/job-card-exhaustive-dispatch`), not a merge decision. The exhaustiveness recommendation depends on it landing. |
| `origin/refactor/weekly-report-submission` final shape | Branch is open and moved during this research; I used it only as a *pattern* precedent, not as API. |
| Whether `job_cards_type_check` can be altered without a table rewrite lock | Not measured. 057 does `DROP/ADD CONSTRAINT` on an existing table; the operational cost on a large `job_cards` table is **UNVERIFIED**. |
| Whether `reports.getWorkTypeDistribution` is displayed anywhere that would break on a 6th type | I read the SQL and the Overview wiring, not every consumer. The `LIMIT 10` at `reports/repository.ts:2514` means no hard break, but the UI ordering is unchecked. |
| Actual production `CALENDAR_ENABLED` / module states | Not read (no production access). SCH-001's deploy note applies to the occupancy change, not to this research. |
| Whether any customer-facing requirement mandates photo evidence | That is a regulation question; see the parallel note `04-regulation-and-industry.md` in this folder (not authored by me, may still change). |
| Licence/legal weight of an electronic signature in Turkey | Out of scope here; **UNVERIFIED**. |
| Whether `pdfmake` can render Turkish characters correctly in a maintenance report | The weekly-report renderer embeds Roboto and has `sanitizePdfText` (`weekly-reports/pdf/document-model.ts:101`); glyph coverage for every Turkish character in a new template is **UNVERIFIED** until rendered. |
