# Implementation roadmap, contract ownership and acceptance

Status: proposed delivery sequence; no runtime changes in this PR. Start from freshly verified main, not planning branch or stale module PR. Each slice is a narrow vertical PR with code + tests + canonical documents in the same change, exact-head review, no unapproved merge/deploy. Do not merge a separate decision-only change as if implemented. Detailed D01–D12 defaults are subject to acceptance in relevant implementation review; any conflict requires explicit supersession.

## 1. Slices and dependencies
| Slice | Scope / deliverable | Dependencies and exit |
| --- | --- | --- |
| FLOW-001/A audit | Reproduce F01–F09 in PG fixtures; inventory every job creation, follow-up, approval, cancellation/invalidation, reassignment, read projection, calendar/overview/report/weekly report consumer, module gate and event. State/role/type matrix with exact source lines; reconcile S4 status. | Start immediately; evidence and classified defects, no speculative rewrite. |
| FLOW-001/B report repairs | Add scheduled-overdue follow-up metric and explicit follow-up kind vs source metric; keep old labels/contracts, prove against canonical OVR/JOB-010 semantics. | A; REPORT-FLOW metric acceptance, regression and UI evidence. |
| ENG-A occurrence/result | Add compatible typed data and UI, validation, migration, historical unknown read adapter, approval snapshot. | A + D01/D02 acceptance; held vs not-held tests and legacy upgrade. |
| ENG-B next action/loop | Separate routine cycle disposition and explicit follow-up intent, preserve JOB-008/009 mechanics; handle absent meetingAt target, manager adjustment. | ENG-A + D03; no lost continuation, slot/late approval/retry tests. |
| ENG-C interest fields | Product interest rows, optional channel/blocker/needs/feedback/training fields, mobile progressive disclosure. | ENG-A + D08; scoped catalog and history tests. |
| FLOW-A contextual actions | Server-produced typed actions; reuse existing commands; proposal lifecycle for concrete non-sale target (demo/training first); no generic engine. | ENG-B + D04; role/state matrix, concurrent retry, approval/cancel. |
| FLOW-B sale source expansion | TRAINING source eligibility, post-sale follow-up via explicit typed action, only approved scope. | FLOW-A + D05; preserve SALE-002 pair and independent orders; update sale readers and tests. |
| FLOW-C SALE-003 delivery continuation | Late delivery creation/replacement with physical evidence guard, new typed attempt history, migration, UI manager exception. | A + D06/D07; can proceed independently of ENG-C; no partial fulfillment, test races. |
| CRM-A customer lifecycle | Read timeline + open actions/interest, permission-safe links, customer summary, paging. | ENG-A/C, FLOW-A/C; existing customer/duplicate and enrichment tests. |
| REPORT-A outcome and conversion | New type/occurrence/channel reports, matured direct conversion, independent orders, product interest. | ENG-A/C + D09; may ship held/type earlier; verify exact cohort fixture. |
| REPORT-B fulfillment and chain | Delivery attempt status, exception queue, optional explicit root-chain metric, drill-down. | FLOW-C/CRM-A + D09; no double counting. |
| MOD-A integrations | Individually designed WH/MNT/ACC actions/ports, messaging/Calendar independence; no duplicate registry migrations. | Owning module first slices accepted/tested; D11 and separate per-integration decisions. |

Do not start quotation/pricing/revenue/opportunity lifecycle, partial shipment, generic workflow builder, cross-module worker infrastructure, or calendar redesign under this umbrella without an accepted owning contract.

## 2. Canonical document change map
| Owner | Update at implementation |
| --- | --- |
| DECISIONS.md | Amend DOM-007 and JOB-008/009 for ENG-A/B; SALE-001/002 only eligible sources/replacement as appropriate; DOM-003 event vocabulary and JOB-004 review snapshot; preserve REPORT-002 and SCH-001; proposed ENG-001/FLOW-002/SALE-003/REPORT-FLOW/MOD-FLOW IDs checked for collision. |
| PRODUCT_REQUIREMENTS.md §§ Core Workflows, JobCard Types, Reports, Scope | Actual result capture, linked actions, delivery continuation, CRM/report scope; no implied new full modules. |
| SERVORA_MED_SCHEMA_DRAFT.md §§ vocabularies, 6, 8 | Typed nullable fields, interest rows, relation/attempt constraints, migration groups, historical compatibility, no assigned migration numbers now. |
| SERVORA_MED_API_DRAFT.md §§ 2,3,7,10,12,14,16 | Existing critical command envelope, meeting result API, available actions/proposal/attempt contracts, customer timeline/report metrics, errors and compatibility. |
| SERVORA_MED_ARCHITECTURE_PLAN.md §§ 5,7,11 | Core ownership, CRM read ports, named relations, optional module boundary, no duplicate SSOT. |
| SERVORA_MED_MVP_SLICES.md | Append accepted vertical slice/order and verification only, no retroactive rewriting historical MVP. |
| docs/features/visit-to-sale/{README.md,sale-002-contract.md,read-integration.md,write-ui-integration.md} | Explicit supersession notes for source and delivery rules; preserve historical design and snapshots, reconcile S4 evidence. |
| docs/features/reporting/README.md | Metric dictionary, time/attribution/cohort, definitions/labels; existing lateness contract where affected. |
| docs/superpowers/specs/2026-07-31-linked-follow-up-jobcards-design.md | Historical design remains; add reference to current accepted replacement policy in current owning doc, not rewrite past. |
| docs/README.md | Index accepted current contracts once code lands; draft package remains backlog. |
| DESIGN.md / PRODUCT.md | Apply existing UI rules; change only if genuinely new accepted standard. |
| #515/#516/#517/#518 owning feature docs | Reconcile before integration; do not mutate their branches from this PR, no duplicate 075. |
| AGENTS.md | No change needed; engineering rules remain. |

## 3. Acceptance matrix (minimum)
| ID | Scenario | Required observation |
| --- | --- | --- |
| A01 | Existing active visit+sale submitted, manager approves | both terminal atomically; optional follow-up+delivery once; version/receipt unchanged |
| A02 | Pair revision/withdraw/resume, stale participant | both coordinated or no change; replay and legacy mixed/cross-owner behavior preserved |
| A03 | Held interested + follow-up | no unsuccessful reason; actual time retained |
| A04 | Not held + reason, no actual time | no fake visit/sale; attempt count and valid future plan |
| A05 | Routine positive/negative/decision pending | exact accepted continuation/stop reasons, no silent loss |
| A06 | Late approval, slots full, Calendar off | canonical core occupancy, manual fallback; no lost proposal |
| A07 | Manual FOLLOW_UP with no source and linked non-FOLLOW_UP | kind/provenance metrics distinct |
| A08 | Scheduled follow-up past planned time, dueDate null | scheduled metric correct; old due-date counter still labelled; unaccepted/late separated |
| A09 | Old ambiguous legacy records and invalidated cards | no guessed occurrence or outcome, correct report exclusion |
| A10 | Multiple next actions, replay and payload mismatch | distinct valid actions; identical retry no duplicate; mismatched key rejected |
| A11 | Staff tries foreign customer/card, manager across org, restricted link | existing 403/404 semantics; no ID/contact/event leakage |
| A12 | Staff proposes manager-only action | no unauthorized execution, approve/reject audit |
| A13 | Training source eligibility / OTHER | only accepted kinds create SALE; no generic create bypass |
| A14 | Approved standalone or visit sale without delivery | manager can late-create exactly one eligible linked attempt |
| A15 | Cancelled attempt without physical evidence | explicit replacement links old and new; old history retained |
| A16 | Cancelled/invalidated attempt with actual delivery evidence | blocked and reconciliation queue, no automatic replacement/reversal |
| A17 | Two concurrent delivery creates/replacements/approval replay | at most one live attempt, no partial commit, consistent receipt |
| A18 | Completed delivery, invalidated source sale | no duplicate delivery; no cascade or physical reversal |
| A19 | Product renamed/deactivated, customer/contact updated | snapshot preserved, new selection eligibility enforced |
| A20 | Demo and BUSINESS isolation | no mixed links or leakage; purge/restore remains compatible |
| A21 | Cohort 30/60/90, zero denominator, pending/late approvals, standalone orders | correct matured denominator, unique visit numerator, actual timestamps |
| A22 | Multiple attempts / sales and cross-staff delivery | no join inflation; REPORT-002 independently assigned ownership |
| A23 | CRM timeline pagination/realtime/permissions | stable ordering, no duplicate rows, authorized link visibility |
| A24 | All optional modules OFF, individually ON and state flip during action | core works, module writes gated, data preserved, no duplicate replay/catch-up |
| A25 | Legacy API/client mixed deployment and migration upgrade | compatible reads/writes, fail closed on unsupported payload, no destructive migration |
| A26 | 390/768/desktop, keyboard, 200% zoom, slow response | no clipping, focus stable, errors recoverable; UI-003 evidence |
| A27 | Backup/restore and retry after restoration | relation and receipts consistent; owning module restore tests, no production data used |
| A28 | Weekly report/overview/calendar/notifications/data management | existing counts, occupancy, link permissions and purge regressions pass |
| A29 | Performance representative fixture | indexed bounded queries, EXPLAIN evidence, no N+1 or unbounded recursion |
| A30 | Closed sale/visit/revision and action visibility | terminal immutability, no forced transition, exact server next action |

## 4. Engineering / release gates
Read AGENTS.md and current owning docs; exact base/head, clean isolated worktree, no unrelated changes. Before migration allocate latest number and update schema-check, migration inventory/upgrade tests, clean install and forward-only rehearsal with synthetic PostgreSQL. No runtime dependency changes unless needed/authorized. Preserve 049 lock order and receipt admission; test concurrent operations and rollback on downstream failure. Run server build, full server suite with required PG environment, web build/tests and applicable browser smoke/UI-003, normal hosted CI for exact head and resulting main; AGENTS §9 local CI fallback only when authorized. Record command, environment, pass/fail/skip, evidence. No skip-ci for implementation. No deploy until explicit authorization and migration/backup/release gates; do not infer production from main.

## 5. First agent handoff (FLOW-001/A)
Goal: produce exact-head evidence, reproduce F01–F09; no feature code or speculative policy rewrite until findings categorized and affected decisions accepted. Read this package and canonical docs; inventory backend command paths/constraints/transactions, frontend actions, read consumers, worker/module dependencies. For F04 compare due-date predicate to canonical overdue scanner and JOB-010 unaccepted case; for F07 check manually created FOLLOW_UP and linked other meeting; for F03 demonstrate cancelled and invalidated slot and physical evidence behavior; for F01 prove held meeting + follow-up and not-held semantics. Inspect prior PRs and S4 doc drift. Deliver path:line citations, reproduction commands/fixtures (synthetic), expected/actual, severity, accepted limitation vs defect, proposed minimum fix and exact slice dependencies. For independent bugfix propose code+tests+owning docs in separate PR after scope approval. No production, no merge, no secret or customer data, no automatic CI skip. Report in Turkish per AGENTS §12.
