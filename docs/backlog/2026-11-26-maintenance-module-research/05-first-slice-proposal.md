# 05 — Smallest end-to-end first slice for the Maintenance (Bakım) module

Status: **research proposal for the owner, not a decision and not implementation
authorization.** Base: `origin/main` @ `89bf6b1` (worktree
`maintenance-module-research-b97e8e`). Author: research worker (run
`20261126-145240-deepseek-3bb2`). Every code claim carries `path:line` against that
commit unless another ref is named; every external claim is cited from note 04 with
its access date. `inference` and `recommendation` are mine.

**Summary (9 lines)**

1. The smallest genuinely *end-to-end* slice is **the installed base (device registry)
   plus one maintenance visit carried by a new `MAINTENANCE` JobCard type**, with the
   visit's service facts in a module-owned 1:1 table — not the registry alone.
2. A visit without a device has no subject; a device without a visit is a read-only
   inventory; and the owner's hypothesis cannot be tested until a visit exists.
3. The visit must be a **planned-interval, occupancy-bearing** type. Reusing
   `GENERAL_TASK` silently loses occupancy, slot search, calendar end time and
   submission readiness (`occupancy.ts:70`, `job-card-duration.ts:42`,
   `calendar/repository.ts:63`, `submission-policy.ts:371-390`).
4. That forces **four small core prerequisite PRs plus a type-list parity check**: a
   type-behaviour table, PR #513, job-action dispatch, reports bucket decoupling. All are
   Maintenance-agnostic.
5. The type is created through a **module-owned route**; the generic
   `POST /api/job-cards` keeps rejecting it (`create-input.ts:34-62`,
   `service.ts:1851-1854`). Submission readiness is a module contribution called from
   `submission-policy.ts`, mirroring the weekly-report precedent.
6. Enable/disable uses **MOD-002 with one small extension**: a registry entry with no
   legacy env key and `defaultEnabled: false` (03 §7.2 option A). Disabled blocks the
   module's **writes**; reads stay available (retention); core JobCard routes never read
   module state.
7. Offboarding needs **no change**: nothing in the module owns a staff member, and the
   visit is a JobCard that transfers through the existing plan.
8. Restore needs the two module root tables in the closed `CORE_RELATIONS` list
   (`backup/restore/postgres.ts:11-25`); module state returns to the backup instant.
9. Cost: ~5 prerequisite PRs (≈1.200–1.500 changed lines with tests) + the slice
   (≈1.700 lines). Slice 1 is **not** a PDF, plans, stock, contracts, attachments,
   signatures or ÜTS integration.

---

## 0. Method and evidence rules

**Observed** = read at `89bf6b1` (branches read with `git show`/`git log`; their merge
state is UNVERIFIED). **Inference/recommendation** = mine, needs owner approval.
**UNVERIFIED** = not provable in this run (§8). Nothing was built, migrated, tested,
installed or deployed; no state-changing git command was run. Notes 01–04 and 06 are
treated as unverified input — every claim I rely on was re-checked against source.
Evidence: `$FLEET_EVIDENCE_DIR/05-anchor-verification.log`.

---

## 1. Assumed scope

### 1.1 The slice in one sentence

> An ADMIN turns deliveries into device records and completes serial/ÜTS/warranty data;
> a MANAGER books a visit for a device and a technician; the technician records what was
> done and whether the device is fit for use; a MANAGER approves it; and the device page
> shows the service history — the visit being an ordinary `MAINTENANCE` JobCard for
> assignment, lifecycle, approval, occupancy and audit.

### 1.2 In / out

| Area | In slice 1 | Later |
| --- | --- | --- |
| Device identity | org-scoped register: product + snapshots, serial (nullable), ÜTS barcode, location label, install date, warranty dates, status | device transfer between customers, merge/split, nameplate no., photos, usage life |
| Provenance | seed from **COMPLETED, `SALE`-purpose** delivery lines with human confirmation; manual create | seed from SALE line items directly, ERP import |
| Visit | new `MAINTENANCE` JobCard type; one module-owned visit row; kind, work performed, spare-parts **text**, fitness decision | PDF report, signatures, checklists, measurements, report numbers |
| Scheduling | planned interval (canonical 60 min), staff occupancy, available-slot search, calendar event | assignment offers (JOB-010), early start (JOB-010 §1a) |
| Approval | unchanged core manager approval + revision | clinic counter-signature, second approval gate |
| Plans / parts | none; parts are a free-text note only | `maintenance_plans`, due list, workers, notifications; Warehouse-backed parts and stock effects |
| Module state | registry entry, capability, operator switch, gate | prerequisite graph, per-module workers |
| Reports | type counted as productive work (bucket + totals) | dedicated maintenance report route |
| Offboarding | nothing new (JobCard transfer) | plan-owner blocker when plans exist |
| Demo data | seed excludes demo deliveries; purge handles module rows by graph | demo devices as a showcase |

### 1.3 Owner answers the slice assumes

These are **assumptions**, each with the alternative if the owner answers differently.
They are the input to MNT-001 (§2.1).

| # | Assumption | If the owner answers differently |
| --- | --- | --- |
| A1 | A maintenance visit is a **planned interval** (start + end required) and **occupies** its assignee | If open-ended: no type in slice 1, use `GENERAL_TASK` + device/visit link, and slice 1 gets much smaller (§1.4) |
| A2 | **Manager approval stays mandatory** for a visit | If not: core lifecycle needs a type-aware approval bypass and DOM-006's `manager_approved_at` definition changes — out of this slice |
| A3 | The canonical duration is **60 minutes**, adjustable between creations by rescheduling | If 90/120: one constant + one test change |
| A4 | **No assignment offer** and **no early start** for a visit in slice 1 (a booked appointment is confirmed by management) | If offers: JOB-010 window, reminders, expiry, JOB-012 proposal and the offer/occupancy interaction join slice 1 (~+1 PR) |
| A5 | The **customer is derived from the device** and is not accepted on create; contact is not captured | If contact is needed: one nullable `contact_id` + CRM validation |
| A6 | Device mutations are **ADMIN/MANAGER**, device reads are **org-wide for every role** (DOM-004 pattern) | If Staff may create devices: role matrix change only |
| A7 | Visit creation is **ADMIN/MANAGER**; a STAFF executes and edits facts | If Staff may open corrective visits: creation permission + self-assignment path |
| A8 | Location is a **free-text label on the device**; there is no sites table | If a hospital needs per-building sites: add `maintenance_sites` + FK (03 §4.2), +1 PR |
| A9 | Maintenance is an **installation module**, default **off** | If it is always-on core: no registry/capability work, but no operator switch either |
| A10 | A device is **never hard-deleted** after it exists; retirement is a status | If deletion is required for mis-entries: a delete path + audit + FK policy |
| A11 | Maintenance work is **productive work** in reports (bucket + totals) | If excluded: totals must exclude it explicitly or the arithmetic mismatch (06 §2.3a) remains |
| A12 | A visit cannot originate a `SALE` or a `PRODUCT_DELIVERY` | If it can: SALE-001/SALE-002 source rules and `realtime/repository.ts:41-73` need a review |

### 1.4 Alternative slice if A1 is "no, open-ended"

Use a `GENERAL_TASK` with a `maintenance_visits` row (`job_card_id` UNIQUE); only P0 and
P6 remain as prerequisites; occupancy is **none** (a technician can be double-booked and
the form must warn "çakışma denetlenmez"); submission is not gated; the calendar shows a
point event. Honest label: "cihaz kaydı + bakım notu", not a visit. It is smaller but
does not test the hypothesis and builds a second-class record a later type slice must
migrate — **not recommended**.

### 1.5 Where the inputs disagree — and what this proposal assumes

| # | Disagreement | Sources | Assumed here |
| --- | --- | --- | --- |
| D1 | First slice = registry only vs registry + visit/type | 02 §5–§6 (Cut A), 03 §3.4 (type), 01 §5 (type last) | **registry + one visit type**, split into P5/P6/P7 so it stays reviewable |
| D2 | Site model: free-text label vs `maintenance_sites` table | 02 §2.3, 03 §4.2 | **free-text `location_label`**; sites is a later, separate entity |
| D3 | How a new module gets its default state | 03 §7.2 option A (`INSTALL_DEFAULT`) vs option B (no row) | **03 option A**; no invented `MAINTENANCE_ENABLED` env key |
| D4 | Reports: new route vs new bucket | 06 §5.2 ("new route, not a new bucket") vs 06 §2.3a (totals ≠ parts) | **add the bucket on both sides** in the type PR; a dedicated route is later |
| D5 | Visit carrier: `GENERAL_TASK` vs new type | 02 Cut B allows `GENERAL_TASK`; 03 §3.2 rejects it | **new `MAINTENANCE` type** |
| D6 | Approval meaning: manager approval vs clinic counter-signature | 04 §11 ("approval semantics differ") | **keep core manager approval**; counter-signature is a later report field, logged as a gap |
| D7 | Duration/early start/offers | 01 §7 Q1–Q3 undecided; 03 §3.4 excludes offers/early start | **60 min, no offer, no early start** |
| D8 | Module off = 404 for the whole API vs history must stay readable | 03 §6.2 table (read-only historical rendering) vs `overview/service.ts:14-18` | **writes 404, reads allowed** — flagged for MNT-001 (§4.2) |

---

## 2. Prerequisites, in order

Each row is one PR-sized unit that leaves `main` green. P0 is a document; P1–P4 are
behaviour-preserving refactors; P5–P6 add the type and the module switch with no
producer; P7 is the slice.

### 2.1 P0 — MNT-001 decision record (docs only, owner-approved)

MNT-001 must decide (not implement) at least the items below. P0 also produces the
feature contract `docs/features/maintenance/slice-1.md` in the shape of
`docs/features/operator-module-pilot.md` (scope, API, acceptance, evidence).

| # | Decision | Why it cannot be an engineering default |
| --- | --- | --- |
| 1 | Ownership: JobCard owns work (identity, assignment, lifecycle, approval, occupancy, audit); Maintenance owns device identity and service facts; no core→module FK | MOD-001 §1 is silent on assets; a device FK on `job_cards` repeats V6 |
| 2 | Visit carrier: new `MAINTENANCE` type; planned interval; on-site; occupies; canonical 60 min; no offer; no early start | Amends SCH-001 item 1, which names only `SALES_MEETING`/`PRODUCT_DELIVERY` (`DECISIONS.md:3694-3701`) |
| 3 | Approval: core manager approval only; clinic counter-signature is report data, not a second gate | 04 §11 and PRODUCT_REQUIREMENTS approval meaning |
| 4 | Customer/contact and device identity: customer derived from device; contact unused; serial is a Maintenance-owned, nullable, never-guessed attribute (no Warehouse serial claim) | Per-type create rules are policy (`create-input.ts:34-41`); MOD-001 §2 gives Warehouse lot/serial/expiry |
| 5 | Site and retention: free-text `location_label`; no hard delete of a device or visit fact; `RETIRED` is a status; edits stop at terminal job status | CRM has one address per customer (`002:5-27`); 04 §8 and AGENTS.md §6 |
| 6 | Permissions: ADMIN/MANAGER device mutation and visit creation; STAFF org-wide device read and execution edits | DOM-004 pattern (`DECISIONS.md:554-557`) |
| 7 | Module: `MAINTENANCE` in the registry; default off; no legacy env key; `INSTALL_DEFAULT` source | MOD-002 §4/§7 |
| 8 | Disabled semantics: writes blocked, reads of module data preserved, core lifecycle unaffected, occupancy still counts | MOD-002 §5 only defines the unreadable case |
| 9 | Offboarding: no module-owned owner in slice 1; a later plan owner requires the weekly-report-style blocker | 03 §6.3 |
| 10 | Reports and demo data: MAINTENANCE is productive work with a bucket; follow-up children stay 3; seed excludes demo deliveries; purge deletes module rows by graph | DOM-006; `demo-data/analyzer.ts:569` |
| 11 | ÜTS: store identifiers only; no integration | 04 §4.5 |

### 2.2 P1 — `refactor(job-cards): one type-behaviour table`

**Why before the type:** "maintenance" is currently expressible through roughly ten
independent two-value predicates and allowlists across server and web. Without one table,
adding the type would be approved while one copy stays stale — the exact "half on-site"
failure (01 §3.1).

| Copy | Current | Behaviour if missed |
| --- | --- | --- |
| `occupancy.ts:70-72` | SQL `IN ('SALES_MEETING','PRODUCT_DELIVERY')` | visit never occupies → no `409 CALENDAR_CONFLICT`, double booking |
| `job-card-duration.ts:5-8` | `Partial<Record<JobCardType, number>>` | no canonical end → slot search impossible (`service.ts:9061-9063`), zero-length calendar event |
| `job-card-duration.ts:42-44` | `isPlannedIntervalJobType` | START without an interval; no R3 invariant |
| `policy.ts:54-56` | `acceptsEarlyStart` | early start silently disabled while an authorization can be granted → inert permission |
| `assignment-offer-policy.ts:34-37` | `isAssignmentOfferJobType` | new type sits `NEW` with no window/reminder (a decision, but must be explicit) |
| `customer-schedule.ts:16-18` | `isOnSiteJobType` | excluded from slots/preview while occupancy includes it |
| `calendar/repository.ts:61-65` | `CASE WHEN type IN (…)` | event renders zero-length even with a stored end |
| `service.ts:3944` | `isCalendarIntervalJob` (sixth copy, not listed in 01) | patch path does not preserve/repair the interval, no assignee lock |
| `create-input.ts:380,413` | preview/slot allowlists | 400 on preview/slots for a type that is otherwise on-site |
| `web/src/jobs/job-schedule-integrity.ts:14`, `web/src/calendar/CalendarPage.tsx:200` | web copies | "Planlanmadı" signal and slot search silently skip the type |

Deliverable: `JOB_TYPE_BEHAVIOUR: Record<JobCardType, { plannedInterval; canonicalDurationMs;
assignmentOffer; earlyStart; deadlineSource; productiveWork }>` (in
`job-card-duration.ts` or a new `type-behaviour.ts`), plus helpers rendered from it.
`occupancy.ts` renders its SQL `IN` list from the table. A unit test asserts the SQL
list equals the planned-interval set. **No behaviour change for the five existing
types** is the acceptance condition.

### 2.3 P2 — merge PR #513, and fix the merge order with the weekly-report branch

- #513 (`origin/refactor/job-card-exhaustive-dispatch`, `02a9ba2`, `b3e20e8`) makes the
  **status** chain exhaustive (`policy.ts:164`) and the **type** chain in
  `evaluateSubmission` exhaustive (`if/if/…/const unhandledType: never`).
- `origin/refactor/weekly-report-submission` (`3497254`) ends the same function with a
  ternary and **does not contain** `assertNeverJobCardValue` (`submission-policy.ts:278-286`
  on that branch). If it merges after #513 in this shape, V11 reopens silently.
- **Rule:** merge #513 → merge weekly-report → rebase and re-introduce
  `assertNeverJobCardValue(jobCard.type, 'type')` → only then open the Maintenance type
  PR. Nothing in Maintenance must *wait* functionally, but the type PR must not become a
  third concurrent editor of that 8-line tail.
- Add a source-level guard (a test that the `never` assignment exists in
  `submission-policy.ts` and `policy.ts`) so a future merge cannot drop it again.

### 2.4 P3 — `refactor(job-cards): exhaustive job-action dispatch`

`getAllowedJobActions` branches on `job.type !== 'SALES_MEETING'` (`policy.ts:190-215`):
any new type inherits the generic branch and gets no result-editing action. Convert to
`switch (job.type)` with `assertNeverJobCardValue(job.type, 'type')`, preserving today's
behaviour. Without this, a visit would show notes/change-request but no
"bakım kaydını düzenle" action.

### 2.5 P4 — `fix(reports): decouple follow-up child buckets + type-list parity`

| Item | Why |
| --- | --- |
| `FOLLOW_UP_CHILD_WORK_TYPES` (`reports/repository.ts:354`) is derived from `PRODUCTIVE_WORK_TYPES` by filtering `SALE`. Adding MAINTENANCE to the productive list would silently make follow-up children **4**, while the web parser requires exactly 3 (`reports-api.ts:853-858`) → `INVALID_RESPONSE` on the sales-follow-up report | must be an explicit 3-literal list before the bucket is widened |
| `PRODUCTIVE_WORK_TYPES` (server) and `PRODUCTIVE_JOB_CARD_TYPES` (web, `jobs-api.ts:38-41`) are manual copies; the web parsers enforce **length and positional equality** (`reports-api.ts:317-327,361-372`) | a same-deploy rule is not enough; add a small CI check (Node script under `ops/tests/`) that parses both literals and fails on mismatch |
| `CustomerReportPeriod.createdWorkTypes` is a closed object (`reports/types.ts:469-474`) and the customer report derives per-type chips with four `FILTER` columns (06 R9) | must be extended in the same PR as the bucket |
| `business-trend.visits` is `SALES_MEETING` only (`business-trend.ts:23-28`) | MNT-001 decides "not a sales visit"; no change now |

P4 does **not** add MAINTENANCE to the buckets. It only removes the trap and adds the
parity check.

### 2.6 P5 — `feat(job-cards): MAINTENANCE job type`

Split into two reviewable halves that must be merged (or deployed) together before any
producer exists:

**P5a (server)**
- `types.ts:29` union + migration re-issuing `job_cards_type_check` (`057:5-7`) with
  `MAINTENANCE`; `JOB_TYPE_BEHAVIOUR` entry (interval, 60 min, no offer, no early start,
  deadline = interval end, productive work).
- `follow-up-policy.ts:86-96` — compiler-forced entry; `GENERAL_TASK`.
- `submission-policy.ts` — `MAINTENANCE` branch calling a module evaluator (§3.4); the
  final `never` stays. `create-input.ts:380,407-415` and `service.ts:9061-9105` read the
  P1 table, so slot search works. `reports/repository.ts:344,354,381,533,650,764-768`
  adds the bucket and keeps the follow-up list at 3.
- `audit_events` + `job_card_activity_logs` CHECK migrations (§3.6). The generic
  `POST /api/job-cards` keeps rejecting `MAINTENANCE` — no `CREATE_FIELDS_BY_TYPE` entry.

**P5b (web, same deploy)** — `jobs-api.ts:38-53`, `job-labels.ts:17-23` (`Bakım`),
`job-workflow-presentation.ts:103-121,706-718`, `JobApprovalReviewPanel.tsx:15-30`,
`signal-icons.tsx`, report parsers/fixtures, `job-schedule-integrity.ts:14`,
`CalendarPage.tsx:200`. No create screen yet, so no row can exist before P7.

Verification: server build + full suite and web build on a provisioned PG17 database
(`docs/operations/local-test-environment.md`).

### 2.7 P6 — `feat(installation-modules): MAINTENANCE registry entry`

- `registry.ts:7-26`: union gains `'MAINTENANCE'`; descriptor gains `label:'Bakım'`,
  `capability:'maintenance'`, no `legacyEnvKey`, `defaultEnabled:false`.
- Descriptor type: `legacyEnvKey` becomes optional; `defaultEnabled` added (03 §7.2 A).
- `takeover.ts:20-57`: when `legacyEnvKey` is absent, insert
  `(module_key, enabled=false, source='INSTALL_DEFAULT')` and write
  `MODULE_STATE_INSTALL_DEFAULTED`; the "row missing but a prior event exists" fail-closed
  check must cover both event types (`takeover.ts:40-50`).
- Migrations: `installation_module_state_key_check` → `('OVERVIEW','MAINTENANCE')`
  (`074:59`); `installation_module_state_source_check` → add `INSTALL_DEFAULT`
  (`074:61-62`); `operator_audit_events_event_type_check` → add the new event
  (`074:80-87`).
- `capabilities/types.ts:1-8` + `DEFAULT_CAPABILITIES` + a `withMaintenance` projection
  (`capabilities/service.ts:7-31`); `web/src/services/api.ts:19-26` mirror.
- App wiring: `buildApp` already receives `moduleStateReader` (`app.ts:200,257`); the
  module service reads it per request.
- `staticModuleStateReader` (state.ts:69-80) returns one boolean for every key — change
  to a `Record<InstallationModuleKey, boolean>` or two flags, or in-memory tests will
  enable both modules together.

### 2.8 P7 — the slice itself (`feat(maintenance): devices + visits`)

Detailed in §3. Can be two PRs (server vertical, then web) but must ship with the
module **off** by default, so the first deploy is inert until the operator enables it.

### 2.9 Order, parallelism and gates

| Step | Depends on | Gate to close it |
| --- | --- | --- |
| P0 MNT-001 | owner | owner sign-off on the 11 items |
| P1 behaviour table | P0 (semantics frozen) | no behaviour change; occupancy SQL list test |
| P2 #513 + merge order | — | #513 on `main`; `never` present after the weekly-report merge |
| P3 job actions | P2 (same file) | `tsc` total; action parity test per type |
| P4 reports decoupling + parity | — | follow-up children stay 3; parity script fails on drift |
| P5a/P5b type + web | P1, P2, P3, P4 | build + full server/web suites; no producer route |
| P6 module registry | P0 | operator toggle tests OP6/OP7/OP10 analogues |
| P7 slice | P5, P6 | §5 acceptance suite + UI-003 evidence |

P1, P2 and P4 can run in parallel; P3 shares `policy.ts` with P2; P6 can precede P5
because a module with no write route is inert.

**What must wait for `refactor/weekly-report-submission`:** only the exact rebase of
`submission-policy.ts` and the `assertNever` re-introduction (P2). Nothing else in
P1/P3/P4/P5a touches that branch's files (`policy.ts`, `occupancy.ts`,
`job-card-duration.ts`, `assignment-offer-policy.ts`, reports, migrations are untouched
by it — 01 §4). Do not implement a second type dispatch inside
`weekly-reports/submission.ts`: the dispatch stays in `job-cards/submission-policy.ts`.

---

## 3. The slice (P7)

### 3.1 User stories (Turkish role names)

| # | Role | Story | Must / later |
| --- | --- | --- | --- |
| US-1 | **Sistem Yöneticisi (ADMIN)** | "Onaylanmış teslimatlardan cihaz kaydı oluştur" ile kurulu tabanı kurar; her adayı görür, seçer, onaylar; ikinci çalıştırma kopya üretmez | must |
| US-2 | ADMIN / **Yönetici (MANAGER)** | Bir cihazı elle ekler/düzenler: ürün, seri no, ÜTS barkod, konum, kurulum ve garanti tarihleri; "seri no eksik" listesini görür | must |
| US-3 | MANAGER | Bir cihaz için teknisyene bakım ziyareti planlar; sistem personelin dolu olduğu saati reddeder ve boş saat önerir | must |
| US-4 | **Personel (STAFF)** | Kendisine atanan ziyareti görür, başlatır, yapılan işi ve "cihaz kullanıma uygun mu" kararını kaydeder, onaya gönderir | must |
| US-5 | MANAGER | Bakım kaydını ve cihaz bilgisini görerek onaylar veya gerekçeli revizyon ister | must |
| US-6 | ADMIN / MANAGER | Cihaz sayfasında teslimat kökenini ve tüm bakım geçmişini görür | must |
| US-7 | STAFF | Klinikte başlamadan önce cihaz kimliğini (model, seri, garanti) okur | must |
| US-8 | ADMIN / MANAGER | Müşteri sayfasında cihaz sayısını ve listeye bağlantıyı görür | later (should) |

### 3.2 Data model sketch

Conventions copied from the repo: UUID PKs, `organization_id` on every table, composite
`(organization_id, id)` uniques and composite FKs, `version` for optimistic concurrency,
snapshots instead of joins for historical product data.

**`maintenance_devices`** — *must*

| Column | Type / rule |
| --- | --- |
| `id`, `organization_id` | UUID PK; UUID NOT NULL → `organizations(id)` |
| `customer_id`, `product_id` | UUID NOT NULL; composite FKs → `customers`/`products` ON DELETE RESTRICT |
| `product_name_snapshot` | VARCHAR(255) NOT NULL, trimmed non-empty; sku/brand/model snapshots VARCHAR(100) NULL (DOM-004) |
| `serial_no` | VARCHAR(100) NULL — never invented; `serialMissing` derived in the DTO, not stored |
| `uts_barcode_no`, `location_label`, `installed_on` | VARCHAR(100) / VARCHAR(120) / DATE, all NULL; store-only ÜTS id, free-text unit, seed defaults install date from delivery |
| `warranty_started_on`, `warranty_ends_on` | DATE NULL; CHECK end ≥ start when both present; in/out is derived, never stored |
| `status` | VARCHAR(20) NOT NULL DEFAULT `'ACTIVE'` CHECK IN (`ACTIVE`,`IN_SERVICE`,`RETIRED`) |
| `source_kind` | VARCHAR(20) NOT NULL CHECK IN (`MANUAL`,`DELIVERY_SEED`) |
| `source_delivery_job_id`, `source_delivery_item_id` | UUID NULL; FKs to `job_cards` / `job_card_delivery_items` ON DELETE RESTRICT |
| `version`, `created_by`, `updated_by`, `created_at`, `updated_at` | version > 0; both actors NOT NULL → users; timestamps default now() |

Constraints: `UNIQUE (organization_id, id)`; partial `UNIQUE (organization_id,
source_delivery_item_id) WHERE source_delivery_item_id IS NOT NULL` (idempotent seed);
partial `UNIQUE (organization_id, product_id, serial_no) WHERE serial_no IS NOT NULL`
(no duplicate physical unit); CHECK `source_kind='DELIVERY_SEED'` ⇔ both source columns
NOT NULL; CHECK `source_kind='MANUAL'` ⇒ both NULL.
Indexes: `(organization_id, customer_id)`, `(organization_id, status)`,
`(organization_id, product_id)`.

**`maintenance_visits`** — *must*

| Column | Type / rule |
| --- | --- |
| `id`, `organization_id` | UUID PK; UUID NOT NULL |
| `job_card_id` | UUID NOT NULL; `UNIQUE (organization_id, job_card_id)` — 1:1 with the JobCard (`weekly_reports`, `051:43-45`); FK ON DELETE RESTRICT |
| `device_id` | UUID NOT NULL; FK `(organization_id, device_id)` → `maintenance_devices` ON DELETE RESTRICT |
| `visit_kind` | VARCHAR(20) NOT NULL CHECK IN (`INSTALLATION`,`PREVENTIVE`,`CORRECTIVE`,`INSPECTION`) |
| `work_performed`, `spare_parts_note` | TEXT NULL; work non-empty when present and **required at submit**; parts is free text only, never a stock fact (MOD-001 §2) |
| `fitness_decision` | VARCHAR(20) NULL CHECK IN (`SAFE_TO_USE`,`SAFE_WITH_RESTRICTION`,`NOT_SAFE_TO_USE`); **required at submit** |
| `created_by`, `updated_by`, `created_at`, `updated_at` | both actors NOT NULL → users; timestamps default now() |

No `version`: the **JobCard's** `version` is the single concurrency domain for the card
and its 1:1 facts (precedent: meeting details are edited under the parent card version).
FK to `job_cards` ON DELETE RESTRICT — there is no JobCard delete path, and CASCADE
would violate append-only history. Index `(organization_id, device_id, created_at DESC)`.

**Deliberately absent:** `quantity`, `stock_*`, `warehouse_id`, `cost`, `price`,
`contract_id` (02 §6), `lot_no`, `next_due_on` (a plan field; a second due-date source
without a plan would be a competing SSOT), photos, signatures, report number.

**Lock order:** `users → customers → contacts → maintenance_devices → job_cards`
(extension of `SERVORA_MED_SCHEMA_DRAFT.md:505`). The seed reads `job_cards` **without**
row locks and writes only devices, so it never takes the reverse order.

### 3.3 API sketch

All module routes live under `/api/maintenance`, are always registered and are gated in
the service (MOD-002 §7). Bodies and listing follow the existing JSON/pagination
contract (`SERVORA_MED_API_DRAFT.md` §1).

| # | Method / path | Roles | Idempotency / concurrency | Behaviour |
| --- | --- | --- | --- | --- |
| 1 | `GET /devices?q&customerId&status&serialMissing&limit&offset` | all | — | org-scoped list; STAFF read-only |
| 2 | `GET /devices/:id` | all | — | detail + provenance + last 20 visits filtered by `actorCanReachJob` for STAFF |
| 3 | `POST /devices` | ADMIN/MANAGER | `clientActionId` (`MAINTENANCE_DEVICE_CREATE`) + natural unique | 201; **inactive customer → 409**; demo customer allowed, purge handles it (§4.6) |
| 4 | `PATCH /devices/:id` | ADMIN/MANAGER | `expectedVersion` | identity/warranty/location; 409 `VERSION_CONFLICT` |
| 5 | `POST /devices/:id/status` | ADMIN | `expectedVersion` + reason | `IN_SERVICE`/`RETIRED`/back to `ACTIVE`; audit event |
| 6 | `POST /devices/seed-preview` | ADMIN/MANAGER | — | read-only candidates: `NEW` / `ALREADY_REGISTERED` / `SERIAL_CONFLICT` |
| 7 | `POST /devices/seed` | ADMIN/MANAGER | `clientActionId` + partial unique | `{deliveryItemIds[]}` ≤ 100; re-validates each; returns `{created, skipped, conflicts}` |
| 8 | `POST /visits` | ADMIN/MANAGER | `clientActionId` (`MAINTENANCE_VISIT_CREATE`) | creates the JobCard + visit row atomically; occupancy check; 409 on conflict |
| 9 | `GET /visits/:jobCardId` | actor can reach the job | — | visit facts for the card |
| 10 | `PATCH /visits/:jobCardId` | assignee or management, only `IN_PROGRESS`/`REVISION_REQUESTED` | `expectedVersion` (job) | edits facts, bumps job version, writes activity |

Create body (8): `{clientActionId, deviceId, visitKind, title?, priority, assignedTo,
scheduledAt, scheduledEndsAt?, dueDate?, description?}`. `customerId` is **not accepted**
(derived from the device); `scheduledEndsAt` must be absent or equal the canonical end
(60 min), exactly like `PRODUCT_DELIVERY`/`SALES_MEETING` (`service.ts:1873-1878`).
Default title: `Bakım — <ürün> (<seri no | "seri no yok">)`.

Patch body (10): `{expectedVersion, visitKind?, workPerformed?, sparePartsNote?,
fitnessDecision?}`.

**Disabled / unavailable behaviour (correction to the task wording).** `disabled` is
**404** for the module surface (`overview/service.ts:14-18,97-98`); **unreadable state**
is **503 `MODULE_STATE_UNAVAILABLE`** (`:20-23,95-99`). Slice 1 follows that, with one
deviation for reads (§4.2). Core `/api/job-cards/*` never reads module state.

### 3.4 JobCard integration

| Point | Decision | Anchor |
| --- | --- | --- |
| Type or link | **New `MAINTENANCE` type**; a link on `GENERAL_TASK` cannot deliver occupancy without changing every existing general task (`occupancy.ts:70`) | 03 §3.2 |
| Creation | Module route → module-owned transaction → core port that inserts the job, checks occupancy, claims `clientActionId`, appends activity. The generic create route keeps rejecting the type | `create-input.ts:34-62`, `service.ts:1851-1854` |
| Occupancy | Included via the P1 table; `assertCalendarAvailability` inside the create transaction and the patch/reschedule path | `occupancy.ts:70`, `service.ts:1927-1938`, `:3944` |
| Interval | Required; canonical 60 min at create; patch preserves length and repairs missing intervals | `job-card-duration.ts:42-63`, `service.ts:4043-4070` |
| Offers / early start | **Excluded**; a `NEW` visit is accepted directly by the assignee (`['ACCEPT_ASSIGNMENT','CANCEL']`, `policy.ts:115-127`), START requires `requestTime >= scheduledAt`, and `grantEarlyStartAuthorization` keeps failing closed (`service.ts:5147-5158`) | 03 §3.4; `policy.ts:54-56` |
| Submission readiness | `evaluateMaintenanceSubmission` in `server/src/modules/maintenance/submission.ts`, called from the `MAINTENANCE` branch of `evaluateSubmission`; reader port owned by the module | `submission-policy.ts:358-390`; weekly-report precedent |
| Readiness items | `MAINTENANCE_RECORD_PRESENT`, `MAINTENANCE_DEVICE_PRESENT`, `MAINTENANCE_VISIT_KIND_VALID`, `MAINTENANCE_WORK_SUMMARY_PRESENT`, `MAINTENANCE_FITNESS_DECISION_VALID`, plus the shared `ASSIGNEE_ELIGIBLE` | additive union `types.ts:858-866`; web total Record `job-workflow-presentation.ts:103-121` |
| Approval / cancel / invalidate | Unchanged core approval and revision; approval creates no follow-up, delivery or weekly report (`service.ts:6251-6253,7632-7640`); invalidate is ADMIN-only and keeps the visit row (`:1623-1700`) | `policy.ts:142-146` |
| Customer/contact | Customer derived from device; contact null | `create-input.ts:167-209` pattern |
| Deadline / lateness | Interval end wins in `effectiveSubmissionDeadlineAt` because `scheduledEndsAt` is present; no per-type change needed. `due_date` remains optional for the overdue list | `overdue-incidents.ts:139-141`, `overdue-contract.ts:80-84` |
| Location evidence | Works for free at START/SUBMIT (type-agnostic) | `location-types.ts:33`, `service.ts:6100-6140` |
| Customer delete guard | A device counts as operation history: extend `customerHasAnyJobs`/`hasOperationHistory` and make the 409 message name devices, so the UI does not offer a delete that then fails on the FK | `crm/service.ts:374-407`, `crm/repository.ts:187-193,405-413` |

**Why not a link table on an existing type:** the link would have to be joined by every
reader (board, calendar, reports, occupancy, offboarding) or the row is silently
misclassified — V11 moved from compile time to runtime (03 §3.2).

### 3.5 Web screens (minimal)

| # | Screen / route | Contents | States | Must / later |
| --- | --- | --- | --- | --- |
| W1 | `/maintenance/devices` | search, customer/status/serial-missing filters, pagination, count | loading, empty, error, forbidden (create hidden for STAFF) | must |
| W2 | `/maintenance/devices/:id` | identity, customer link, warranty badge, provenance link, visit history, edit/status (role-gated) | loading, 404, stale-version dialog | must |
| W3 | `/maintenance/devices/seed` | candidate list with checkboxes, `ALREADY_REGISTERED`/`SERIAL_CONFLICT` markers, confirm + result summary | loading, empty ("aday yok"), partial result | must |
| W4 | `/jobs/new-maintenance` | device picker (serial/model/customer search), kind, date/time with slot suggestions, assignee, priority | validation, conflict (`409` + alternatives), module-off | must |
| W5 | Job detail — "Bakım kaydı" panel/tab for `MAINTENANCE` | device summary, kind, work performed, spare parts, fitness decision; edit while `IN_PROGRESS`/`REVISION_REQUESTED`; read-only otherwise | readiness list, version conflict, read-only after submit | must |
| W6–W7 | Customer detail "Cihazlar" panel (later, should); nav entry under the menu (not the bottom bar, UI-004), capability-gated and hidden when off (must) | — | — | — |

Accessibility is a completion criterion (UI-001, PRODUCT.md, WCAG 2.2 AA) and UI-003
requires rendered evidence at **390 px and 1440 px** for W1–W5, with the disabled and
conflict states included. `NEW_JOB_OPTIONS` gains `{key:'maintenance', label:'Bakım
ziyareti', to: paths.newMaintenanceVisit, requires:'maintenance'}` and the three surfaces
(menu, topbar, command palette) must filter on `requires` — the palette has no capability
filter today (`CommandPalette.tsx:150-168`, 06 A41).

### 3.6 Audit and activity events

| Fact | Where | Name | Must / later |
| --- | --- | --- | --- |
| Job created / assigned / started / submitted / approved / revised / cancelled / invalidated | `job_card_activity_logs` | existing events, type-agnostic | must (free) |
| Visit facts edited | `job_card_activity_logs` | **`MAINTENANCE_DETAILS_UPDATED`** (new; union + migration `071:78-121`) | must |
| Device created (manual or seeded) | `audit_events` | **`MAINTENANCE_DEVICE_CREATED`** (metadata `source`) | must |
| Device fields edited | `audit_events` | **`MAINTENANCE_DEVICE_UPDATED`** | must |
| Device status changed | `audit_events` | **`MAINTENANCE_DEVICE_STATUS_CHANGED`** | must |
| Module toggled | `operator_audit_events` | existing `MODULE_STATE_CHANGED` / new `MODULE_STATE_INSTALL_DEFAULTED` | must |

Adding the activity event touches five surfaces (not six; notifications need no new
kind): the union, the activity CHECK, `realtime/event-mapper.ts:21-84` (a missing `TYPES`
entry returns `null`, so no cross-session refresh), `job-labels.ts:225-292` and
`JobTimeline.tsx:24-70` (both total Records → compile errors). The audit names re-issue
the two closed CHECKs (`060:94-99`, `061:52-74`) plus `MAINTENANCE_DEVICE` in
`subject_type`.

---

## 4. Contracts

### 4.1 Registry descriptor entry

```ts
{ key: 'MAINTENANCE', label: 'Bakım', capability: 'maintenance', defaultEnabled: false }
```

`InstallationModuleDescriptor.key` gains `'MAINTENANCE'`, `capability` gains
`'maintenance'`, `legacyEnvKey` becomes optional (absent here: the module was born after
MOD-002), `defaultEnabled` is added. `InstallationModuleKey` is still derived from the
array (`registry.ts:26`), so the union widens automatically.

*Rejected descriptor fields* (03 §7.3): no `prerequisites` (Warehouse is optional), no
`workers`, no `menu`, no `migrationChain`, no `routes`.

### 4.2 Enable / disable semantics

| Concern | Disabled | Re-enabled | Basis |
| --- | --- | --- | --- |
| Devices, visits, provenance, history | kept, untouched, never deleted | unchanged | retention (04 §8) |
| `POST /devices`, `PATCH /devices`, `POST /devices/seed*`, `POST /visits`, `PATCH /visits` | **404** (module surface off) | allowed | `overview/service.ts:14-18` pattern |
| `GET /devices*`, `GET /visits/:id` | **200 — reads stay available** (deviation, see below) | unchanged | 03 §6.2 historical rendering |
| Existing visit lifecycle (accept/start/submit/approve/revise/cancel) | works; core routes never read module state | works | 03 §6.2 hard rule |
| Occupancy of an existing visit | still occupies (it is an active core job) | unchanged | SCH-001 |
| Notification / calendar / reports | unchanged (they read `job_cards`) | unchanged | observed |
| Module state unreadable / row missing | module routes **503**; `/api/auth/me` capability `false` + error log | — | MOD-002 §5 |
| Web nav / create entry | hidden; direct links get 404 on write | returns | capability-driven nav (`navigation-model.ts:89-109`) |

**The deviation:** Overview maps *disabled* to 404 because it has no data to preserve;
Maintenance does. A disabled module must not make a 10-year service record unreadable
from the job card, so I propose read endpoints stay available and only writes are
gated. MNT-001 must confirm; the alternative (strict 404) is simpler but hides history.

### 4.3 Restore

- Add `maintenance_devices` and `maintenance_visits` to the closed `CORE_RELATIONS`
  list (`backup/restore/postgres.ts:11-25`) so a restore fails loudly if either is
  missing (`:289-300` uses `to_regclass` per relation).
- `pg_dump -Fc` is whole-database, so no new backup work.
- Module state returns to the backup instant (MOD-002 §6 / pilot §9): a restore can turn
  Maintenance back on or off; the runbook must say so.
- Optional integrity counter `orphan_maintenance_visits` (belt-and-braces; `pg_restore`
  enforces FKs) — **should**.
- Pre-module backup: tables exist on the new head; first start inserts the `MAINTENANCE`
  row with `INSTALL_DEFAULT`, disabled, one audit event. The "row missing + prior event
  ⇒ fail closed" invariant (`takeover.ts:40-50`) extends to the new event type.

### 4.4 Offboarding

- **No new blocker and no new plan field** — deliberately. The visit is a `job_cards`
  row, so the existing `jobs` plan/transfer covers it (`offboarding.ts:580-596`; only
  `WEEKLY_REPORT`/report-backed rows are excluded at `:591`).
- Transfer re-checks occupancy (`:541-560`), which now includes maintenance visits. A
  transfer onto a busy replacement returns `409 CALENDAR_CONFLICT` and rolls back.
- Devices have `created_by`/`updated_by` only; offboarding deactivates users rather than
  deleting them, so no FK or ownership transfer is needed.
- **Consequence:** the preview hash is unchanged (`:179-193`), so in-flight previews stay
  valid. A later plan owner (`maintenance_plans.owner_user_id`) must use the
  weekly-report blocker pattern (`:1050-1071`), never a silent re-own.

### 4.5 Fresh install

- Migrations create both tables and extend the module CHECKs.
- First start: `OVERVIEW` from env (unchanged); `MAINTENANCE` with
  `source='INSTALL_DEFAULT'`, `enabled=false`, one `MODULE_STATE_INSTALL_DEFAULTED`
  event. No data is fabricated. The operator enables it from `/operator`; the customer's
  ADMIN cannot. Install runbook: "Bakım modülü kurulumda kapalıdır."

### 4.6 Demo data

- The seed query filters `j.data_class='BUSINESS'` (`034:88-98`), so demo deliveries
  never become devices.
- Manual device creation on a demo customer is possible; the purge gains an explicit
  step: delete `maintenance_visits` then `maintenance_devices` for the dataset's
  jobs/customers **before** the job/customer deletes, so the purge does not hit `23503`
  (`demo-data/analyzer.ts:569`). No `data_class` columns on the module tables.
- No demo devices/visits are generated in slice 1.

### 4.7 Reports (DOM-006 safe)

| Report surface | Maintenance behaviour | Anchor |
| --- | --- | --- |
| Open/waiting/revision/overdue counters, approval queue | counted (every type) | `reports/repository.ts:1330-1345` |
| `completed_in_period`, staff completion/execution/on-time | counted | `productiveWorkOnly` `:364` |
| Type buckets (`createdWorkTypeDistribution`, `currentWorkloadByType`, `completionWorkTypes`) | **new `MAINTENANCE` bucket**, added on server and web in the same deploy | `:344,381,533,650`; `jobs-api.ts:38-41`; `reports-api.ts:317-327` |
| Customer report chips | new key; `created` must equal the sum of chips | `:1354-1394`, `reports/types.ts:469-474` |
| Sales follow-up report | unchanged; child buckets stay 3 | `:354`, `reports-api.ts:853-858` |
| Deliveries / meeting outcomes / sales | excluded | `:894,934,1482` |
| Business trend "visits" | excluded (sales visits only); a maintenance series is later | `business-trend.ts:23-28` |
| Money/stock/ranking | never | DOM-001, DOM-006, MOD-001 |

---

## 5. Acceptance tests

Given/When/Then, grouped. Server tests use a provisioned PG17 database
(`cd server && npm run build && npm run test:db -- provision --suffix maint_slice
--write-env`); web states are additionally verified by UI-003 screenshots at 390/1440 px.

### Device registry

| # | Given | When | Then |
| --- | --- | --- | --- |
| T01 | an ADMIN and an active customer with no devices | `POST /api/maintenance/devices` with product, serial, ÜTS, warranty and `clientActionId` | 201; snapshot fields copied; `serialMissing=false`; `MAINTENANCE_DEVICE_CREATED` audit row committed in the same transaction; the identical retry returns the same device |
| T02 | a STAFF user; a device in org A and an ADMIN of org B | STAFF `POST`/`PATCH` a device; the other ADMIN reads/patches it | 403 for the STAFF write; 200 for any org device read; 404 for the cross-org read/patch (never 403 — no existence leak) |
| T03 | a device created without a serial and with a past `warranty_ends_on` | `GET /devices?serialMissing=true` and `GET /devices/:id` | listed with `serialMissing=true` and `warrantyState='OUT_OF_WARRANTY'`, both derived; no serial is invented |
| T04 | a device with product P and serial S | create a second device with the same P+S | 409 `SERIAL_CONFLICT`; no second row |
| T05 | deliveries: one COMPLETED SALE, one SALE on an IN_PROGRESS job, one SAMPLE, one demo dataset | `POST /devices/seed-preview` | only the COMPLETED BUSINESS SALE line is `NEW`; the others are absent |
| T06 | a previewed candidate | `POST /devices/seed` twice with different `clientActionId`s, and once concurrently | first run creates 1; later runs create 0 and report `skipped`; the partial unique prevents duplicates under concurrency |
| T07 | a device with a completed visit | `POST /devices/:id/status {RETIRED}` | 200; the device and its visit history remain; `POST /visits` for it returns 409 |
| T08 | a customer with a manually created device and no jobs | `DELETE /api/customers/:id` (ADMIN) | 409 with a truthful message and `hasOperationHistory=true`; no orphan FK error |

### Visit lifecycle

| # | Given | When | Then |
| --- | --- | --- | --- |
| T09 | an ACTIVE device and a free STAFF | MANAGER `POST /visits` 10:00–11:00 | 201; job `type=MAINTENANCE`, `status=NEW`, interval stored, visit row 1:1, `JOB_CREATED` activity, device link; STAFF detail shows the visit |
| T10 | the visit of T09 | STAFF accepts, starts, `PATCH /visits/:id` with kind/work/fitness, submits, MANAGER approves | readiness met → `WAITING_APPROVAL` → `COMPLETED`; the device detail lists the visit; no follow-up/delivery/sale row is created |
| T11 | a MAINTENANCE visit assigned to STAFF A and STAFF B | B reads `GET /visits/:id` and patches it | 404 for the read and the patch (staff scoping, `policy.ts:37-40`); A succeeds |
| T12 | an `IN_PROGRESS` visit with no `work_performed` | STAFF submits | 400 `VALIDATION_ERROR`, readiness item `MAINTENANCE_WORK_SUMMARY_PRESENT=missing`, job stays `IN_PROGRESS` |
| T13 | a visit in `WAITING_APPROVAL` (and one `COMPLETED`) | `PATCH /visits/:id` | 409 `MAINTENANCE_VISIT_NOT_EDITABLE`; no version bump, no activity |
| T14 | a visit in `REVISION_REQUESTED` | `PATCH /visits/:id` with the current version | 200; activity `MAINTENANCE_DETAILS_UPDATED`; then submit again succeeds |
| T15 | a `MAINTENANCE` JobCard with its visit row deleted by a test fixture | submit | 500 `INVARIANT_VIOLATION` (documents that create is atomic and a missing row is a bug, not a user error) |
| T16 | an `IN_PROGRESS` visit whose device was retired meanwhile | STAFF submits | 200: readiness checks device **existence**, not status, so an existing visit is never deadlocked |
| T17 | a create request with `clientActionId=X` | send it twice, then concurrently | duplicate returns the original job id/response; concurrent duplicate returns 409 `ACTION_IN_PROGRESS`; exactly one job and one visit row |
| T18 | an `IN_PROGRESS` visit at version 7 | `PATCH /visits` with `expectedVersion=6` | 409 `VERSION_CONFLICT` with `currentVersion:7`; no partial write |
| T19 | an inactive customer with an existing device | MANAGER creates a visit | 201 (installed base must still be serviced); `POST /devices` for that customer → 409 |
| T20 | a `NEW` `MAINTENANCE` visit | STAFF presses start 5 minutes early | 409 (no early-start tolerance for this type); at the planned time → 200 |

### Occupancy and calendar

| # | Given | When | Then |
| --- | --- | --- | --- |
| T21 | a `SALES_MEETING` 10:00–11:00 for STAFF S | create a MAINTENANCE visit 10:30–11:30 for S | 409 `CALENDAR_CONFLICT` with `details.conflicts[]` naming the meeting; no job/visit row |
| T22 | a MAINTENANCE visit 10:00–11:00 for S | create a `SALES_MEETING` 10:30–11:30 for S | 409 — proving the visit is in the shared occupancy source, not only a check |
| T23 | the same setup with the Calendar module **disabled** | both writes above | same 409s (SCH-001: occupancy is core, `DECISIONS.md:3694-3701`) |
| T24 | a free STAFF and a device | `POST /available-slots {type:'MAINTENANCE', scheduledAt}` | 200 with same-day suggestions using the 60-minute duration; a maintenance job appears as a conflict source in a second call |
| T25 | a MAINTENANCE visit | `GET /calendar?from&to` | the event has a 60-minute `ends_at`, not a point event (`calendar/repository.ts:61-65`) |

### Module state

| # | Given | When | Then |
| --- | --- | --- | --- |
| T26 | Maintenance disabled by the operator | `POST /visits`, `POST /devices`, `POST /devices/seed` | 404; `GET /devices` and `GET /visits/:id` still 200; nav/create entry hidden; an existing visit still starts/submits/approves |
| T27 | the state row deleted (simulated partial restore) | any module route; `/api/auth/me`; job detail | module routes 503 `MODULE_STATE_UNAVAILABLE`; capability `maintenance:false`; job detail 200 and its lifecycle still works |
| T28 | devices and visits exist | operator disables, restarts, re-enables | no row changed or duplicated; writes work again; exactly one `MODULE_STATE_CHANGED` per real change |
| T29 | the module row | operator `PUT /api/operator/modules/MAINTENANCE` with a stale version | 409 `MODULE_VERSION_CONFLICT`, no audit row; current version + same value → 200, no audit |

### Offboarding

| # | Given | When | Then |
| --- | --- | --- | --- |
| T30 | STAFF A has an `ACCEPTED` visit 10:00–11:00; STAFF B is free | ADMIN offboards A with transfer to B | 200; visit `assigned_to=B`, version bumped, `JOB_ASSIGNED` activity, visit row untouched, no module blocker |
| T31 | same, but B is busy 10:30–11:30 | offboard A with transfer to B | 409 `CALENDAR_CONFLICT`; the whole offboarding rolls back (A still active, visit still A) |
| T32 | a pending offboarding preview from before the release | open the preview after the slice | the hash/plan shape is unchanged (no new field), so the preview is still valid |

### Restore and fresh install

| # | Given | When | Then |
| --- | --- | --- | --- |
| T33 | a backup containing devices and visits | restore into a disposable database | restore verification passes only with both relations present; counts match; no orphan visit |
| T34 | a backup taken before this module existed | restore to the new head and start | the `MAINTENANCE` row is created disabled (`INSTALL_DEFAULT`) with one audit event; no device/visit rows; startup does not fail closed |
| T35 | Maintenance enabled, backup, then disabled | restore | after restore the module is enabled again (state returns to the backup instant) — documented runbook behaviour |

### Reports and demo data

| # | Given | When | Then |
| --- | --- | --- | --- |
| T36 | one completed MAINTENANCE visit and one completed `GENERAL_TASK` in a period | `GET /api/reports/dashboard` | `completed_in_period=2` and the type buckets sum to 2, including a `MAINTENANCE` bucket; deliveries/meetings/sales unchanged |
| T37 | the same period | sales follow-up report; business trend; customer report | follow-up child buckets remain 3; the visit is not a "visit"; customer `created` equals the sum of its type chips |
| T38 | a demo dataset with deliveries | seed preview; then purge the dataset | preview lists nothing demo; purge succeeds with no `23503` and leaves no module rows |

### Compile-time and dispatch guarantees

| # | Given | When | Then |
| --- | --- | --- | --- |
| T39 | the P1 table and the `MAINTENANCE` entry | add a scratch literal `'MAINTENANCE_TEST'` to `JOB_CARD_TYPES` in a throwaway branch and run `cd server && npm run build` | `tsc` fails naming every total dispatch (behaviour table, follow-up defaults, submission `never`); recorded in the PR, not committed as a passing test |
| T40 | the committed tree | run the dispatch coverage test | `Object.keys(JOB_TYPE_BEHAVIOUR)` equals `JOB_CARD_TYPES`; the occupancy SQL `IN` list equals the planned-interval set; `getAllowedJobActions` covers every type |
| T41 | the committed tree | run the source guard test | `submission-policy.ts` still contains `assertNeverJobCardValue(jobCard.type, 'type')` (or the `never` assignment) and `policy.ts` still contains the status `assertNeverJobCardValue` — a merge that drops V11 fails CI |
| T42 | server and web type lists | run `node ops/tests/job-type-parity.test.mjs` | the server `JOB_CARD_TYPES` set equals the web `JOB_CARD_TYPES` set; a one-sided edit fails CI |

---

## 6. Risks and explicit non-goals

### 6.1 Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | The type PR blanks every web surface if the web list/labels are not mirrored (strict `oneOf` → `INVALID_RESPONSE`, 06 §3.1) | P5a/P5b same deploy + T42 parity check; module stays off until the slice ships |
| R2 | The weekly-report branch (or a later revert) drops the submission `never` and V11 reopens | P2 merge rule + T41 source guard |
| R3 | "Half on-site": occupancy updated but slots/calendar/preview stay stale | P1 single table + T40 coverage test |
| R4 | A maintenance visit with no interval could reach START and occupy nothing | interval required at create; R3 invariant from `hasValidPlannedInterval`; patch repair path |
| R5 | Reports arithmetics break (`created` > sum of chips; totals ≠ parts) | P4 decoupling + bucket added on both sides + T36/T37 |
| R6 | `ALTER TABLE job_cards DROP/ADD CONSTRAINT job_cards_type_check` takes an ACCESS EXCLUSIVE lock; on a large table the deploy pauses writes (**UNVERIFIED** duration, 03 §10) | deploy in a low-traffic window; state it in the release note |
| R7 | Seed proposes mostly serial-less devices (no UI ever wrote `serial_no`, 02 §2.2) | "seri no eksik" list; never guess; manual completion workflow |
| R8 | The module gate blocks corrective visits mid-warranty when disabled | MNT-001 decides; the runbook says "kapatma = yeni bakım kaydı durur, mevcut işler sürer" |
| R9 | Device status drifts from reality (`IN_SERVICE` forgotten) | manual status only, audited; a job never auto-changes device status; a stale-status report is a later slice |
| R10 | Core imports a module evaluator for submission (dependency direction) | narrow port + module-owned evaluator, same shape as the weekly-report precedent; no module import of `job-cards/service.ts` |
| R11 | The clinic counter-signature is not represented, so the record is weaker than the regulation's report (04 §9.3) | documented gap; the signature/report slice follows; manager approval is not presented as a signature |
| R12 | 10-year retention with personal data (technician name) vs KVKK | no hard delete; names are user references; a minimisation design is a later decision (04 §8) |
| R13 | The offboarding transfer now conflicts on maintenance visits, which can surprise operators | acceptance T31 + release note |
| R14 | Demo purge can hit a module FK | T38 + explicit purge ordering |

### 6.2 Non-goals (explicit)

- **Stock/warehouse and Accounting**: no quantity, balance, reservation, movement or
  stock status; no invoice, service price, contract, SLA or renewal value. Parts are a
  free-text note (MOD-001 §2–§3, DOM-001).
- **ÜTS integration**: 04 §4.5 shows it is not required for compliance; store-only
  identifiers. No token, no e-signature custody, no `verme` automation.
- **Calibration execution**: a separate TİTCK regime (04 §6); store references later.
- **PDF report, digital/wet signature capture, checklists, measurements, photos**:
  deferred (no file storage exists; `PRODUCT_REQUIREMENTS.md:424`).
- **Plans, due dates, recurring visits, workers, notifications; assignment offers, early
  start, follow-ups from a visit**.
- **A second approval gate, a new role, a new customer type, a customer portal** (roles
  are ADMIN/MANAGER/STAFF; no customer identity exists).
- **A new delivery purpose `MAINTENANCE`** (DOM-001).
- **Warranty accumulator / annual max repair time / 45-day refund clock** (04 §5.2):
  deferred but listed as a known legal gap, not silently dropped.

---

## 7. Open questions for the owner (ranked by impact on the slice)

1. **Is a maintenance visit an occupancy-bearing planned interval?** (A1) If no, slice 1
   becomes the fallback in §1.4 and P1–P5 are deferred — this changes the size by ~2×.
2. **Does a visit require manager approval?** (A2) If no, the core lifecycle needs a
   type-aware bypass and DOM-006's completion definition changes.
3. **Module switch or always-on?** (A9) If always-on, P6 disappears but there is no
   operator control.
4. **Who creates visits?** (A7) Manager-only keeps the surface small; a technician who
   cannot open a corrective visit at the clinic is an operational gap.
5. **Duration, site, status** (A3/A8): 60 min fixed? free-text location or
   `maintenance_sites` (03 §4.2)? is `IN_SERVICE` needed in slice 1?
6. **Reports** (A11): bucket maintenance as productive work (my assumption) or show it
   only on a dedicated route?
7. **Disabled semantics** (§4.2): reads stay available (my proposal) or strict 404?
8. **Parts**: free-text note now, or no parts field until Warehouse?
9. **Demo data and warranty dates**: purge module rows with the dataset (my assumption)
   or block the purge? Are warranty dates mandatory on manual create?
10. **Type literal and ÜTS fields**: `MAINTENANCE` (label "Bakım") is right? Is
    `uts_barcode_no` enough for slice 1, or is `nameplate_no` needed?

---

## 8. Unverified items

- **Nothing was executed.** No build, test, migration, database or browser. Compiler
  claims are read from type declarations/branch diffs; T39 is proposed, not a result.
- **PR #513 and the weekly-report branch** were read via `git log`/`git show`; GitHub
  state, review comments and mergeability are UNVERIFIED.
- **`ALTER TABLE … ADD CONSTRAINT` lock cost** on a production-sized `job_cards` is
  UNVERIFIED (no DB access).
- **Serial coverage in production** is unknown; 02 proved only that no UI writes it.
- **Demo purge FK order** was not executed; the proposal adds an ordering step but does
  not prove the current analyzer fails without it.
- **`staticModuleStateReader` test usage** was read, not exercised; a per-key record may
  surface assumptions I did not enumerate.
- **Offboarding preview hash** fields were read but not recomputed; T32 is proposed.
- **`exactRecord`/`CREATE_FIELDS_BY_TYPE` behaviour** is read; no request was sent.
- **Owner answers A1–A12** are assumptions; MNT-001 does not exist yet.

---
