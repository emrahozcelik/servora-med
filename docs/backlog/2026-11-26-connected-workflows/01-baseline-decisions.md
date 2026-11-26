# FLOW-001 — Baseline audit and decision ledger

Baseline source links use commit 873c4285cbcf6735a9908fffe80b48d6882a1fa4; relative paths refer to that repository root, not to this planning directory. Static code inspection; no runtime or production claims. Re-run exact-head inspection and reproduce findings in PostgreSQL before changing behavior.

## 1. Existing domain
Job types: PRODUCT_DELIVERY, GENERAL_TASK, SALES_MEETING, WEEKLY_REPORT, SALE. Engagement kinds: SALES_MEETING, CUSTOMER_VISIT, PRODUCT_DEMO, TRAINING, FOLLOW_UP, OTHER. See [types.ts:29–64](https://github.com/emrahozcelik/servora-med/blob/873c4285cbcf6735a9908fffe80b48d6882a1fa4/server/src/modules/job-cards/types.ts#L29-L64). Distinguish job lifecycle from engagement result, source relation and actual event. SALE-002 permits standalone and completed-visit origins, coordinates live same-owner visit+sale submission/revision/withdraw/resume/approval, optional one delivery at approval. Source and delivery IDs are distinct from follow-up source. Preserve cross-assignee restricted projection, one active sale per source, snapshot and intent rules.

## 2. Evidence-backed findings
| ID | Evidence | Classification | Required next step |
| --- | --- | --- | --- |
| F01 | meeting-details-input.ts: validateMeetingDetailsCandidate; submission-policy.ts:100–206; web/src/jobs/MeetingDetails.tsx:332–353 | FOLLOW_UP_REQUIRED requires unsuccessfulReason; an actual held positive/undecided meeting can require follow-up. Model limitation. | Separate held status, outcome and next intent; preserve legacy data. |
| F02 | reports/repository.ts:911–948,1480–1557; reports/business-trend.ts:22–57 | Outcome totals group all SALES_MEETING; business trend calls all completed held engagements visits. Missing breakdown, not proof of wrong legacy metric. | Explicit type dimensions, retain labelled legacy metric until replacement. |
| F03 | migration 071:38–43; SALE-002 Q4 | Lifetime unique linked delivery, including cancelled/invalidated; a replacement currently loses sale link. Accepted limitation. | SALE-003 explicit replacement and later delivery action, no partial fulfillment by default. |
| F04 | create-input.ts:85–91; reports/repository.ts:1464–1478,1593–1603; web/src/reports/SalesFollowUpReport.tsx:43 | Due-date-only overdue counter excludes meeting follow-ups whose dueDate must be null; UI acknowledges scope. | Add separately labelled canonical scheduled-overdue/incident metric; do not silently rename due-date metric. |
| F05 | follow-up-policy.ts:86–122,213–216; job-cards/service.ts:3111–3113,8583–8598 | SALE explicitly forbidden as follow-up source; staff restricted to default type; mandatory loop limited to CUSTOMER_VISIT/FOLLOW_UP. Accepted scope. | New explicit contextual actions, no generic allow-all. |
| F06 | sale-policy.ts:5–18 | TRAINING/OTHER not eligible sale origins. Accepted restriction. | Proposed TRAINING expansion; OTHER requires explicit classification/decision. |
| F07 | business-trend.ts:23–35,49–57 vs follow-up-policy.ts:124–133 | Follow-up provenance vs engagement kind differ. Manual FOLLOW_UP without source omitted from linked count; other sourced meetings may count. | Distinct metrics: follow-up kind vs linked child, direct vs attributed chain. |
| F08 | business-trend.ts:49–79; reports/types.ts | Direct visit→sale / visit→follow-up already counted; not complete funnel; no delivery status dimension in this query. | Extend with named relationship projections and agreed cohort rules. |
| F09 | sale-002-contract.md header says S4 in progress; DECISIONS.md SALE-002 says implemented S1–S4 | Document status drift, not runtime defect. | Verify actual S4 PR and reconcile in owning doc when slice touches it. |

No claims that any item is a security vulnerability or production outage. Reproduction matrix must include direct/manual/cancelled/reassigned/demo/invalidated links, independent orders, paired sale, retry and modules off.

## 3. Existing decisions that stay in force
DOM-001 non-financial delivery purpose; DOM-003 append-only activity; DOM-004 catalog boundary; DOM-006/REPORT-002 assignee at completion and actual event time; DOM-007 two-stage planning; JOB-004 immutable approval snapshot; JOB-006/007 planned vs actual/occupancy; JOB-008 7/14-day continuous follow-up and 15-minute floor, local window; JOB-009 cancellation continuity; JOB-010 assignment offer/change request, staff cannot cancel; JOB-011/012 slots and time proposal; SALE-001/002 separate agreement, joint intent and no cascade; SALE-QTY-001/DELIVERY-QTY-001 positive whole units; CRM-S2-001 scoped enrichment; MOD-001/002/003, SCH-001. No bypass of role, customer scope, version or approval.

## 4. Owner decision ledger (detail proposals; confirm before changing affected behavior)
Owner approved overall product direction in this chat; the following specific defaults are engineering proposals chosen to make implementation reviewable, not independent verbatim owner decisions.
| ID | Proposed default | Amends / gate |
| --- | --- | --- |
| D01 | Separate occurrence HELD/NOT_HELD/UNKNOWN_LEGACY, outcome and next action; no fake meetingAt. | DOM-007/JOB-010, ENG-A |
| D02 | Held meeting can be interested/decision pending/not interested/noncommercial completed; confirmed sale derived only from linked approved SALE; legacy POSITIVE not automatically mapped to interest. | ENG-A |
| D03 | Routine follow-up defaults continue 7/14 days with explicit next date; other types may propose follow-up, not mandatory by default. Explicit stop reason for routine cycle; no silent closure. | JOB-008/009, ENG-B |
| D04 | Multiple distinct next actions, default to staff proposals where reassignment/delivery/module action needs manager; no extra approval for existing allowed sale creation. | FLOW-A |
| D05 | TRAINING can produce sale via existing sale rules; OTHER stays closed until a clear type is selected. | SALE-001/002, FLOW-B |
| D06 | Approved sale with no delivery can later open one; cancelled/invalidated delivery replacement allowed only after explicit manager reconciliation; no duplicate active or successfully fulfilled delivery. | SALE-002 Q4, FLOW-C |
| D07 | No partial/multi shipment initially; evidence of delivered quantities on cancelled/invalidated attempts blocks automatic replacement, human reconciliation; WH contract owns remaining quantities later. | FLOW-C / WH integration |
| D08 | Product interest is structured and optional, distinct from sale/quote/delivery; optional channel, blockers, feedback, expected decision date and training details. No free-form custom schema. | ENG-C |
| D09 | Reports expose held/attempted/unknown, kind, channel, follow-up kind/provenance, direct conversion and fulfillment; 30/60/90 day windows are separately labelled and matured cohorts. | REPORT-FLOW |
| D10 | CRM read timeline + derived open actions first; commercial opportunity entity/quotation workflow deferred until separately accepted (do not invent financial data). | CRM-FLOW |
| D11 | Technical need capture works in core; module-specific service/stock/finance mutations gated by module policy, no implicit creation. Optional-module off history retained and protected. | MOD-FLOW |
| D12 | Current permission/assignee constraints and REPORT-002 preserved, no automatic cascade; corrections append evidence; no production activation without separate gate. | all |

Open implementation details: final enums/labels, treatment of held legacy FOLLOW_UP_REQUIRED, optional stop authorization and reason list, exact customer report privacy, replacement with physical execution evidence, opportunity/quote ownership, module contracts and legal/device traceability. Resolve in slice review, do not fabricate a past decision. No general relation graph until concrete unmet need demonstrated.
