# 06 — Cross-module and web impact of a `MAINTENANCE` JobCard type

Research only. Nothing here is implemented, approved, or authorized.
Baseline: `origin/main` @ `89bf6b1`. All `path:line` references are against that
commit unless another ref is named.

## Summary

1. The **server type list is a single constant** (`server/src/modules/job-cards/types.ts:29`)
   and most server modules consume it *by value* (`JOB_CARD_TYPES.includes(...)`) or
   *negatively* (`type <> 'WEEKLY_REPORT'`). That makes roughly two thirds of the server
   surface accept `MAINTENANCE` silently and **correctly by accident**.
2. The dangerous server side is not the type union: it is **five hard-coded
   `('SALES_MEETING','PRODUCT_DELIVERY')`-style predicates** (occupancy, planned-interval,
   assignment-offer, calendar end time, canonical duration). A maintenance visit would be
   treated as an **open-ended GENERAL_TASK**: no occupancy, no `409 CALENDAR_CONFLICT`, no
   assignment acceptance offer, no duration, and a zero-length calendar event. This
   contradicts SCH-001's "active on-site jobs occupy the assignee" intent.
3. The **web keeps its own copy of the type list** (`web/src/jobs/jobs-api.ts:38-53`).
   That copy is used by **strict** response parsers (`oneOf(..., JOB_CARD_TYPES)`), so a
   `MAINTENANCE` row from the server does not degrade to a missing label — it throws
   `INVALID_RESPONSE` and the **entire list/detail payload fails to render**.
4. Reports are **inconsistent by construction**: four SQL bucket lists are *closed*
   (4 hard-coded types) while one overview read is an *open* `GROUP BY j.type`. A
   maintenance visit is counted in totals and in Overview's chips but invisible in every
   other type-labelled breakdown — totals stop equalling their parts.
5. Notifications, web-push, realtime, messaging, products and audit have **no type
   coupling**; they stay safe as long as the JobCard lifecycle events do not change.
6. Two in-flight branches interact: PR #513 makes submission-readiness dispatch exhaustive
   but leaves the five predicates above non-exhaustive, and
   `origin/refactor/weekly-report-submission` rewrites `submission-policy.ts` into a
   fall-through. Merge order decides whether V11 stays closed.
7. The working hypothesis (**assignment/lifecycle/approval in JobCard; device service
   history in Maintenance**) **matches the code**, with one correction: the *visit* itself
   must stay in JobCard — occupancy, approval, activity log, report counters and offboarding
   transfer all key off `job_cards` rows.

---

## 0. Method, scope and classification key

**Sweep commands** (read-only, against `89bf6b1`):

```bash
rg -n "JobCardType|JOB_CARD_TYPES|SALES_MEETING|PRODUCT_DELIVERY|GENERAL_TASK|WEEKLY_REPORT" \
   server/src --glob '!server/src/modules/job-cards/**'
rg -n "JobCardType|JOB_CARD_TYPES|SALES_MEETING|PRODUCT_DELIVERY|GENERAL_TASK|WEEKLY_REPORT" web/src
rg -rn "createdWorkTypeDistribution|currentWorkloadByType|PRODUCTIVE_JOB_CARD_TYPES" web/scripts
```

Every file with a hit was read. Files inside `server/src/modules/job-cards/` are cited
**only** as the producer of an outside effect.

**Premise used throughout.** "What `MAINTENANCE` gets today" means: *if one entry were
added to `JOB_CARD_TYPES` (`types.ts:29`) and nothing else changed* — the cheapest possible
change and therefore the realistic accident.

**Class key**

| Class | Meaning |
| --- | --- |
| **A** | Must become exhaustive (or be explicitly decided) **before** `MAINTENANCE` may be created. Today it is a silent wrong behaviour, a runtime parse failure, or a required-but-missing artifact. |
| **B** | Needs a product decision: does maintenance count as this thing? Currently produces a defensible-but-arbitrary default. |
| **C** | Safe default. Works without change; listed so the reader knows it was checked, not skipped. |

**Observed vs. inference.** Table rows are *observed* (the code says this). Rows marked
→ are the *inference* of what would happen. Anything I could not execute is in
"Unverified items".

---

## 1. Table of every hit outside `server/src/modules/job-cards/`

### 1.1 Reports (`server/src/modules/reports/`, DOM-006)

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| R1 | `reports/repository.ts:344` | `PRODUCTIVE_WORK_TYPES` = 4 literal types | Not a member → excluded from every closed bucket | **A** |
| R2 | `reports/repository.ts:345-351` | `workTypeBucketsSql()` renders those 4 as a `VALUES(type, sort_order)` CTE | No `MAINTENANCE` row in the CTE → no bucket at all, not even a zero | **A** |
| R3 | `reports/repository.ts:381` | `work_types` CTE in `STAFF_SUMMARY_SQL` → `current_workload_by_type` | Maintenance workload absent from a staff profile's type breakdown while still counted in `open_job_cards` (`:386-390`) | **A** |
| R4 | `reports/repository.ts:533` | `work_types` CTE in `DASHBOARD_SQL` → `created_work_type_distribution` | Maintenance creations absent from the dashboard type bars | **A** |
| R5 | `reports/repository.ts:650` | `work_types` CTE in the staff completion/performance aggregate | Maintenance completions absent from `completionWorkTypes` | **A** |
| R6 | `reports/repository.ts:354,1482` | `FOLLOW_UP_CHILD_WORK_TYPES` = 3 types for the sales-follow-up report | No `MAINTENANCE` child bucket (correct today: follow-ups are SM/GT) | C |
| R7 | `reports/repository.ts:364` | `productiveWorkOnly(a)` = `` `${a}.type <> 'WEEKLY_REPORT'` `` | **Included** in completion/execution/on-time totals | C → but creates the R1-vs-R7 mismatch (**B**) |
| R8 | `reports/repository.ts:1352,1369` | Customer report `active`, `created` — no type filter | Maintenance counted in both | C |
| R9 | `reports/repository.ts:1354-1394` | Customer report per-type `FILTER (WHERE jc.type = '…')` × 4 | No maintenance counter → `created` > Σ `createdWorkTypes` | **B** |
| R10 | `reports/types.ts:469-474` | `createdWorkTypes` is a **closed object type** (`PRODUCT_DELIVERY`, `GENERAL_TASK`, `SALES_MEETING`, `SALE?`) | Compile error only if someone *tries* to add it; silent omission otherwise | **A** |
| R11 | `reports/types.ts:432-435` | `WorkTypeDistributionItem.type: string` (untyped) | Tolerant; accepts any string | C |
| R12 | `reports/repository.ts:2503-2513` | `getWorkTypeDistribution` — open `GROUP BY j.type … LIMIT 10` | **Includes** `MAINTENANCE` automatically (used by Overview only) | C → inconsistent with R2 (**B**) |
| R13 | `reports/repository.ts:764-768` | `STAFF_ON_TIME_SQL` deadline: `scheduled_ends_at`, else `NULL` for `SALES_MEETING`, else `scheduled_at` | Maintenance falls into `ELSE scheduled_at` → a **point-in-time deadline**, not the planned interval end | **B** |
| R14 | `reports/repository.ts:894` | `getStaffDeliveriesByPurpose` — `jc.type = 'PRODUCT_DELIVERY'` | Not a delivery → no quantity rows (correct) | C |
| R15 | `reports/repository.ts:934` | `STAFF_MEETINGS_BY_OUTCOME_SQL` — `jc.type = 'SALES_MEETING'` | Not a meeting outcome | C |
| R16 | `reports/repository.ts:1494,1514,1547,1568,1579,1666,1675,1679` | Sales-follow-up report: `jc.type = 'SALES_MEETING'` (queue, status distribution, outcomes, proposals) | Excluded | C |
| R17 | `reports/repository.ts:1330-1345` | `APPROVAL_SUMMARY_SQL` — status-only | Maintenance in `WAITING_APPROVAL` counted (DOM-006: approval queue includes every type) | C |
| R18 | `reports/repository.ts:367-369`, `business-trend.ts:28-33` | `saleReadableJobsSql` excludes `SALE` when capability is off; `sales` CTE = `j.type='SALE'` | Unaffected | C |
| R19 | `reports/business-trend.ts:23-27` | `visits` CTE — `j.type = 'SALES_MEETING' AND status='COMPLETED'`, keyed on `meeting_at` | A maintenance visit is **not a visit** in the business trend | **B** |
| R20 | `reports/service.ts`, `handlers.ts`, `query.ts`, `routes.ts:25-44` | 11 report routes; query parsing is type-agnostic | Unaffected | C |

### 1.2 Overview (`server/src/modules/overview/`)

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| O1 | `overview/repository.ts:45-66,68-84` | `RECENT_COMPLETED_SQL` — `status='COMPLETED' AND type <> 'WEEKLY_REPORT'`; `RECENT_NOTES_SQL` — `status <> 'INVALIDATED'` | Appears in "recently completed work" and in "recent notes" | C |
| O3 | `overview/service.ts:54-70` | `workTypeDistribution` delegated to `ReportsReadModel.getWorkTypeDistribution` (open group-by, R12) | **Appears**, so Overview and the Reports dashboard disagree about the same period | **B** |
| O4 | `overview/types.ts:47-50` | `WorkTypeDistributionItem.type: string` | Tolerant | C |
| O5 | `overview/service.ts:41-46` | `upcomingWork` only while `calendarEnabled` | Unaffected | C |
| O6 | `overview/service.ts:91-101` | `assertEnabled` reads `OVERVIEW` from `ModuleStateReader`, 503 on read failure | The MOD-002 pattern a Maintenance module must copy | C |

### 1.3 Calendar (`server/src/modules/calendar/`)

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| C1 | `calendar/repository.ts:63-64` | `CASE WHEN j.type IN ('SALES_MEETING','PRODUCT_DELIVERY') THEN j.scheduled_ends_at ELSE NULL END AS ends_at` | `ends_at = NULL` → the maintenance event renders as a **zero-length/point event** even if `scheduled_ends_at` is stored | **A** |
| C2 | `calendar/repository.ts:125-127`, `calendar/service.ts`, `validation.ts`, `types.ts` | `job_type === 'GENERAL_TASK' ? null : row.ends_at`; manual-event CRUD (`calendar_events`) | Negative test only; manual events are not job types | C |
| C3 | `calendar/repository.ts:95-104` | List window filter keys on `scheduled_at` / `scheduled_ends_at`, status in 5 active statuses | A maintenance job **with** an interval is selected; without one it is a point event | C |
| C4 | `calendar/repository.ts:157-159` | `sourceOccurredAt`: `SALES_MEETING` → `meeting_at`, else `started_at` → `staff_completed_at` | Maintenance source facts come from `started_at` (acceptable) | C |
| C5 | `calendar/reminder-worker.ts` | Claim/notify `calendar.reminder_due`; `entity_type` is `job-card \| calendar-event` only | No type coupling | C |

**Occupancy (inside job-cards, decisive for the outside modules).**
`server/src/modules/job-cards/occupancy.ts:70-71` is SCH-001's single occupancy definition
and it hard-codes `j.type IN ('SALES_MEETING','PRODUCT_DELIVERY')` plus
`AND j.scheduled_ends_at IS NOT NULL`. A `MAINTENANCE` job would therefore **not occupy**
its assignee: create, reschedule, proposal approval and offboarding transfer would all
accept a double booking. SCH-001 item 1 also *names* only those two types, so adding
`MAINTENANCE` is a **policy amendment**, not an implementation detail.

### 1.4 Notifications, web-push, realtime, messaging

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| N1 | `notifications/policy.ts:35-77` | Recipient/kind mapping keyed on **activity event** (`JOB_CREATED`, `JOB_ASSIGNED`, `JOB_APPROVED`, …, `JOB_SUBMISSION_AUTO_ESCALATION_SENT`) | Every existing event fires for `MAINTENANCE` with the same recipients | C |
| N2 | `notifications/types.ts:6-30` | `NOTIFICATION_KINDS` — 21 kinds, **none type-specific** | No new kind needed | C |
| N3 | `notifications/presenter.ts:13-40` | Turkish title/body per `NotificationKind` (`NOTIFICATION_MESSAGES`) | Generic copy ("Bir iş kaydı…") is correct for a maintenance visit | C |
| N4 | `notifications/policy.ts:81-96`, `web-push/service.ts`, `dispatcher.ts`, `sender.ts` | Note-added drafts (assignee + management); outbox delivery | Unaffected | C |
| N5 | `web-push/payload.ts:20-43` | `url` by **entity** type: `job-card` → `/jobs/:id` | Unaffected (entity, not job type) | C |
| N6 | `realtime/event-mapper.ts:21-60` | `JobCardActivityEvent` → `job.updated` / `job.assignment_changed` / … | Unaffected **only if** no new lifecycle event is introduced for maintenance | C |
| N7 | `realtime/audience.ts:12-24` | Audience = `[ADMIN, MANAGER]` + after/before assignee | Unaffected | C |
| N8 | `realtime/repository.ts:41-73` | SALE / `SALES_MEETING` origin scoping (`sale-origin-context`) | Unaffected while a maintenance visit cannot originate a SALE | C |
| N9 | `messaging/service.ts:170,308,376,1191,1262,1286` | Raw SQL reads `job_cards.title/status/assigned_to` for access + labels | Unaffected | C |
| N10 | `messaging/repository.ts:479,642,772` | `LEFT JOIN job_cards` for conversation context | Unaffected | C |

**Answer to question 4: no notification kind is type-specific.** The only place a job type
could leak into notification copy is `presenter.ts`, and it does not.

### 1.5 People / offboarding

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| P1 | `people/handlers.ts:144` | Transfer decision `type` validated with `JOB_CARD_TYPES.includes(...)` | Accepted automatically | C |
| P2 | `people/offboarding.ts:42-48,591-593,1052-1058` | `WEEKLY_REPORT` is the only non-transferable type (`type <> 'WEEKLY_REPORT'` guard) | Maintenance jobs transfer normally | C |
| P3 | `people/offboarding.ts:541-560` | Transfer reads `j.type, scheduled_at, scheduled_ends_at, occupied_ends_at` and re-checks occupancy | Maintenance has no interval → **no occupancy conflict raised on transfer** | **B** (follows from occupancy) |
| P4 | `people/offboarding.ts:777-783,1062-1070` | Transfer offer carries `type: JobCardType`; `OFFBOARDING_WEEKLY_REPORT_REQUIRES_RESOLUTION` names only weekly reports | Passes through; the blocker message stays accurate | C |

### 1.6 Weekly reports (`server/src/modules/weekly-reports/`)

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| W1 | `weekly-reports/validation.ts:249-253`, `source-work.ts:44-46` | Source-work snapshot type: `JOB_CARD_TYPES.includes(t) && t !== 'WEEKLY_REPORT'` (validate + read path) | Accepted as source work automatically | C |
| W3 | `weekly-reports/types.ts:48-56` | `SourceWorkSnapshotItem.type: JobCardType` | Frozen snapshot keeps the literal | C |
| W4 | `weekly-reports/types.ts:22-46` | Sections are **fixed** (`summary`, `blockers`, `nextWeekPlan`, `highlights`, `fieldObservations`, `supportNeeded`) and questions are manager-defined | **No per-type section exists**; nothing to add for `MAINTENANCE` | C |
| W5 | `weekly-reports/repository.ts:302` | Report create rejects `jobRow.type !== 'WEEKLY_REPORT'` | Unaffected | C |

**Note.** The web renders the source-work type through the fail-soft
`jobTypeLabel()` (`web/src/jobs/job-labels.ts:41-43`), so a `MAINTENANCE` source-work row
would show **"Diğer"** rather than crashing — the only surface that degrades gracefully.

### 1.7 Customers / CRM, products, auth setup

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| M1 | `crm/handlers.ts:116-117` | Customer job-history `?type=` validated with `JOB_CARD_TYPES.includes(...)` | Filterable by `MAINTENANCE` automatically | C |
| M2 | `crm/service.ts:164-198` | History read delegated to `jobHistoryReadPort`; `getCustomerOperationalSummary` via the port — no type logic | Maintenance visits appear in customer history | C |
| M4 | `products/repository.ts:92-95,169-172` | Product delete/activate blocked by `job_card_delivery_items` / `job_card_sale_items` rows | A maintenance job references a **device**, not catalog products → no new block | C |
| M5 | `auth/setup.ts:21,187-191` | Install bootstrap reference job is hard-typed `{ type: 'PRODUCT_DELIVERY' }` | Cannot be a maintenance job (probably desirable) | C |

### 1.8 Demo data, backup/restore, audit

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| D1 | `demo-data/repository.ts:1112`, `analyzer.ts`, `types.ts` | Local union `'PRODUCT_DELIVERY' \| 'GENERAL_TASK' \| 'SALES_MEETING'` for 8 demo cards; purge planning has no job-type references | Unaffected (demo set stays 3 types) | C |
| D2 | `demo-data/repository.ts:1178-1188` | `if (type==='SALES_MEETING' \|\| type==='PRODUCT_DELIVERY')` then `canonicalScheduledDurationMs(def.type)!` (non-null assertion) | **Trap:** extending the local union without extending that `if` (or the duration table) yields `startedAt - null` = a zero-length interval, silently | **A** |
| D4 | `backup/restore/postgres.ts:11-25` | `CORE_RELATIONS` — closed table list used for integrity counts (`:297-341`) | JobCard type change is invisible; **new Maintenance tables are not verified** by restore | **B** (module scope) |
| D5 | `operator/restore-reset.ts`, `operator/repository.ts` | Restore revokes operator sessions; module state re-grant | A Maintenance module needs the same treatment | **B** |
| D6 | `products/types.ts:78`, `crm/types.ts:170` | Per-module audit event vocabularies (`PRODUCT_AUDIT_EVENTS`, `CRM_AUDIT_EVENTS`) | There is **no shared audit module**; a Maintenance module that writes its own audit must define its own list | **B** |

### 1.9 Installation modules / operator (MOD-002) — the module gate

| # | file:line | What it does with the type/module | What a Maintenance module needs | Class |
| --- | --- | --- | --- | --- |
| I1 | `installation-modules/registry.ts:7-16` | `InstallationModuleDescriptor.key: 'OVERVIEW'`, `capability: 'overviewDashboard'`, `legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED'` are **literal types** | Widen to a union member; add `MAINTENANCE` descriptor | **A** |
| I2 | `installation-modules/registry.ts:18-25` | `INSTALLATION_MODULES` — one entry, `satisfies readonly InstallationModuleDescriptor[]` | Add entry | **A** |
| I3 | `installation-modules/state.ts:5-30` | `ModuleStateRow.key: InstallationModuleKey`, typed reader `read(key)` | Type-checked; works once I1 changes | **A** |
| I4 | `installation-modules/state.ts:66-78` | `readModuleEnabledOrFalse` — fail-closed, no env fallback | Reuse for the capability projection | C |
| I5 | `db/migrations/074_installation_operator_and_module_state.sql:59` | `CHECK (module_key IN ('OVERVIEW'))` | **New migration required**; also `:87` `operator_audit_events.module_key` CHECK | **A** |
| I6 | `db/migrations/074…sql:34` | `operator_account_capabilities.capability IN ('MODULE_MANAGEMENT')` | Only if the operator needs a new capability | **B** |
| I7 | `installation-modules/takeover.ts:21,29-35` | `legacy: { overviewDashboard: boolean }`; one-time env → DB takeover, `MODULE_STATE_TAKEN_OVER` audit | A new module either gets a legacy env key here or starts from a fresh default | **A** |
| I8 | `capabilities/types.ts:1-8` | `AuthenticatedCapabilities` (`overviewDashboard`, `calendar`, `messaging`, `backup`, `demoDatasetCreation`) | Add `maintenance?: boolean` (pattern: optional) | **A** |
| I9 | `capabilities/service.ts:7-13,24-31,33-52` | `DEFAULT_CAPABILITIES` + `withOverviewDashboard` projection + `authenticatedUser` | Add the analogous projection | **A** |
| I10 | `server/src/app.ts:198-202,254-276,618-628` | `moduleStateReader` dependency; per-service gate injection | New gate + wiring | **A** |
| I11 | `ops/ci/verify-env-examples.sh:58-82` | Staging flag policy hard-codes `OVERVIEW_DASHBOARD_ENABLED`, `MESSAGING_ENABLED`, `CALENDAR_ENABLED`, `WEB_PUSH_ENABLED`, `ACTION_SCOPED_GEOLOCATION_ENABLED` | A new `MAINTENANCE_ENABLED` legacy key must be added here or CI stays green while the example drifts | **A** |
| I12 | `docs/features/operator-module-pilot.md:77-79,155-158` | Contract: `GET /api/operator/modules` → `[{key,label,enabled,version,updatedAt}]`; `/api/auth/me` projects the capability; fail-closed 503 | The exact contract a Maintenance module inherits | C |

### 1.10 Web client (`web/src`)

**The duplicated type list — see §3.**

| # | file:line | What it does with the type | What `MAINTENANCE` gets | Class |
| --- | --- | --- | --- | --- |
| A1 | `jobs/jobs-api.ts:38-41` | `PRODUCTIVE_JOB_CARD_TYPES` — **web's own copy**, 4 literals | Not a member | **A** |
| A2 | `jobs/jobs-api.ts:53` | `JOB_CARD_TYPES = [...PRODUCTIVE_JOB_CARD_TYPES, 'WEEKLY_REPORT']` | Not a member | **A** |
| A3 | `jobs/jobs-api.ts:170` | `JobCardType` derived from that web array | Diverges from the server union | **A** |
| A4 | `jobs/jobs-api.ts:1085-1088` | `parseJobCard` → `oneOf(v.type, 'type', JOB_CARD_TYPES)` | **Throws `INVALID_RESPONSE`**; the whole detail payload fails | **A** |
| A5 | `jobs/jobs-api.ts:1133-1136` | `parsePersistedJobCardListItem` → same strict `oneOf` | **Throws**; the whole jobs list / board / filters fail | **A** |
| A6 | `jobs/jobs-api.ts:977,1012,1034,1046,1078` | Follow-up source, proposal, conflict, recent-visit, suggestion parsers — all strict `JOB_CARD_TYPES` | **Throws** in the follow-up drawer and conflict panel | **A** |
| A7 | `jobs/jobs-api.ts:422-436` | `JobCardCreateInput` — closed discriminated union of 3 types | Compile error when a create path is added (good) | **A** |
| A8 | `jobs/jobs-api.ts:411-421` | `FollowUpCreateInput` — 3 types | Compile error | **A** (B if maintenance follow-ups are wanted) |
| A9 | `jobs/jobs-api.ts:659` | `AUTO_SCHEDULABLE_FOLLOW_UP_TYPES = ['SALES_MEETING']` | Excluded (correct) | C |
| A10 | `jobs/job-labels.ts:17-23` | `Record<JobCardType, string>` Turkish labels (`Ürün teslimi`, `Genel görev`, `Satış görüşmesi`, `Haftalık rapor`, `Satış kaydı`) | **Compile error** — the good failure mode | **A** |
| A11 | `jobs/job-labels.ts:26,41-43` | `UNKNOWN_JOB_TYPE_LABEL = 'Diğer'`; `jobTypeLabel(unknown) → 'Diğer'` | Graceful only where this helper is used (weekly-report source work) | C |
| A12 | `jobs/job-workflow-presentation.ts:706-718` | `scheduleFieldLabel` — `switch (type)` with **no `default`**, returns `string` | `undefined` (see §3.3) → **blank schedule label** | **A** |
| A13 | `jobs/JobApprovalReviewPanel.tsx:15-30` | `typeAwareSummary` — `switch (job.type)` with **no `default`**, returns `string` | `undefined` → blank approval summary line | **A** |
| A14 | `jobs/job-workflow-presentation.ts:722-730,739-792` | `deriveScheduleEdit`, `deriveRecordEditAction` — type branches with `return null` fallbacks | No schedule-edit form, no record-edit action | **B** |
| A15 | `jobs/job-workflow-presentation.ts:192-204,663` | `SALES_MEETING`-specific engagement/next-step wording | Falls into generic wording | C |
| A16 | `jobs/JobFilters.tsx:186-187` | Type filter renders `Object.entries(jobTypeLabels)` | New option appears **automatically** once A10 is fixed | C |
| A17 | `jobs/job-search.ts:51` | `const TYPES = JOB_CARD_TYPES` — URL `?type=` validation | Accepts `MAINTENANCE` automatically after A2 | C |
| A18 | `jobs/job-schedule-integrity.ts:14-16` | `isPlannedIntervalJobType` — second copy of the interval predicate | `false` → `plannedIntervalShape` returns `NOT_APPLICABLE` → **no "Planlanmadı" signal**, no START interval requirement | **A** |
| A19 | `jobs/scheduling.ts:9-12` | `CANONICAL_DURATION_MINUTES` `Partial<Record<…>>` = `{SM:60, PD:30}` | `undefined` → no auto-end on create; form requires manual end | **B** |
| A20 | `jobs/scheduling.ts:310-319` | `cardScheduleFact` — label by type, `SALES_MEETING` skipped for "Bugün" | Generic `Planlanan zaman`; "Bugün" branch applies | C |
| A21 | `jobs/workflow-lanes.ts:8-23` | Kanban lanes = **5 active statuses**, not types | Maintenance cards appear in the normal lanes | C |
| A22 | `jobs/JobBoard.tsx:33-36,68-72` | Card type label + `PRODUCT_DELIVERY`-only delivery-count row | Label via `jobTypeLabels`; no extra row | C |
| A23 | `jobs/JobRow.tsx:94-98` | `typeLabel` — SM → engagement label, else `jobTypeLabels[type]` | `undefined` if A10 unfixed; fine after | C |
| A24 | `ui/signal-icons.tsx:144-184` | `JobTypeIcon` `switch` ends `case 'GENERAL_TASK': default:` | **Gets the general-task icon** — visually misleading, not broken | **B** |
| A25 | `JobDetail.tsx:530,648,995-1090,1423-1436` | Interval gating, delivery/meeting panels, `typeLabel`, tabs | No maintenance panel/tab; generic tabs only | **B** |
| A26 | `JobDetail.tsx:3559,3620-3626` | Routes detail body by type to `WeeklyReportDetail` / `SalesMeetingEditForm` / `GeneralTaskEditForm` | Falls through to the General Task body | **B** |
| A27 | `calendar/CalendarPage.tsx:200-203` | **Third copy** of the interval predicate | Treated as a general task (open-ended) | **A** |
| A28 | `calendar/CalendarPage.tsx:241,246` | `type: intervalJobType ?? 'SALES_MEETING'`; `enabled: … && intervalJobType !== null` | Silent wrong default into the slot search; slot search disabled for maintenance | **A** |
| A30 | `reports/ReportsDashboard.tsx:117-121` | Type bars from `PRODUCTIVE_JOB_CARD_TYPES` | No maintenance bar; `completedInPeriod` (`:102`) still counts it | **A** |
| A31 | `reports/reports-api.ts:317-327` | `parseCanonicalWorkTypeBuckets` — **length must equal 4** and `type` must equal the array element at that index | Breaks if **either** side adds a bucket alone | **A** |
| A32 | `reports/reports-api.ts:361-372` | `parseCreatedWorkTypeDistribution` — same length+index equality | Same | **A** |
| A33 | `reports/reports-api.ts:796-803` | `createdWorkTypes` `exactObject` over `PRODUCTIVE_JOB_CARD_TYPES` | Extra key from the server → `INVALID_RESPONSE` | **A** |
| A34 | `reports/reports-api.ts:853-858` | `FOLLOW_UP_CHILD_JOB_CARD_TYPES` length+index equality | Breaks if the server adds a follow-up child bucket | **A** |
| A35 | `reports/reports-api.ts:656,902` | Tolerant-to-position but strict-to-set `oneOf(..., JOB_CARD_TYPES)` | Breaks on a server-only type | **A** |
| A36 | `reports/CustomerReport.tsx:90-96` | Chips = `PRODUCTIVE_JOB_CARD_TYPES`; `Oluşturulan işler` = `activity.period.created` | **User-visible arithmetic mismatch**: total 5, chips sum 3 | **B** |
| A37 | `reports/StaffOperationalReport.tsx:42` | `REPORT_WORK_TYPE_ORDER = PRODUCTIVE_JOB_CARD_TYPES` | No maintenance column | **B** |
| A38 | `reports/ApprovalReport.tsx:37-56` | Type cell: SM → engagement label, else `jobTypeLabels[type]` | Generic label after A10 | C |
| A39 | `services/crm-api.ts:143,196,203` | Customer history / `latestInteraction` / `nextPlannedWork` — strict `oneOf(..., JOB_CARD_TYPES)` | **Throws** → customer detail page breaks | **A** |
| A40 | `jobs/weekly-report-api.ts:65-72,251-262` | `WeeklySourceWorkItem.type: string` + `string(entry.type)` | Tolerant; renders `Diğer` | C |
| A41 | `shell/CommandPalette.tsx:150-168` | Quick actions = `NEW_JOB_OPTIONS.map(...)` with **no capability check** (`canAccessRoute` used only for `customerCreate`, `:158`) | A maintenance create entry would appear **even with the module off** | **A** |
| A42 | `jobs/new-job-options.ts:3,16-22` | The single ordered source of create entries (`meeting`,`task`,`delivery`,`sale`,`weekly-report`) | New entry required | **A** |
| A43 | `paths.ts:18-27` | One route constant per create flow | New constant | **A** |
| A44 | `shell/route-identity.ts:12,52-55,157-161,209-212` | `RouteId` union, breadcrumb title, path matcher, path resolver | 4 edits for a new create page | **A** |
| A45 | `shell/route-access.ts:18-62` | Single route-access rule (`overview`/`calendar`/`messages` capability-gated; reports/`staffReport` role-gated) | New case required, otherwise the default `true` at the end grants access | **A** |
| A46 | `shell/navigation-model.ts:89-109,161` | Capability-driven nav (`capabilities?.calendar`, `?.messaging`, `?.backup`) + landing redirect | The pattern a Maintenance entry copies | C |
| A47 | `services/api.ts:19-26,183-190` | Web `AuthenticatedCapabilities` mirror + parser | New optional flag | **A** |
| A48 | `jobs/overdue-correction.ts:19` | `job.type !== 'SALES_MEETING'` deadline inference | Maintenance behaves like a general task | **B** |
| A49 | `jobs/JobNotes.tsx:71` | Invoice-number field shown for SM/PD only (MOD-001 domain debt) | Hidden for maintenance (fine) | C |
| A50 | `jobs/FollowUpProposalSection.tsx:109-111` | Proposal type options: `['SALES_MEETING']` or `['SALES_MEETING','GENERAL_TASK']` | Cannot propose a maintenance follow-up | **B** |
| A51 | `jobs/CustomerCompletenessAction.tsx:37`, `useCustomerSchedulePreview.ts:49`, `useVisitPairSale.ts:40`, `FollowUpContinuity.tsx:45-46,143` | SM-only convenience surfaces (completeness nudge, schedule preview, visit+sale pair, follow-up continuity) | None of them appear | C |
| A52 | `jobs/JobTimeline.tsx:60`, `jobs/EarlyStartAuthorization.tsx`, `jobs/JobWorkflowPanels.tsx` | Activity-event tone map and command-driven panels | Unaffected unless new lifecycle events are introduced | C |

### 1.11 Web fixtures and scripts that enumerate types

| # | file:line | What it hard-codes | Class |
| --- | --- | --- | --- |
| S1 | `web/scripts/visual-improvements-fixture.ts:89-92`, `ovr7-lateness-fixture.tsx:101-110,186-190`, `responsive-staff-report-fixture.tsx:60-66,141-147` | `completionWorkTypes` + `currentWorkloadByType` with exactly 4 types | C (evidence only) |
| S2 | `web/scripts/reports-ui-fixture.tsx:26`, `customer-pagination-fixture.ts:19-20,37,59`, `login-overview-fixture.tsx:58-60` | `createdWorkTypeDistribution` / bucket derivation, 3–4 types | C |
| S3 | `web/scripts/jobs-control-surface-fixture.tsx:33,62-125`, `job-schedule-compact-fixture.tsx:34-35`, `responsive-job-row-fixture.tsx:27`, `responsive-approval-report-fixture.tsx:22`, `job-detail-mobile-priority-fixture.tsx:94` | Single-type job/card fixtures | C |
| S4 | `server/scripts/f4-seed.ts:46,70-71`, `server/scripts/acceptance/060-061-rehearsal.mjs` | Local 3-type union + interval branch; type literals in a rehearsal | C |

These are **not runtime risk**, but any UI-evidence bundle produced after a
`MAINTENANCE` addition without updating them will show an incomplete dashboard — which is
exactly the kind of "verified by screenshot" claim UI-003 is meant to prevent.

---

## 2. Reports: what counts on-site work, visits and deliveries

### 2.1 What DOM-006 actually mandates (and forbids)

From `DECISIONS.md` DOM-006 (`:609-687`), the binding sentences for this question are:

* *"Dashboard counters and trend, Staff JobCard counters, and approval queue metrics
  include **every** JobCard type."* → `MAINTENANCE` **must** be counted there.
* *"Delivery report quantities and Staff purpose quantities include only
  `PRODUCT_DELIVERY`."* → maintenance must **not** create delivery quantities.
* *"Every Staff operational and delivery report attributes work through
  `job_cards.assigned_to`."* → attribution follows assignment, not performer.
* *"Completed JobCard counts use `manager_approved_at`; cancelled counts use
  `cancelled_at`."*
* *"Revenue, margin, commission, stock, invoice, payment, and employee-ranking metrics
  remain outside MVP."*

DOM-001 (`:337-358`) additionally forbids unit price, discount, line total, revenue,
margin, commission, invoice state and payment state on delivery items, and confirms that
`CONSIGNMENT`/`RETURN` create no stock movement. MOD-001 (`:1991-2070`) keeps Core free of
stock balances, ledger entries and financial documents, and says operational agreement
counts must not be mixed with revenue.

**Consequence for Maintenance.** A maintenance visit may report *counts, duration,
outcomes and device/part references*, never revenue, service price, parts value, invoice
state, or a technician ranking metric. Any "bakım bedeli" field is a new accepted
decision, not a JobCard field.

**Consequence for Maintenance.** A maintenance visit may report *counts, duration,
outcomes and device/part references*. It may not report revenue, service price, parts
value, invoice state, or a technician ranking metric. Any "bakım bedeli" field would be a
new accepted decision, not a JobCard field.

### 2.2 Report-by-report: where a maintenance visit lands today

| Report (route) | Server read | Type basis | Maintenance today |
| --- | --- | --- | --- |
| `/reports/dashboard` | `DASHBOARD_SQL` `:451-600` | counters status-only; `completed_in_period` = `<> WEEKLY_REPORT`; created buckets = **closed 4** | Counted in every counter; **absent from the type bars** |
| `/reports/business-trend` | `business-trend.ts:7-86` | `visits` = `SALES_MEETING`, `sales` = `SALE` | **Invisible** (not a visit, not a sale) |
| `/reports/staff` | `STAFF_SUMMARY_SQL` `:380-450` + completion/execution/on-time | status counters open; `currentWorkloadByType`/`completionWorkTypes` **closed 4**; execution/on-time `<> WEEKLY_REPORT` | Counted in execution/on-time; **absent from both type breakdowns** |
| `/reports/staff/me`, `/reports/staff/:id` | same | same | same |
| `/reports/staff/:id/lateness-incidents` | status/date only | — | Included |
| `/reports/lateness` | org aggregate | — | Included |
| `/reports/deliveries` | `:894,1727` | `PRODUCT_DELIVERY` only | **Excluded** (correct) |
| `/reports/approvals` | `:1330-1345` | status only | **Included** (DOM-006) |
| `/reports/customers` | `CUSTOMER_REPORT_ACTIVITY_COLUMNS` `:1347-1400` | `active/overdue/managerApproved` open; `createdWorkTypes` **closed 4** | Counted in `created`; **missing chip** |
| `/reports/sales-follow-up` | `:1482-1690` | `SALES_MEETING` + 3 child types | **Excluded** |
| `/api/overview` | `overview/repository.ts` + `reports.getWorkTypeDistribution` | open `GROUP BY j.type` | **Included** in the chips |

### 2.3 The two concrete defects this creates

**(a) Totals stop equalling their parts.** `productiveWorkOnly` (`repository.ts:364`)
is a *negative* predicate, so `completed_in_period`, `staff_completed_jobs` and the
dashboard `completed_trend` all include `MAINTENANCE`. The bucket lists (`:345`) are
*positive* and exclude it. Any screen that shows a total next to a type breakdown will
not add up.

**(b) The same question has five answers.** "Work-type distribution for a period" is
implemented five times:

| Implementation | Line | Closed/Open | Includes MAINTENANCE |
| --- | --- | --- | --- |
| Staff profile `currentWorkloadByType` | `:381` | closed | no |
| Dashboard `createdWorkTypeDistribution` | `:533` | closed | no |
| Staff `completionWorkTypes` | `:650` | closed | no |
| Follow-up child buckets | `:1482` | closed (3) | no |
| Overview `getWorkTypeDistribution` | `:2503-2513` | **open** | **yes** |

This is drift inside one module, independent of Maintenance. It should be resolved by
naming one authority (the open read) and rendering the closed buckets from it, or by
declaring the closed set canonical and making the enum exhaustive. Either way it is a
prerequisite: Maintenance makes the disagreement visible to users.

### 2.4 Does any report count "on-site work" as a concept?

**No.** There is no `isOnSite` or visit-kind dimension in `job_cards`. The closest
concepts are `JOB_CARD_ENGAGEMENT_KINDS` (`types.ts:31-39`, which exists **only on
`SALES_MEETING` cards** — `jobs-api.ts:962-971` rejects it on any other type) and
`type = 'SALES_MEETING'` used as the proxy for "a visit happened".

So "on-site maintenance visit" is a **new reporting dimension**, not a re-use of an
existing one. The owner must choose: (i) add maintenance visits to `business-trend.visits`,
(ii) add a separate `maintenanceVisits` series, or (iii) keep visits as sales-visits only.
Leaving it implicit produces (i)- or (iii)-by-accident depending on which screen is read.

---

## 3. Does the web share the server's type list?

**No. It keeps its own copy, and the two are only kept in sync by convention.**

| Server | Web |
| --- | --- |
| `server/src/modules/job-cards/types.ts:29` | `web/src/jobs/jobs-api.ts:38-53` |
| `JOB_CARD_TYPES = ['PRODUCT_DELIVERY','GENERAL_TASK','SALES_MEETING','WEEKLY_REPORT','SALE']` | `PRODUCTIVE_JOB_CARD_TYPES = ['PRODUCT_DELIVERY','GENERAL_TASK','SALES_MEETING','SALE']` then `JOB_CARD_TYPES = [...PRODUCTIVE_JOB_CARD_TYPES,'WEEKLY_REPORT']` |

There is no generated contract, no shared package, and no CI check comparing the two
arrays. The web file's own comments say "server parity" (`jobs-api.ts:35-37,42-45`), which
confirms the intent is manual mirroring.

### 3.1 The drift is not cosmetic — it is a hard failure

Three times, the web mirrors the *order* of `PRODUCTIVE_JOB_CARD_TYPES` and enforces
positional equality:

```ts
// web/src/reports/reports-api.ts:317-327
if (values.length !== PRODUCTIVE_JOB_CARD_TYPES.length) invalid(field);
…
if (type !== PRODUCTIVE_JOB_CARD_TYPES[index]) invalid(field);
```

and again at `:361-372`, plus the same pattern for follow-up children at `:853-858`.

So there are **two** asymmetric failure modes:

| Who changes | What breaks |
| --- | --- |
| Server adds `MAINTENANCE` to a bucket list, web does not | `INVALID_RESPONSE` on dashboard / staff / follow-up reports (length or index mismatch) |
| Web adds `MAINTENANCE` to `PRODUCTIVE_JOB_CARD_TYPES`, server does not | Same `INVALID_RESPONSE` (web expects 5 rows, gets 4) |

The only safe change is **both at the same instant, in the same deploy**, and even then
`reports-api.ts:853-858` requires the *follow-up child* list to stay at 3.

### 3.2 Where the strict parsers are (the blast radius)

`oneOf(value, field, JOB_CARD_TYPES)` appears at:

* `web/src/jobs/jobs-api.ts:977, 1012, 1034, 1046, 1078, 1088, 1136, 1806, 1748, 1701`
* `web/src/services/crm-api.ts:143, 196, 203`
* `web/src/reports/reports-api.ts:656, 902`

`oneOf` (`jobs-api.ts:685-689`) calls `invalid(field)` on a non-member, raising
`ApiError(…, 'INVALID_RESPONSE', …)`. These parsers run on the **whole payload** before it
reaches state, so one `MAINTENANCE` row blanks the entire surface — jobs list, board, job
detail, customer detail, follow-up drawer, reports. Qualitatively worse than a missing
Turkish label.

### 3.3 A second, quieter drift: TypeScript config

`web/tsconfig.json` has `strict: true` but **not** `noImplicitReturns`. `server/tsconfig.json`
also omits it. Therefore two `switch` statements over the type union that lack a `default`
compile fine and return `undefined`:

* `web/src/jobs/job-workflow-presentation.ts:706-718` (`scheduleFieldLabel`)
* `web/src/jobs/JobApprovalReviewPanel.tsx:15-30` (`typeAwareSummary`)

→ A maintenance card would show an **empty** schedule label and an empty approval summary
line, with a green build. `ui/signal-icons.tsx:183` has a `default:` on purpose and gives
`MAINTENANCE` the general-task glyph — a third, visual inconsistency, but not a crash.

### 3.4 Server-side equivalent

`server/src/modules/job-cards/policy.ts:49-56` on `origin/refactor/job-card-exhaustive-dispatch`
introduces `assertNeverJobCardValue(value, kind)`, but `git grep` on that branch shows it is
used **exactly once**, for `status` (`policy.ts:164`). The `kind: 'type'` parameter exists
and is never used. The type dispatch is still carried by two-value boolean predicates:

* `assignment-offer-policy.ts:35-37` — `type === 'PRODUCT_DELIVERY' || type === 'SALES_MEETING'`
* `job-card-duration.ts:42-44` — same pair
* `job-card-duration.ts:5-8` — `CANONICAL_JOB_DURATION_MS` only for those two
* `occupancy.ts:70-71` (inside job-cards) — SQL `j.type IN (...)`

All four silently answer "no" for a new type. **`assertNeverJobCardValue` does not protect
them**, because they return a boolean rather than exhausting a union.

### 3.5 Merge-order hazard with the two in-flight branches

`origin/refactor/weekly-report-submission` is based on `66eaffa` (before `89bf6b1`) and
**does not contain** `assertNeverJobCardValue`. Its `submission-policy.ts` replaces the
exhaustive tail with:

```ts
return jobCard.type === 'PRODUCT_DELIVERY'
  ? evaluateDelivery(...)
  : evaluateMeeting(...);
```

`git show origin/refactor/weekly-report-submission:server/src/modules/job-cards/submission-policy.ts:262-285`

→ If the weekly-report branch lands **after** #513, the compile-time guard that #513 adds
is silently removed and V11 reopens. Whichever order is chosen, the last merge must
re-introduce `assertNeverJobCardValue(jobCard.type, 'type')`. This is worth an explicit
note in both PRs because the two branches do not conflict textually on the same hunks.

---

## 4. Notifications: which kinds are type-specific?

**None.** Verified by reading the whole notifications surface:

| File | Type coupling | Evidence |
| --- | --- | --- |
| `notifications/types.ts:6-30` | none — 21 `NOTIFICATION_KINDS`, all lifecycle/entity based | `job.assigned`, `job.awaiting_approval`, `job.start_reminder`, `job.acceptance_reminder`, `calendar.*`, `message.received` |
| `notifications/policy.ts:35-77` | keyed on `JobCardActivityEvent`, not type | `JOB_CREATED→job.assigned`, `JOB_APPROVED→job.approved`, `JOB_ASSIGNMENT_DECLINED→job.assignment_declined`, … |
| `notifications/policy.ts:5-9,63-72` | management recipients supplied as `ManagementRecipient[]` (`role: 'ADMIN' \| 'MANAGER'`), filtered by `isActive` — not by type | `input.managementRecipients.filter((r) => r.isActive)` |
| `notifications/presenter.ts:13-40` | Turkish copy per **kind** | `'job.submission_reminder'` body is "… işi tamamlayıp yönetici onayına gönderin" — generic |
| `notifications/repository.ts:13-60` | `entity_type`, not job type | `job-card \| calendar-event \| conversation` |
| `web-push/payload.ts:20-43` | URL from entity type | `/jobs/:id` |

**But** three of these kinds are *semantically* type-shaped and would read oddly for a
maintenance visit:

1. `job.submission_reminder` / `job.submission_auto_reminder` / `job.submission_auto_escalation`
   — the "onaya gönderme" nudge assumes completion-then-approval. A maintenance visit that
   requires manager approval fits; one that does not would never trigger it, which is fine.
2. `job.approval_wait_alert` — approval-wait alert. Fires whenever a card enters
   `WAITING_APPROVAL`, so it follows whatever lifecycle Maintenance uses.
3. `calendar.reminder` — job-start reminder, produced by `calendar/reminder-worker.ts`
   from `job_cards` rows with `scheduled_at`. A maintenance visit **without** an interval
   still gets a start reminder (the worker does not check `scheduled_ends_at`), which is
   probably desirable.

→ **Inference:** no notification work is required for `MAINTENANCE`, provided the
lifecycle re-uses existing `JobCardActivityEvent` values. Introducing a new event (e.g.
`MAINTENANCE_COMPLETED`) would require edits in **six** places: `job-cards/types.ts`,
`realtime/event-mapper.ts:21-60`, `notifications/policy.ts:35-77`, `notifications/presenter.ts:13-40`,
`web/src/jobs/job-labels.ts:247-288` (`LABELS`), and `web/src/jobs/JobTimeline.tsx:60`.

---

## 5. What belongs to a Maintenance module vs. core JobCard

### 5.1 The hypothesis, tested

> "assignment, lifecycle and approval stay in JobCard; device service history lives in the
> Maintenance module."

**Holds, with one necessary addition.**

*Confirms the hypothesis.* Assignment (`job_cards.assigned_to`), lifecycle (8 statuses,
`policy.ts`), approval (`WAITING_APPROVAL` → `APPROVED`/`REVISION_REQUESTED`), the activity
log, and the audit trail are all keyed off `job_cards`. Every cross-module consumer found
in §1 reads `job_cards` and **not** a type-specific table: offboarding transfer
(`people/offboarding.ts:591`), messaging access (`messaging/service.ts:1191`), reports
attribution (`reports/repository.ts:370-379,405-450`), realtime audience
(`realtime/audience.ts:12-24`). Moving any of that out would require touching all of them.

*Necessary addition.* The **visit itself** must also stay in JobCard. `business-trend`,
`overview.recentCompletedWork`, staff counters and the calendar list all read `job_cards`
rows with a `type`; a maintenance appointment stored only in a Maintenance table would be
invisible to the calendar, to occupancy and to every counter, and would re-introduce the
`upcomingWork`/`calendar.*` duplication that SCH-001 item 6 keeps in the Calendar module.

Proposed boundary (inference, not authorization):

| Layer | Owner | Content |
| --- | --- | --- |
| JobCard core | core | the maintenance **visit** row: type, assignee, interval, status, approval, activity, notes |
| Maintenance module | module | **device/service record**: device identity (serial/model), service history entries linked to a visit, parts/consumables used (non-financial, DOM-001/MOD-001-safe), next-service interval, warranty dates |
| Warehouse (future) | module | stock effects of consumed parts — explicitly **not** now (MOD-001 item 2) |
| Accounting (future) | module | service invoice/reference — explicitly **not** now (MOD-001 item 3) |

### 5.2 Points that would naturally be *contributed* by an enabled Maintenance module

| Point | Where | Why it belongs to the module |
| --- | --- | --- |
| Device & service-history tables + endpoints | new module | No core table today; MOD-001-style ownership |
| Maintenance-specific completion requirements | a new `evaluateMaintenance` in `submission-policy.ts` | Mirrors the existing per-type evaluators; #513 already forces an explicit branch |
| Maintenance type label, icon, duration | *contributed registry*, not a hard-coded array | Today these are hard-coded in three places (§3.4) |
| A maintenance report section (visits, duration, devices serviced) | Reports as a **new** report route, not a new bucket in the closed lists | Avoids the R1/R12 conflict |
| Own audit event vocabulary | like `PRODUCT_AUDIT_EVENTS` / `CRM_AUDIT_EVENTS` | No shared audit module exists (§1.8) |

### 5.3 Points that must stay core regardless of module state

| Point | Why core |
| --- | --- |
| Occupancy contribution (`occupancy.ts:70-71`) | SCH-001 item 1: planning is core. A maintenance visit must occupy its assignee or the module weakens a core rule when toggled off — exactly the failure SCH-001 was written to prevent |
| Overdue/lateness predicate (`overdue-contract.ts:80-85`) | Status-driven, must stay single-authority |
| Approval queue metrics | DOM-006: "include every JobCard type" |
| Offboarding transfer | `people/offboarding.ts` — staff leave cannot be blocked by a module toggle |
| Activity log + audit for the visit | AGENTS.md §3: critical mutation and audit commit together |
| Historical rendering | A disabled module must still render existing cards (see §5.4) |

### 5.4 How MOD-002 exposes module state to the web, and what a module-gated job type needs

**Today's mechanism (Overview pilot), end to end:**

```
installation_module_state (module_key, enabled, version, source)   [migration 074:52-65]
        │  CHECK (module_key IN ('OVERVIEW'))                        [:59]
        ▼
PostgresModuleStateReader.read('OVERVIEW')   state.ts:55-63        (throws on DB error)
        ▼
OverviewService.assertEnabled()              overview/service.ts:91-101  → 404 when off, 503 on read failure
readModuleEnabledOrFalse()                   state.ts:66-78               → capability false on failure
        ▼
withOverviewDashboard(caps, enabled)         capabilities/service.ts:24-31
        ▼
GET /api/auth/me → user.capabilities.overviewDashboard   (operator-module-pilot.md:155-158)
        ▼
web: AuthenticatedCapabilities               services/api.ts:19-26
     navigation-model.ts:89,105-109          → nav + mobile nav hide the entry
     route-access.ts:27-28                   → canAccessRoute('overview') false
     AppRouter guard                          → redirect
```

**What a module-gated `MAINTENANCE` create flow would require, concretely:**

1. **Registry entry** — `installation-modules/registry.ts:7-25`: add the descriptor
   (`key: 'MAINTENANCE'`, `label: 'Bakım'`, `capability: 'maintenance'`, `legacyEnvKey` if
   wanted). Widening the literal `key` type forces the rest, since `InstallationModuleKey`
   is derived from the array.
2. **Migration** — widen the `installation_module_state.module_key` CHECK (`074:59`) and
   `operator_audit_events.module_key` CHECK (`074:87`), plus the initial row.
3. **Capability** — `capabilities/types.ts` + `DEFAULT_CAPABILITIES` + the projection in
   `capabilities/service.ts`; mirror in `web/src/services/api.ts:19-26`.
4. **Server gate** — service-level `assertEnabled` following `overview/service.ts:91-101`
   (404 off, 503 unreadable, no env fallback — MOD-002 item 5).
5. **Web create entry (hidden when off)** — `NEW_JOB_OPTIONS` (`new-job-options.ts:16-22`)
   is read by `NewJobMenu`, the desktop topbar **and** `CommandPalette.tsx:151`. The
   palette has **no capability filter** (only `customerCreate` is gated, `:158`), so gating
   must be added there too or the disabled module leaks into the primary nav surface.
   Cleanest: an optional `requires?: keyof AuthenticatedCapabilities` on `NewJobOption`,
   filtered by one helper used by all three surfaces.
6. **Web route gate** — `paths.ts` constant, `route-identity.ts` (`RouteId` union +
   breadcrumb title + matcher + resolver, 4 edits), `route-access.ts` case, `AppRouter`
   guard. **Note:** `route-access.ts` ends with a default `return true`, so a forgotten
   case fails **open**.
7. **Historical rendering (must not be gated)** — with the module off, an existing
   maintenance card must still open: `jobTypeLabels` must contain `MAINTENANCE`
   unconditionally, `parseJobCard`/`parsePersistedJobCardListItem` must accept it,
   `JobDetail.tsx` must render a read-only body rather than redirect, and reports must keep
   counting it (DOM-006). Same rule SCH-001 item 2 applies to manual calendar entries:
   *"While it is disabled, they do not count and are never deleted."*
8. **CI env-example gate** — `ops/ci/verify-env-examples.sh:58-82` only if a legacy env key
   is introduced; skip it if the module starts life DB-only (MOD-002 item 7 allows that).

**Where "hide vs. render" must be decided by the owner.** Two options exist and the code
supports both:

* **Capability-gated type** (hidden everywhere when off). Simplest, but historical cards
  must still render — so the gate applies to *creation and maintenance screens*, never to
  reading a JobCard.
* **Capability-gated module surfaces only** (device/service screens hidden; the visit type
  stays creatable). Keeps calendar and reports honest, but "Bakım" then exists in installs
  that did not buy the module.

The second is what the current architecture does *by accident*; the first is what the
MOD-002 contract implies. The answer determines whether `MAINTENANCE` joins
`JOB_CARD_TYPES` unconditionally or only when enabled — and **the conditional form is not
representable today**: `JOB_CARD_TYPES` is a compile-time `const` tuple on the server and a
`const` array on the web, and no code reads a runtime type registry.

---

## 6. Minimum prerequisite set before a `MAINTENANCE` card can exist

Ordered; each row removes one silent failure. An engineering reading of §1, not a plan.

| # | Prerequisite | Removes failure | Anchor |
| --- | --- | --- | --- |
| 1 | Decide whether a maintenance visit is an **interval type**; amend SCH-001 if it is | zero-length calendar events; no occupancy; no conflict check; policy drift | `occupancy.ts:70`, `job-card-duration.ts:42`, `calendar/repository.ts:63`, `job-card-schedule-integrity.ts:14` |
| 2 | Replace the four two-value predicates with an exhaustive dispatch | silent `false` from interval / offer / duration / occupancy | §3.4 |
| 3 | Mirror the type list in web **in the same change**, and update all three positional parsers | `INVALID_RESPONSE` on every surface | `jobs-api.ts:38-53`, `reports-api.ts:317-372,853-858` |
| 4 | Enable `noImplicitReturns`, or add `assertNever` to the two default-less switches | blank Turkish labels | §3.3 |
| 5 | Resolve the five-way work-type distribution; decide the maintenance report story | totals ≠ parts; visits invisible or double-counted | §2.3, §2.4 |
| 6 | Decide module gating; add the palette capability filter; re-introduce `assertNeverJobCardValue(type,'type')` after whichever branch merges last | disabled module leaks into the palette; V11 reopens | §5.4, §3.5 |

---

## Open questions for the owner

1. **Is a maintenance visit an interval job?** Yes → it must join occupancy (core, SCH-001).
   No → it behaves like `GENERAL_TASK` and a technician can be double-booked, which is the
   exact scenario a service visit exists to avoid.
2. **Does it require manager approval?** Yes → the existing `WAITING_APPROVAL` lifecycle is
   unchanged. No → `policy.ts` needs a type-aware bypass, and DOM-006's "completed counts
   use `manager_approved_at`" needs an answer for never-approved jobs.
3. **Does it carry a `due_date`?** `SALES_MEETING` explicitly forbids one
   (`create-input.ts:197-205`) and is therefore never overdue; SM/PD deadlines come from
   `scheduled_ends_at` (`reports/repository.ts:764-768`). Pick one, or lateness silently
   does not apply.
4. **Do maintenance visits count as "visits" in the business trend?** (§2.4) Three
   defensible answers, each changing a shipped screen.
5. **Should the type exist in installs without the module?** (§5.4) No runtime type
   registry exists today.
6. **Can a maintenance visit originate a SALE or PRODUCT_DELIVERY?** If yes,
   `realtime/repository.ts:41-73`'s `SALES_MEETING`-only origin scoping and
   `sale_source_visit_id` semantics need review. If no, say so — the sale origin is
   currently hard-coded to visits.
7. **Are parts/consumables recorded, and does that touch stock?** Parts *without* stock
   movement is allowed today; *with* it is a Warehouse decision (MOD-001 item 2).
8. **Does a device belong to a customer or to a location/site?** Affects CRM visit-history
   granularity (`crm/service.ts:164-179`) and whether a maintenance card can exist without
   a customer.
9. **Does a maintenance job transfer on offboarding like every other non-weekly-report
   type?** (P2) Presumably yes; confirm, because it becomes an occupancy check.

---

## Unverified items

* **Nothing in this document was executed.** No build, no test, no migration, no browser.
  The claims are static reading of `89bf6b1` (plus two named branches via `git show`).
  `server && npm run build` / `npm test` / `web && npm run build` were **not run**.
* **`noImplicitReturns` inference.** `web/tsconfig.json` and `server/tsconfig.json` do not
  set it. I did not run `tsc` to confirm `job-workflow-presentation.ts:706-718` and
  `JobApprovalReviewPanel.tsx:15-30` really return `undefined`; a one-file probe settles it.
* **`INVALID_RESPONSE` blast radius.** Traced `oneOf → invalid(field)`, but no payload was
  run through `parseJobCard`. Whether the throw blanks a whole surface or is caught per row
  depends on caller-side `catch` sites that were not audited.
* **`web/scripts/reports-ui-fixture.tsx:32-33`** passes `{ label, count }` for
  `completionWorkTypes` / `currentWorkloadByType` while the DTO is `{ type, count }`. Looks
  stale; I did not confirm which component consumes it or whether it still runs. Flagged as
  a possible pre-existing inconsistency, not caused by Maintenance.
* **PR #513 status.** Read via `git log` / `git diff origin/main...origin/…`. I did not
  check GitHub PR state, review comments, or mergeability.
* **`origin/refactor/weekly-report-submission` merge behaviour.** Verified it lacks
  `assertNeverJobCardValue` and ends `submission-policy.ts` in a ternary fall-through. No
  trial merge, so I cannot say whether git raises a conflict (the safer outcome).
* **`backup/restore` `CORE_RELATIONS`.** Confirmed the list is closed (`postgres.ts:11-25`)
  and drives integrity counts (`:297-341`). I did not read far enough to know whether a
  table outside the list is *silently skipped* or *fails* the restore.
* **`ops/ci/verify-env-examples.sh`** — read the flag policy (`:58-82`); did not run it and
  did not check whether `ops/examples/*.env.example` already carries a maintenance key.
* **Audit.** Established there is no `server/src/modules/audit/` directory and that
  per-module event vocabularies exist (`products/types.ts:78`, `crm/types.ts:170`). I did
  not trace how `audit_events.event_type` CHECK constraints are maintained across
  migrations (V6 in the 2026-11-25 research mentions 13 rewrites); that needs a separate
  read of the migration history.
* **Calendar reminder worker.** Confirmed it does not branch on job type
  (`calendar/reminder-worker.ts`). I did not verify which `job_cards` rows it selects, so
  the claim "a maintenance visit without an interval still gets a start reminder" is an
  inference from the absence of a `scheduled_ends_at` predicate.
