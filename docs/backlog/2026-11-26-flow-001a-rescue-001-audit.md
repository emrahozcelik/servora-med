# FLOW-001/A and RESCUE-001 — baseline audit evidence

Date: 2026-11-26 (Europe/Istanbul). Base: `873c4285cbcf6735a9908fffe80b48d6882a1fa4`.
Status: EVIDENCE. These are characterization results of **current** behavior,
not accepted policy changes. The planning package that defines F01–F09, R01–R07
and the follow-up slices is the docs-only PR #522 (not merged); its proposals
stay drafts until accepted with code and tests (AGENTS.md §§3, 15).

Tests (synthetic data, isolated PostgreSQL 17 schemas):

- `server/tests/flow-001a-baseline-findings-postgres.test.ts` — F01–F08
- `server/tests/rescue-001-assignment-recovery-postgres.test.ts` — R01, R03, R04, R06, R07
- `server/tests/rescue-001-ovr7-record-only-closure-postgres.test.ts` — R04 × OVR-7
- `web/tests/rescue-001-assignment-recovery.test.tsx` — R02, R05

When a later slice intentionally changes one of these behaviors, it updates the
matching expectation in the same PR, together with the owning decision/contract.

## FLOW-001/A — engagement, follow-up, sale and report baseline

| ID | Reproduced | Current behavior | Classification | Target slice |
| --- | --- | --- | --- | --- |
| F01 | Yes | `FOLLOW_UP_REQUIRED` requires `unsuccessfulReason` at write and submit time; a held, undecided meeting cannot request a follow-up without being declared unsuccessful. Held `POSITIVE` auto-proposes a follow-up. | Accepted model limitation (JOB-008, JOB-010 2a) | ENG-A / ENG-B |
| F02 | Yes | Outcome totals and business-trend visits group every completed `SALES_MEETING` regardless of engagement kind (customer visit, manual follow-up, demo). Not-held visits (null `meeting_at`) are excluded from business-trend but included in the follow-up outcome distribution. | Missing dimension, not a wrong legacy metric | REPORT-A |
| F03 | Yes | Migration 071 index is lifetime-unique on `delivery_source_sale_id`; a cancelled or invalidated linked delivery still blocks a second linked delivery. | Accepted limitation (SALE-002 Q4) | FLOW-C (SALE-003) |
| F04 | Yes | A `SALES_MEETING` follow-up child cannot carry `dueDate`; the sales follow-up report's due-date "overdue" counter therefore shows 0 for a past-start automatic child, while the canonical overdue scanner does record a `LATE_START` incident for it. | Report exposure gap, not operational invisibility | FLOW-001/B |
| F05 | Yes | SALE cannot be a follow-up source; the mandatory loop is limited to `CUSTOMER_VISIT`/`FOLLOW_UP` and rejects non-`SALES_MEETING` types for Staff submission and Manager approval. A stored legacy non-loop proposal can still be changed by a manager to `GENERAL_TASK`. | Accepted scope; see drift D1 | ENG-B / FLOW-B |
| F06 | Yes | `TRAINING` and `OTHER` are not eligible sale origins. | Accepted restriction (SALE-001/002) | FLOW-B |
| F07 | Yes | Business-trend "follow-up" counts use `source_job_card_id` provenance: a linked `PRODUCT_DEMO` child counts, a source-less manual `FOLLOW_UP` meeting does not. | Metric definition gap | REPORT-A |
| F08 | Yes | Business-trend relationships treat follow-up children as visits; a sale linked to the child is attributed to the child's day (`visitsWithSale` 0 on the root day, 1 on the child day). No delivery dimension. | Metric definition gap; direct vs chain conversion must stay separate | REPORT-A / REPORT-B |
| F09 | Doc only | `docs/features/visit-to-sale/sale-002-contract.md` header says S4 in progress; `DECISIONS.md` SALE-002 records S1–S4 implemented (S4 = #495, `3a278c2`). | Documentation drift | Reconcile when a slice touches SALE-002 |

### Drift found during FLOW-001/A

- **D1 — JOB-008 wording.** JOB-008 §Consequences says managers can change the
  follow-up type at approval; on the mandatory loop the backend rejects any
  non-`SALES_MEETING` type for both roles (only legacy non-loop proposals allow
  it). Decision-text scope ambiguity, not a runtime defect. Resolve in ENG-B.
- **D2 — Unreachable guard.** The Staff default-type `FORBIDDEN` checks in
  `job-cards/service.ts` (~8596, ~8813) are not reachable on current submit or
  approve paths; the earlier `FOLLOW_UP_PROPOSAL_INVALID` check rejects first.
  The restriction holds. Record it before refactoring the follow-up policy.

## RESCUE-001 — assignment refusal and recovery baseline

| ID | Reproduced | Current behavior | Classification | Target slice |
| --- | --- | --- | --- | --- |
| R01 | Yes | Decline/release accepts an alternative time only with `SCHEDULE_CONFLICT` and requires it there; `ON_LEAVE`, `TOO_FAR`, `MISSING_STOCK_OR_EQUIPMENT`, `OTHER` reject a proposed time. | Accepted limitation (JOB-012 §1) | RESCUE-002 |
| R02 | Yes | After a decline, recovery actions are ordered by reason ("Önerilen zamanı onayla" first only with a valid proposal); cancel lives in the separate actions panel. Reassignment opens the generic field editor. | UX gap, backend capability exists (JOB-010, JOB-012) | RESCUE-003 |
| R03 | Yes | A declined or released job stays `NEW` and keeps occupying the original staff interval: an overlapping create returns `409 CALENDAR_CONFLICT` (Calendar on or off) and available slots exclude the interval. | Accepted behavior (SCH-001 §1, JOB-010 §5); change needs an explicit SCH-001 amendment | RESCUE-004 |
| R04 | Yes | `resolveChangeRequest` can close a request (e.g. `RESCHEDULED`) without changing the job (record-only); a real schedule PATCH resolves atomically and rolls back on an unknown request. | Accepted (JOB-010 D1, OVR-5 §4.11) | RESCUE-003 |
| R05 | Yes | The compact intervention panel shows 3 rows per group and links to `/overview`; with Overview off that link and the direct route redirect to `/jobs`. Items 4+ of the intervention queue are unreachable; individual jobs remain reachable from the Jobs list. | **Defect** (Overview coupling, MOD-002/003) | RESCUE-005 |
| R06 | Yes | Needs-action offers and OVR-6 unaccepted-past-start lists are disjoint; urgent or overdue `OPEN` offers appear in needs-action before the expiry worker runs. | Compliant (JOB-010 §8, OVR-6) — preserve | RESCUE-005 |
| R07 | Yes | Staff cannot `CANCEL` with the assignment window enabled; offer expiry never cancels the job. | Compliant (JOB-010 §6, D1) — preserve | RESCUE-002…006 |

### R04 × OVR-7 — record-only closure and lateness attribution

Per `docs/features/reporting/lateness-reports.md` §4.3, a `RESCHEDULED`,
`CORRECTED` or `LINKED_JOB_CREATED` resolution qualifies as a management
decision by the resolution alone. A record-only `RESCHEDULED` closure that
overlaps the same Staff member's `STAFF_PROVEN` incident therefore moves that
incident to "Yönetimce sonuçlandırılan değişiklik talebiyle ilişkili
gecikmeler" even though the job was not changed; a `REJECTED` closure leaves it
in Staff responsibility. This is current accepted behavior (OVR-7 §4). The
RESCUE-003 proposal for a neutral record-only acknowledgement would change it
and needs an explicit OVR-7 amendment.

### Occupancy consumers (input for RESCUE-004)

The shared reader is `job-cards/occupancy.ts`. Consumers: JobCard create,
product delivery create, follow-up create, sale-approval delivery, management
patch (reschedule/reassign), JOB-012 proposal acceptance, available slots,
follow-up auto-scheduler, staff offboarding transfer, and Calendar manual-event
conflict checks. **`people/offboarding.ts` (calendar-assignment check) repeats
the occupancy query inline** instead of calling `occupancy.ts`, without the
`j.type IN ('SALES_MEETING','PRODUCT_DELIVERY')` filter. Any occupancy
amendment must update both, or first route offboarding through the shared
reader.

## Verification

Authors ran targeted tests on isolated databases; an independent verifier
reviewed each test file and accepted it after one fix round. The lead ran the
full server suite (`npm test -- --run`, `DATABASE_URL=$TEST_DATABASE_URL`) with
these files: all new tests passed; the only failures were the two local
environment tests that also fail on main (`db-auth-contract`,
`local-evidence-deploy-gate`). No production data, browser session or deploy was
used. Hosted CI for the PR head is the authoritative run.
