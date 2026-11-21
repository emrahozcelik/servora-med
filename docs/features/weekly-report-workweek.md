# Weekly Report workweek period, Friday deadline and simplified content (WR-WEEK)

- **Status:** Accepted product contract, implementation pending — `DECISIONS.md` WR-WEEK (owner,
  2026-11-21: "haftalık raporlar cuma günü isteniyor, pazartesiden cumaya kadar
  yapılan işleri kapsıyor"; the proposed defaults D1–D3 accepted the same day
  with "evet hazırla"; D9 option (a) chosen with "önerinle a ile devam
  edelim"). Ships with the code in one PR (no docs-only PR).
- **Date:** 2026-11-21
- **Scope:** period, deadline and automatic work-list window of **new** Weekly
  Reports; the Staff report form; the manager create screen; date display.
- **Amends:** Weekly Report V1 Slice 1 (Monday–Sunday period, DB-enforced
  `period_end = period_start + 6`), Slice 2 (due date = Monday after
  `period_end`; six body sections), the field-test server-only deadline rule
  (only its formula; the server-only and immutable properties stay), and the
  five preset manager questions of the V1 field-test remediation.
- **Unchanged:** Staff/week identity and uniqueness (one current report per
  `organization_id + staff_user_id + period_start`), Admin removal and period
  release, generic CANCEL/INVALIDATE reserving the week, manual requests only
  (recurrence retirement 2026-10-23 stays in force), idempotency, mandatory
  manager approval, immutable submissions and frozen PDFs, lifecycle and
  lateness contracts (OVR-*), report attribution.

## 1. Problem

Weekly reports are requested on Friday and describe the Monday–Friday work of
that same week. The system models a Monday–Sunday week and sets the deadline to
the following Monday. A report requested on Friday 20 November 2026 therefore
shows "16–22 Kasım", is due on 23 November, and becomes overdue only on
Tuesday 24 November. The form also asks Staff the same five things twice when a
manager selects the preset questions, which duplicate the fixed sections.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | A new report covers the organization-local **workweek**: `period_start` is an ISO Monday and `period_end = period_start + 4` (Friday). |
| D2 | The deadline is **the Friday of the period** (`due_date = period_end`), computed by the server only and immutable afterwards. Under the existing overdue contract (`due_date < organization-local today`) the report becomes overdue at Saturday 00:00 organization-local time. |
| D3 | The automatic work list covers Monday 00:00 (inclusive) → Saturday 00:00 (exclusive), organization-local. Work completed on Saturday or Sunday belongs to no weekly report. |
| D4 | The default week on the create screen is the organization-local current week; on Saturday and Sunday it is the workweek that just ended (same ISO week). |
| D5 | The Staff form has three sections: **Bu hafta** (`summary`, required), **Sorunlar ve destek ihtiyacı** (`blockers`, optional), **Gelecek hafta planı** (`nextWeekPlan`, required). `highlights`, `fieldObservations` and `supportNeeded` are no longer offered for new writing. |
| D6 | The five preset manager questions are removed. Managers add only report-specific custom questions. |
| D7 | Historical data is never rewritten: existing 7-day reports, their due dates, drafts, submissions, frozen questions/answers, source-work snapshots and PDFs remain exactly as stored and keep rendering all their original fields **with their original labels** (a 7-day record shows the six V1 sections as "Haftanın özeti", "Sorunlar / engeller", …; only workweek records use the D5 labels). |
| D8 | A manager request that resolves to an **existing** report never navigates as if a report had been created; the screen states that the report already exists, links to it, and says that a cancelled report can be replaced only after an Admin removes it. A bulk result states created and existing counts separately. |
| D9 | A request created after the Friday of its week (e.g. Saturday/Sunday for the just-ended week, D4, or "Geçen hafta") is never born overdue: `due_date = max(period_end, organization-local creation date)`. A normal request (Monday–Friday of the period, or earlier) is due on Friday. The reference read returns the same derived `dueDate` for the create preview. Rejected (b): always Friday with an "opens overdue" warning, because OVR-3/OVR-4 would open `LATE_SUBMISSION`, remind Staff after 15 min and escalate after 60 min on a report that was requested late. |
| D10 | Create and report screens use the owner-accepted UI proposals of 2026-11-21: week choice "Bu hafta / Geçen hafta / Başka hafta", a period + deadline preview before sending, Turkish calendar dates instead of raw ISO dates on weekly-report surfaces, and Staff save/submit actions reachable on mobile without scrolling past the form. |

### Rationale and rejected alternatives

- **Deadline Monday morning (grace period):** rejected by the owner; the report is
  requested and due on Friday.
- **Keep Monday–Sunday and only move the deadline:** rejected; the report would
  claim Saturday/Sunday it does not describe and could list weekend work after
  submission.
- **Rewrite existing periods to Monday–Friday:** rejected; frozen submissions and
  PDFs are historical evidence (D7).
- **Automatic Friday request:** out of scope; recurrence retirement stays binding.

## 3. Data and migration

Migration `068_weekly_report_workweek.sql` (051 and 061 stay untouched):

- `weekly_reports`: replace `weekly_reports_period_end_check`
  (`period_end = period_start + 6`) with
  `CHECK (period_end = period_start + 4 OR period_end = period_start + 6)`.
  `weekly_reports_period_monday_check` is unchanged.
- `weekly_report_submissions`: replace `weekly_report_submissions_period_check`
  with `CHECK (EXTRACT(ISODOW FROM period_start) = 1 AND (period_end =
  period_start + 4 OR period_end = period_start + 6))`.
- Submission/report period agreement: add
  `UNIQUE (organization_id, id, period_start, period_end)` on `weekly_reports`
  and a composite foreign key `(organization_id, weekly_report_id,
  period_start, period_end) REFERENCES weekly_reports (organization_id, id,
  period_start, period_end) ON DELETE RESTRICT` on `weekly_report_submissions`.
  The widened CHECKs alone would allow a 5-day submission under a 7-day report;
  existing rows copy the parent period, so validation succeeds, and any
  mismatch makes the migration fail clearly instead of being repaired.
- No new column, no data update. The six `draft_*` columns and their bounds stay.
- The current-report partial unique index
  `weekly_reports_current_staff_week_key (organization_id, staff_user_id,
  period_start) WHERE removed_at IS NULL` is unchanged and still identifies one
  report per Staff/week, because both shapes start on the ISO Monday.

**Why not a `period_days` discriminator or a `created_at` cutover in the CHECK:**
the period length is already derivable from the immutable `period_start` /
`period_end` pair, so a discriminator duplicates state; a `DEFAULT 5`
discriminator would also make the previous release's 7-day inserts fail,
turning any rollback into a forward-fix. A `created_at < cutover` CHECK would
reject post-deploy submissions of pre-deploy 7-day reports (A8). The rule
"new reports are 5-day" is owned by the single server parser
`parsePeriodStart` and pinned by tests; the database guarantees that every
row is either a valid workweek or a legacy calendar week. Period columns are
written only at insert and never updated.

## 4. Server behaviour

| Area | Change |
|---|---|
| `weekly-reports/validation.ts` `parsePeriodStart` | `periodEnd = periodStart + 4`; ISO-Monday check unchanged. |
| `weekly-reports/reference.ts` | `periodEnd = periodStart + 4`, `dueDate = max(periodEnd, today)` (D9). The Monday offset already returns the just-ended week on Saturday/Sunday (D4). |
| `job-cards/service.ts` single create and bulk request | `dueDate = max(input.periodEnd, organization-local date of the request instant)` (both call sites; one shared pure helper next to `currentWeeklyReportPeriod`, using the organization timezone already read for the reference). Comments that state "Monday after the period" are updated, also in `weekly-reports/create-input.ts` and `weekly-reports/repository.ts`. |
| `weekly-reports/source-work.ts` `weekInstants` | New exact signature `weekInstants(periodStart: string, periodEnd: string, timezone: string)`; window end = `periodEnd + 1` 00:00 organization-local. This yields Saturday 00:00 for workweek reports and keeps Monday 00:00 for open legacy 7-day reports. All callers (`getWeeklyReport`, submission snapshot, `submission-policy.ts`) pass the stored period. |
| Body validation | Unchanged API shape: drafts still accept the six optional keys and submission still requires `summary` + `nextWeekPlan`. Old web bundles and open legacy drafts keep working; the reduction to three sections is a presentation decision (§5). |
| Idempotency hashes | Unchanged. A create request sent before the deploy and retried with the same `clientActionId` after it gets `CLIENT_ACTION_REUSED` (its derived `periodEnd` differs); this is the safe outcome and is documented in the release note. |
| PDF `document-model.ts` | A workweek record (`period_end = period_start + 4`) renders the three D5 sections with the new labels. A 7-day record renders the six V1 sections with their original labels, exactly as today (D7). Frozen preset questions render as stored. |
| Unchanged | overdue contract, lateness/OVR, reports, overview, offboarding, removal, identity index, `weeklyReportTitle` format (it follows the stored period). |

## 5. Web behaviour

| Surface | Change |
|---|---|
| `WeeklyReportQuestionEditor.tsx` | Remove `WEEKLY_REPORT_PRESET_QUESTIONS` and the preset checkboxes; keep custom question add/edit/remove. Remove the now-unused `.weekly-question-preset*` styles. |
| `WeeklyReportCreate.tsx` week choice | Replace the raw Monday date input with choices "Bu hafta · 16–20 Kasım", "Geçen hafta · 9–13 Kasım" and "Başka hafta" (date input kept for the last one). |
| `WeeklyReportCreate.tsx` preview | Before submit: "Dönem 16–20 Kasım 2026 · Son teslim 20 Kasım Cuma"; intro copy describes the workweek and Friday deadline. |
| `WeeklyReportCreate.tsx` outcomes (D8) | Navigate only when the single item's outcome is `created`. For `existing`, show "Bu personelin bu hafta için raporu zaten var" with "Mevcut rapora git", plus the hint that a cancelled report can be replaced only after an Admin removes it. Bulk result copy reports created and existing counts separately. |
| `WeeklyReportDetail.tsx` editor | Workweek report: three fields: **Bu hafta** (`summary`, required), **Sorunlar ve destek ihtiyacı** (`blockers`, optional), **Gelecek hafta planı** (`nextWeekPlan`, required). A legacy field with stored text stays visible and editable under "Önceki form alanları" until submission (complete-replacement PATCH must not null it). `draftsEqual` compares all six keys so editing a legacy field marks the form dirty. An open 7-day report keeps the six-field V1 editor and labels. |
| `WeeklyReportDetail.tsx` mobile actions | On narrow viewports the save/submit actions are reachable without scrolling past the form (sticky action bar following DESIGN.md); readiness checklist summary shown above the form. |
| `WeeklyReportDetail.tsx` frozen/history | Frozen report and history render every stored body field that has text, with the labels of the record's shape (D7); this also fixes the history view, which today omits `highlights`, `fieldObservations`, `supportNeeded`. |
| Date display | One shared web helper formats `YYYY-MM-DD` calendar days and ranges in Turkish ("16–20 Kasım 2026", "20 Kasım Cuma"), replacing raw ISO dates in weekly report detail header/facts, create screen, removal dialog and staff history. The page header no longer repeats the period three times. |
| `weekly-report-api.ts` | Parsers unchanged (they accept any `YYYY-MM-DD` period and the six body keys). |

## 6. Acceptance scenarios

Organization timezone `Europe/Istanbul`; dates are organization-local.

| # | Given | When | Then |
|---|---|---|---|
| A1 | Friday 2026-11-20 10:00 | reference read | `periodStart 2026-11-16`, `periodEnd 2026-11-20`, `dueDate 2026-11-20` |
| A2 | Sunday 2026-11-22 | reference read | same week as A1 (the workweek that just ended) |
| A3 | Monday 2026-11-23 00:30 | reference read | `2026-11-23 – 2026-11-27`, due `2026-11-27` |
| A4 | manager bulk request for week 2026-11-16 | create | each new report has `period_end 2026-11-20`, `due_date 2026-11-20`, title shows the 5-day range |
| A5 | request body with any `periodEnd`/`dueDate` field | create | rejected as unknown field (server-only authority unchanged) |
| A6 | a 2026-11-16 report still open | 2026-11-21 00:00 | report is currently overdue; on 2026-11-20 23:59 it is not |
| A7 | work completed Fri 23:59, Sat 10:00 and Mon 00:00 of the next week | draft/live list and submission snapshot | only the Friday item appears in the 2026-11-16 report |
| A8 | an existing 7-day report (e.g. 2026-11-09 – 2026-11-15, due 2026-11-16) | draft save, submit, approve, remove, PDF | all succeed unchanged; period, due date and title are not rewritten; its live list and snapshot still include Saturday/Sunday (2026-11-14/15) completions |
| A9 | historical submission containing `highlights`, `fieldObservations`, `supportNeeded` and preset answers | detail, history, PDF | every stored field and frozen question renders |
| A10 | new draft | Staff form | exactly three sections; submit requires `summary` and `nextWeekPlan` |
| A11 | an in-progress legacy draft with text in a removed section | Staff form | that text stays visible and editable until submission; nothing is silently dropped |
| A12 | manager selects one staff member whose report for the week already exists (any status, not removed) | bulk request | no navigation; message "Bu personelin bu hafta için raporu zaten var" with a link to it |
| A13 | bulk request with created and existing outcomes | result screen | copy states both counts; never "each report was created" |
| A14 | manager create screen | open | no preset question checkboxes; custom questions still work; due-date preview shows "20 Kasım Cuma" |
| A15 | two parallel creates for the same staff/week | create | exactly one report (existing locking/uniqueness unchanged) |
| A16 | organization timezone `America/New_York`, week 2026-03-09 (DST starts Sunday 2026-03-08) | window | Monday 2026-03-09 00:00 EDT → Saturday 2026-03-14 00:00 EDT |
| A17 | a submission row whose period differs from its report row | direct insert | rejected by the composite foreign key |
| A18 | Saturday 2026-11-21, manager requests the default week; or Monday 2026-11-23 requests week 2026-11-16 | create and reference | due `2026-11-21` (resp. `2026-11-23`), not overdue at creation, no immediate `LATE_SUBMISSION`; reference read on 2026-11-21 returns `dueDate 2026-11-21` |
| A18b | Wednesday 2026-11-18, request for a future week 2026-11-23 | create | due `2026-11-27` (Friday of that week) |
| A19 | legacy draft text in `supportNeeded` | Staff edits only that field | form becomes dirty, save keeps all six keys, submit includes it |
| A20 | 7-day historical submission | history view and PDF | six V1 labels; workweek submission shows the three D5 labels |
| A21 | create screen on Friday 2026-11-20 | open | "Bu hafta · 16–20 Kasım" preselected; preview "Son teslim 20 Kasım Cuma"; dates are Turkish everywhere on weekly-report surfaces |
| A22 | Staff in IN_PROGRESS at 390 px | open report | save and submit reachable without scrolling past the form; readiness summary visible above it |

## 7. Implementation plan and fleet split

The contract above (§3–§5, §6) is the shared interface; no DTO or endpoint
changes, so layers can proceed in parallel. Owner instruction (2026-11-21):
the worker fleet for this feature is **Hydrogen**. Each writer works in its own
git worktree and test database; no two writers touch the same file.

| Step | Worker | Files | Done when |
|---|---|---|---|
| 1. Backend | Hydrogen (writer) | migration 068; `weekly-reports/{validation,reference,source-work,types,history-port,create-input,repository}.ts`; `weekly-reports/pdf/document-model.ts`; `job-cards/{service,submission-policy}.ts` call sites and comments; server unit tests that pin +6/+1 (`weekly-report-validation`, `-pdf`, `-submission-policy`, `-migration`, `job-card-routes`); `weekly-report-source-work-postgres.test.ts` (it calls `weekInstants` directly); every test that pins the migration head or count (`067_overdue_delivery_identity_per_incident`, `67`: `migration-catalog`, `migration-reader-order-postgres`, `schema-check`, `sd2-startup-readiness-guard`, `migrate-runner`, `job-card-accountability-facts-postgres` and the other files a `rg` for those literals finds) | `npm run build` + touched unit tests pass |
| 2. Web | Hydrogen (writer) | `WeeklyReportCreate.tsx`, `jobs/WeeklyReportQuestionEditor.tsx`, `jobs/WeeklyReportDetail.tsx`, `jobs/WeeklyReportRemovalAction.tsx`, `StaffProfiles.tsx`, new shared calendar-date helper, `styles.css` weekly rules, web tests, `web/scripts/weekly-report-*`, `visual-improvements-fixture.ts`, `sof2c-actionable-resolution-browser.mjs` fixtures and geometry thresholds | `npm run build` + web tests + `npm run smoke:weekly-report` pass |
| 3. PostgreSQL tests | Hydrogen (independent writer; reads only this contract, the public service API and the pinned `weekInstants` signature) | the remaining `server/tests/weekly-report-*-postgres.test.ts` and a new `weekly-report-workweek-postgres.test.ts` covering A1–A8, A15–A18, including legacy 7-day rows inserted directly | tests written against the contract; run after merge |
| 4. Docs | lead | user manual §7.4, `docs/README.md` index, this contract's status | — |
| 5. Review | Hydrogen critic (separate session) → lead | merged branch | findings resolved |
| 6. Visual check | Hydrogen | Playwright captures per UI-003 (390 px and 1440 px; create, NEW/ACCEPTED/IN_PROGRESS/COMPLETED detail, legacy 7-day report) | evidence recorded |
| 7. Verification | lead | `cd server && npm run build && npm test -- --run`, `cd web && npm run build && npm test -- --run`, smokes; exact-head hosted CI | all pass |

Order follows the project's fleet rules: writers → Hydrogen review → lead review
and fixes → authoritative build/tests → commit/PR. Migration 068 must be
re-checked for a number collision with any branch merged first.

## 8. Rollout and rollback

- **Open reports at deploy time** keep their stored 7-day period and Monday
  deadline (D7). Only reports created after the deploy use the workweek.
  Managers may want to know that the week of the deploy can contain both kinds;
  the release note says so.
- **Rollback:** the migration only widens the period constraints, so the
  previous release can still write 7-day rows, and its web parsers accept any
  `YYYY-MM-DD` period and the unchanged six-key body. After a rollback the
  previous server would compute a Monday→Monday work-list window for workweek
  reports created meanwhile (weekend work could appear in their live list and
  snapshot); stored periods and deadlines stay correct. Rollback is therefore
  allowed but not lossless for that window; prefer forward fixes.
- **Idempotent retries across the deploy** receive `CLIENT_ACTION_REUSED`
  (§4); the user simply creates the request again.
- **Night notifications:** a workweek report still open on Friday night opens
  `LATE_SUBMISSION` at Saturday 00:00, so OVR-4 reminds Staff at about 00:15 and
  escalates at about 01:00 on Saturday. The same happens today on Tuesday night;
  quiet hours are stage 2 of the lateness plan and out of scope here.
- **Production:** migration, deploy and any production read remain separate
  owner-approved gates (one-click deploy contract).
