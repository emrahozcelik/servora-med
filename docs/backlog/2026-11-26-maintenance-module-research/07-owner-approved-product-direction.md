# 07 — Maintenance and Technical Service: owner-approved product direction

Date: 2026-11-26. Source: owner review of PR #516 ("Önerdiklerini mantıklı buldum. Dosya ve ilgili değişiklikleri yapalım.").
Status: accepted product direction and delivery priorities for planning; **not implemented, not a production release or an authorization to merge/deploy**. The first implementing PR must record MNT-001 in DECISIONS.md and update the owning product/feature/API/schema documents alongside relevant code. Open technical/legal details below must be resolved before their implementation. This document supersedes conflicting recommendations in research notes 01–06; those notes preserve observations at 89bf6b1, not current policy.

## 1. Product scope

Turkish label: **Bakım ve Teknik Servis**; technical key and planned JobCard type: `MAINTENANCE`. A technical service management system, not merely a new JobCard label. Support manufacturer, importer, dealer and independent service models without assuming all customers are legally authorized for every service activity.

| Priority | Target capabilities |
| --- | --- |
| V1 | Installed equipment registry (brand/model/serial, customer/site, warranty dates, installation provenance); installation/commissioning; corrective intake and service cases; one or more maintenance/repair work orders; technician scheduling; service history; structured technical service report, PDF, checklists and measurements. |
| V2 | Preventive plans and due dates, idempotent automated work creation, warranty and maintenance agreement management, attachments/photos, structured part usage and optional Warehouse integration, optional quotation/accounting integration, SLA/intervention tracking. |
| V3 | Customer service portal, access-controlled QR equipment/history lookup, external ERP/manufacturer integrations, failure and maintenance performance analysis. |

V1 is a product target, not a single PR. Legal/report/signature/retention requirements can pull a V2 capability forward if mandatory for the pilot. Warranty/service entitlement and operational agreement terms belong to Maintenance; commercial documents, financial balances and collection belong to Accounting. Do not build a second ledger or inventory. No new dependencies, generic event bus or role enum by default.

## 2. Ownership and domain model

- CRM owns customer identity and, when available, canonical address/site data. Maintenance owns equipment installation/site reference and historical location snapshot. Start with an explicit location label if CRM lacks site records; do not invent a second customer master. Multi-site strategy must be defined before committing an incompatible schema.
- Maintenance owns the installed asset, service case and visit-specific facts, service history, preventive plans and service entitlement. An asset can have multiple service cases; a case can have multiple visits/work orders (diagnosis, parts wait, repair, test). Each visit references its case and asset (consistent customer/organization), and has exactly one core JobCard and one module-owned detail record. Case closure is distinct from JobCard approval; no closure with unresolved active work or missing required evidence. A case may exist before scheduling a visit.
- Core JobCard owns assignment, scheduling/occupancy, lifecycle, manager approval, authorization, audit and operational attribution. Do not add a parallel technician workflow or a second job status machine in Maintenance. Do not use GENERAL_TASK as a carrier that bypasses field-work invariants.
- A device serial is a durable Maintenance attribute, optionally linked to Warehouse provenance; installed asset identity does not depend on Warehouse or the product catalog being the stock authority. Preserve snapshots; do not invent serial numbers or assume one delivery line equals one physical device. Seed only explicitly selected eligible approved delivery items, with unit-level provenance, idempotency, duplicate reconciliation and no silent fabrication; support manual create and validated bulk import. Quantity >1, missing serial, historic invalidation and repeated imports need explicit tests and review before enabling seeding.
- Structured part-use fact belongs to Maintenance; stock movements and balances belong to Warehouse (or explicit external authority). With Warehouse off, part use can be recorded without stock effect; do not silently replay it into inventory on enable. Accounting off must not block a service visit; no invoice/payment status in core. Any durable cross-module integration needs explicit idempotency, error/reconciliation and authorization contracts (MOD-001).
- New domain records are organization-scoped, with composite foreign keys where applicable, history retention, versioned changes, atomic audit/idempotency, backup/restore and offboarding coverage. Resolve exact schema, statuses and constraints in implementing slices; no speculative tables.

## 3. JobCard behavior

Extend the accepted JOB-007/JOB-010/JOB-012/SCH-001 and applicable lateness/location/approval policies explicitly to MAINTENANCE; they do not currently cover this new type automatically. A planned visit occupies its assignee even if Calendar or Maintenance is disabled. Reuse the one conflict definition, locking, slot suggestions, early release on submission and existing report attribution. Default planned duration 60 minutes; authorized management can change duration/start/end, with validated positive interval, concurrency and conflict checks; preserve planned vs actual times and audit.

Assignment and start are distinct: use existing JOB-010 acceptance offer/deadline semantics (including short notice, expiry and automatic cancellation/reoffer management flow), early START tolerance 30 minutes and existing earlier-start authorization path; no separate arrival status. START only by assigned authorized STAFF, with existing action-scoped location policy when enabled. Technician uses existing STAFF role with explicit technical service permission/eligibility enforced server-side; management creates/assigns work and eligible technicians may open a self-assigned corrective request/visit under existing role and assignment rules. Exact permission representation is a slice decision, not a new role by default.

Mandatory manager approval; no direct Staff cancellation, use reasoned change/termination request and management decision; valid excuses must not negatively affect performance under applicable accepted rules. Revision deadlines, rescheduling, overdue incident closure, follow-up, replacement, invalidation and offboarding need explicit type behavior and tests; no accidental fall-through. Maintenance counts as operational productive work (not revenue); historical attribution and totals reconcile with type buckets. Distinguish canceled/invalidated outcomes per existing reporting rules.

## 4. Runtime module switch

Use MOD-002 and merged MOD-003 (#520, 873c4285) on current main: registry descriptor `MAINTENANCE`, capability `maintenance` (new typed field in its implementation), `legacyEnvKey: null`, Turkish label/description/whenDisabled/preserved. First row off, `FRESH_INSTALL`, `MODULE_STATE_INITIALIZED`; reuse 075, no second key migration, defaultEnabled or INSTALL_DEFAULT. State is installation-level, not organization-level; separate per-organization licensing in a shared installation is not authorized here. Operator alone controls versioned audited changes; no customer ADMIN override, no env fallback, no data deletion on disable.

| Operation | Disabled (known false) | Enabled |
| --- | --- | --- |
| Normal module menus, dashboard, device/case/plan management, new devices/cases/visits, imports | Hidden; new module writes and standalone management routes denied | Role-scoped access |
| Existing active JobCard and required visit facts | Core lifecycle stays available; narrow scoped completion/revision/management correction paths remain available for that existing visit, not a general module write bypass | Normal authorized workflow |
| Historical device/service evidence | Retained, authorized read-only access through existing job/history context or a specifically scoped retention view; no unrestricted disabled management API | Role-scoped access |
| Occupancy, active work notifications, historical reports, audit, backup | Preserved; never filtered solely by module flag | Preserved |
| Preventive workers and module-only reminders | Stop creating new work/alerts; check state transactionally at claim and mutation boundary | Resume current periods, no mass replay; explicit deduplication |

State missing/unreadable: module routes 503, capability off, no legacy fallback. Core routes remain operational; existing visit readiness/evidence needed for safe completion must not depend on an unavailable module state or bypass authorization. Implement narrow continuation via core-owned authorized operation/port, with no new case/visit creation; distinguish known disabled from state read failure and test both. If required data itself cannot be read/written, fail safely and leave work recoverable, never approve missing evidence. Do not expose unrestricted module API because a card exists. Serialize toggle vs new create/worker claim; define transaction/lock order and in-flight behavior. Re-enable preserves identities and history; never resurrect old tasks or duplicate alerts. Restore returns backed-up module state and preserves data; operator sessions/accounts reset per MOD-002. No production change is authorized by this document.

## 5. Updated prerequisite and delivery order

| Work label (planning only) | Scope / gate |
| --- | --- |
| MNT-000 | Shared registry R0 already merged (#520 / 873c4285); confirm exact main and migration compatibility before implementation. |
| MNT-001 | Record accepted product direction in DECISIONS.md and applicable owning documents with first implementing slice; specify remaining choices before affected code. |
| MNT-002 | Type-behavior safety: #513 merged (6b909356); inventory remaining dispatch points on latest main. Consolidate on-site/planned interval/offer eligibility and duration/deadline/action behavior; exhaustive handling, server/web parity, reports buckets, DB constraints, readiness, follow-up, location and worker policies. Verify weekly-report final shape; earlier claimed conflict/never deletion was refuted. |
| MNT-003 | Registry activation and equipment inventory vertical slice; independently testable, default off; parallel with safe core refactors, no inert stub advertised as shipped. |
| MNT-004 | Service case intake/management and device relationship; case/work order relationship defined before visits. |
| MNT-005 | MAINTENANCE JobCard with variable planned duration, case link, full selected lifecycle/occupancy rules, structured visit data. Coordinate server/web/migration rollout; no active producer before every consumer understands type. |
| MNT-006 | Structured service report, checklists, measurements, PDF, evidence and required signatures/retention per verified legal scope. |
| MNT-007 | Production pilot acceptance: legal review, role/scoping, exact-head CI, schema/backup/restore, UI evidence, operational acceptance; explicit separate deploy authorization. |
| MNT-008 | Preventive plans, worker and reminders. |
| MNT-009 | Structured parts and optional Warehouse/Accounting integration; explicit authoritative system and no silent stock/finance replay. |
| MNT-010 | Advanced features per V3, separate decisions. |

These work labels are roadmap items, not existing issues, migration numbers or claims of implementation. No binding docs-only PR for MNT-001; synchronize PRODUCT_REQUIREMENTS.md, applicable feature contract, DECISIONS.md, API/schema and slice plan with actual code and acceptance evidence per AGENTS.md. Recheck latest main before each slice, avoid duplicate migration numbers.

## 6. Release-blocking acceptance requirements

- Unknown type/status cannot silently inherit behavior; server and web type vocabularies/parsers agree. Existing job types retain behavior and reports reconcile (including completed-by attribution).
- Multiple visits per case; cross-organization, mismatched device/customer/case and duplicate job/detail links rejected. Concurrent creation/import, multi-unit delivery provenance, missing serial, invalidated source and repeat import do not fabricate or duplicate assets. Preserve historical source.
- Valid variable interval; conflicts across maintenance, delivery, sales and manual calendar (when enabled), including calendar disabled, concurrent booking, reschedule, offboarding and slot search. Submission releases occupancy per JOB-007. Offer expiry/short notice, early START, location evidence, revision, manager approval, cancellation requests and reports tested for maintenance. No UI-only role enforcement.
- Default off; operator-only toggle; disabled new writes via direct API denied, stale UI denied, in-flight create and worker races deterministic; existing open visits can update mandatory facts and safely conclude, historical evidence remains readable only to authorized actors; missing state fails closed for new module activity; no deletion or duplicate replay on re-enable.
- Backup/restore includes all new relations and operator reset, audit/idempotency atomicity, demo purge ordering, offboarding and hard-delete blockers account for module references, no data leak across organizations. History/reports remain available and correct independent of optional module flags.
- Verify Turkish PDF rendering, immutable approved evidence and authorized correction history; legal/signature/retention scope and safe export/access, including disabled state, confirmed before regulated pilot. No claim of legal compliance from research alone.

## 7. Remaining verification and decisions

Owner's ten README questions are answered directionally by §§1–5. Not yet decided or verified: exact service authority per customer and legal jurisdiction, applicable official technical-service/ÜTS/guarantee/calibration requirements and transition dates, acceptable signature form, retention/export and storage security, report fields, technician permission representation, case statuses/closure/reopening and cancellation policy, import and multi-unit reconciliation, site model, duration bounds, exact migration/locking cost, worker cadence and integration mode. Do not promote the secondary-source date or unverified claims in note 04 into accepted law; verify official texts and obtain legal advice where appropriate. Implementation, builds, CI, production migration and legal validation have not been performed by this documentation update.

## 8. Source links

- [PR #516](https://github.com/emrahozcelik/servora-med/pull/516)
- [PR #513](https://github.com/emrahozcelik/servora-med/pull/513)
- [PR #520](https://github.com/emrahozcelik/servora-med/pull/520)
- [DECISIONS.md](../../../DECISIONS.md) (MOD-001/002/003, JOB-007/010/012, SCH-001, DOM-006)
- [Research index](README.md)
