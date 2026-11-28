# Independent review reconciliation — PR #522

Date: 2026-11-26. Reviewed head 18d6d3d43a7abbaef3b661824dc42a620dd7adb2; main 873c4285cbcf6735a9908fffe80b48d6882a1fa4. Owner supplied code-agent review (DeepSeek, Hydrogen, Sol; reported static citations verified). This package resolves the cited contradictions in planning; no production or canonical policy changes. Product direction approved earlier; specific new policy amendments below are recommended contract defaults for owner/slice acceptance, not retroactive accepted decisions.

| Finding | Resolution | Owning change/gate |
| --- | --- | --- |
| CI docs-only convention | PR title and new correction commit [skip ci]; PR body corrected; two historical commits retained, no force-push or claim prior CI cancelled. Implementation PRs normal CI per AGENTS §9. | docs-only PR |
| REPORT-001 conversion cutoff | Remove proposed 30/60/90 thresholds and matured cohort. Use source-period, linked approved sale as of read, no elapsed cutoff; duration descriptive only. | D09, 04 §2, REPORT-A, A21; REPORT-001 stays binding |
| Not-held date | Preserve migration 007 meeting_details_follow_up_check and legacy nextFollowUpAt null. Separate optional typed proposedFollowUpAt for next action, new forward migration, authoritative future/lead validation, snapshot and approval; JOB-010/008 extension expressly named. | D03, ENG-B, 02 §2/4, A04/A05; canonical SLA/API/schema updates with code |
| Queue | Explicit JOB-010 amendment of oldest deadline sort and >3 Overview link, retain current behavior until RESCUE-005 tested; core Jobs route and risk/age ordering. | D16, 06 §6, owning SLA and DECISIONS |
| REPORT-002 actor metric | staff_completed_by + staff_completed_at feeds Onaya gönderme kaydı; never completed-work ownership. | 04 §2 |
| DESIGN.md citations | Correct immediate press 18/501, adapter 178/239/253, access 482–484. | 07 §1 |
| Reason vocabulary | Separate assignment-offer/change-request enums, align shared literal CUSTOMER_POSTPONED and WRONG_PRODUCT; add OUT_OF_TOWN only to assignment if accepted, no INCORRECT_JOB_DETAILS duplicate. | D13, 06 §3 |
| Follow-up mapping | Legacy 7/14 unchanged; new routine mandatory predicate explicit (not held/decision pending 7, interested 14; other outcomes explicit management disposition); other kinds opt-in; no silent closure. | D03, 02 §2; explicit JOB-008/009 amendment |
| Audit | Changed field names only for meeting details; business values in authorized detail/snapshot, no before/after metadata expansion. | 02 §4, DOM-003/007 |
| Sale as follow-up source | Preserve ordinary source_job_card_id exclusion; new named POST_SALE_VISIT relation from approved SALE, explicit narrow SALE-002 amendment; no implicit follow-up loop or conversion. | D05, 03 §2, FLOW-B |
| Physical evidence | Block all linked replacement while actual physical evidence or unresolved evidence exists, even after manager review, in FLOW-C. Future WH/SALE verified reversal/remaining quantity decision separately. | D06/07, 03 §3, A16 |
| OVR-7 | New record-only neutral acknowledgement must not qualify for operational lateness group; explicit OVR-7/JOB-010 amendment; preserve historical code semantics and classifications, evidence-bound new mutations. | D14, 06 §4, R-A09 |
| Accessibility | Add 400% reflow and reduced motion, 200% text, focus, keyboard, equivalent non-motion feedback. | 02 §5, 05 A26, 07 UI-F11 |
| saveJobPatch latent defect | Confirm static source: patch commits, then refreshTruth throws before success message; separate committed receipt from read/transport result in first feedback slice; browser repro required. | 07 §1, UI-F08, UI-FEEDBACK/A |

No new acceptance IDs; clarify existing 60 scenarios. Independent review is static only; no build, PG, browser, live data or deployment. All canonical decisions remain authoritative until corresponding implementation PR explicitly amends them with tests. No force push, merge or deployment.
