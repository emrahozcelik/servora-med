# CRM-FLOW / REPORT-FLOW / MOD-FLOW — Read models and optional module integration (proposal)

## 1. CRM customer context
CRM remains customer/contact owner. Add read-only authorized timeline based on canonical JobCards/events and named module ports; no duplicated mutable customer master. Display recent actual held engagement vs last attempt; next planned visit; open routine cycle, open proposals, approved sales, deliveries pending/completed/exception, optional service cases. Group related actions but allow independent phone orders. Paginate stable cursor (event time + ID) per existing pagination standard, bounded indexed queries; don't load full graph or all customers. Manager/Admin org scope; staff own authorized jobs and scoped customer visibility only, no unauthorized commercial/finance/service details or IDs. Restricted placeholders only where existing policy permits. Use actual contact separately from planned; no inference. No full opportunity pipeline in first release: derive open interest/action list with explicit labels and source links. Persist opportunity/quotation only after a separate CRM/ACC ownership and lifecycle decision (no fictitious prices/forecast revenue). Customer inactive/prospect rules unchanged; no silent activation.

## 2. Reporting contracts
Define metric dictionary before UI, retain old endpoints/labels until explicit rollout. Use organization timezone and half-open range, authoritative asOf, BUSINESS vs DEMO as owning report policy (never mix silently), invalidated excluded from operational cohorts; cancelled separate, no duplicate count from joins. REPORT-002 assigned_to at completion for each independent card; submission actor remains audit only. Do not count sale agreement as delivery or financial revenue; distinguish approved from waiting. Current queue snapshot vs historical event cohort labelled distinctly.

| Metric | Definition |
| --- | --- |
| Held engagements | distinct approved completed meeting IDs, occurrence HELD / actual meetingAt, range by actual time; legacy held inferred only if unambiguous under accepted adapter, otherwise unknown bucket |
| Attempts not held | approved NOT_HELD, no meetingAt, attemptedAt if explicitly recorded else labelled completion-time basis; not denominator for held conversion |
| Engagement type/channel | by persisted engagementKind and actual channel, unknown bucket, no reinterpretation of old OTHER |
| Follow-up engagements | kind FOLLOW_UP, including manually created; separate linked follow-up child metric by source_job_card_id, same customer and authorized non-invalidated lineage |
| Direct conversion | distinct held source visits with >=1 approved SALE whose sale_source_visit_id matches and customer matches; denominator same source cohort, count visit once even multiple historical sales |
| Standalone sales | approved SALE with null source, soldAt basis; excluded from visit conversion |
| Chain conversion (later) | explicitly traversed valid follow-up lineage to root; separately labelled, bounded and deduped, do not infer from same customer alone; no causal claim |
| Fulfillment | distinct approved sales with no delivery / active attempt / successfully completed / cancelled requiring action / reconciliation required; delivery counts and quantities separate |
| Scheduled overdue follow-up | canonical scheduled lifecycle/OVR incident definition, not due_date fallback; separate from existing due-date-only metric, unaccepted past start separated, JOB-007 remaining occupancy not deadline |
| Product interest | distinct engagement/product with structured interest, no quantity/revenue claim, filters by engagement type/time |
| Lost/blocked | explicit blocker/not interested; unknown not treated as lost; no causal inference from absent sale |

Conversion windows 30/60/90 days proposed: cohort start actual held time; sale soldAt >= occurrence and < occurrence+window, approved by asOf; matured sources (window ended by asOf) denominator, open/unmatured cohort separately shown, 0 denominator -> unavailable not 0%. Direct links outside window visible but not counted. Funnel stages must share same source cohort and count distinct sources consistently; independent orders separate. Stages without implemented quote entity are not shown as completed quotation metrics; optional interest/quote-request capture is not offer issued. One visit may lead to multiple sales; fulfillment detail per sale, visit-level funnel uses distinct visit, explicit all/any fulfilled definition decided before release. Show raw count, denominator and definition; no misleading employee sales ranking across role types.

Time semantics: preserve existing actual meetingAt, soldAt, deliveredAt, manager_approved_at, staff_completed_at meanings; do not replace one with another. AsOf is current-known state cut unless immutable snapshot supports true historical replay; label later corrections/invalidation effects. Existing business-trend uses direct links as of request; improve labels, not silent metric rewrite. Reports filters and drill-down must use same cohort and authorization. Index/EXPLAIN and bounded paging performance for representative dataset; no N+1, unbounded recursive query, or new report cache without evidence.

## 3. Module boundaries
MOD-001/002/003 remain binding. Registry 075 already widened; new descriptors only via owning slice, no dependency engine. Calendar off core SCH-001 occupancy remains. Messaging off work, notifications required by core and audit continue according to accepted policy. Warehouse off agreement/delivery continue without stock mutation; maintenance off core technical-need record/general follow-up remains, no MNT case creation; accounting off no financial operation, agreement/delivery unaffected. Optional module disable hides new module actions and gates server mutation/worker/realtime per owning contract; preserve historical data, visibility and in-flight continuation as that contract explicitly allows, never delete/cascade. Fail closed if state read fails for module action; core unaffected. Re-enable no unreviewed catch-up posting or duplicate documents.

| Handoff | Owner and boundary |
| --- | --- |
| SALE approved / delivery execution | Core emits canonical provenance; WH later owns reservation/posting/reconciliation, event identity and quantities. #517 WH-A standalone first. |
| Technical need / installation / repeat service | MNT owns asset and service case, links JobCards via accepted port. #516 first; no duplicate asset/case tables in ENG. |
| Sale / quote request / invoice candidate | ACC owns financial references, grants, amounts, document lifecycle; #515 ACC-A proposal; no automatic invoice/payment or ledger entry from core. |
| Schedule | core owns planned occupancy; optional Calendar owns manual events/display/reminders per SCH-001. |
| Communication | messaging module owns thread/access lifecycle; not prerequisite for action approval or assignment. #518 separate. |

Integration contract per pair of modules before implementation: producer event/version/identity and authorized minimal payload, consumer state generation and idempotent key, atomic local transaction or explicit recoverable outbox only if needed, lock order/no network in DB transaction, retry and reconciliation, disable/re-enable race, restore/replay, permission and audit, compensation by owning module not core. No automatic writes to optional module tables across boundaries. Avoid claiming financial or physical reversal based on job status. Recheck exact heads and accepted state of #515–518 before each integration.
