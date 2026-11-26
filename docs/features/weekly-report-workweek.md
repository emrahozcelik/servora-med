# Weekly Report working-week period, Monday deadline and simplified content (WR-WEEK)

- **Status:** Accepted product contract, implemented on branch `feat/weekly-report-workweek` and verified locally (2026-11-21); hosted CI, merge and production deploy are separate gates — `DECISIONS.md` WR-WEEK.
  Owner decisions, 2026-11-21: the proposed defaults accepted with "evet
  hazırla"; late-request rule D9 option (a) chosen with "önerinle a ile devam
  edelim"; the period and deadline **revised the same day** before any release:
  "raporlar pazartesiden cumartesiye olacakmış. haftalık rapor istendiğinde
  cumartesi gününü kapsayacak. rapor pazar ve pazartesiye kadar
  gönderilebilecek." (This supersedes the earlier same-day Monday–Friday /
  Friday-deadline draft, which was never released.) Clarified and approved the
  same day ("pazartesiden cumartesiye olan işler haftalık rapordur. cumartesi
  günü akşam rapor gönderilebilir + 1 pazar günü gönderilebilir + 1 pazartesi
  deadline akşam iş gecikmiş sayılmaya başlar"), with the owner's answers:
  overdue starts at the end of Monday (Tuesday 00:00), submission is allowed at
  any time before the deadline, and a late request is due on its creation day
  (D9). A short-lived "always Monday, opens overdue" reading was withdrawn. Ships with the code in one
  PR (no docs-only PR).
- **Date:** 2026-11-21
- **Scope:** period, deadline and automatic work-list window of **new** Weekly
  Reports; the Staff report form; the manager create screen; date display.
- **Amends:** Weekly Report V1 Slice 1 (Monday–Sunday period, DB-enforced
  `period_end = period_start + 6`), Slice 2 (due date = day after
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

Weekly reports describe the Monday–Saturday working week. They are requested
during the week (typically Friday), cover Saturday as well, and may be submitted
on Sunday and up to and including Monday. The system models a Monday–Sunday
week: a report for the week of 16 November 2026 shows "16–22 Kasım" and lists
Sunday work that no report should contain. The form also asks Staff the same
five things twice when a manager selects the preset questions, which duplicate
the fixed sections.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | A new report covers the organization-local **working week**: `period_start` is an ISO Monday and `period_end = period_start + 5` (Saturday). |
| D2 | The deadline is **the Monday after the period** (`due_date = period_end + 2`, i.e. `period_start + 7`), computed by the server only and immutable afterwards. Staff may submit at any time before it (including Sunday and Monday). Under the existing overdue contract (`due_date < organization-local today`) the report becomes overdue at Tuesday 00:00 organization-local time. |
| D3 | The automatic work list covers Monday 00:00 (inclusive) → Sunday 00:00 (exclusive), organization-local. Work completed on Sunday belongs to no weekly report. The list is frozen at submission, so work finished after an early submission is not added. |
| D4 | The default week on the create screen is the organization-local current ISO week; on Sunday it is the working week that just ended (same ISO week). From Monday the default is the new week; the previous week is one tap away ("Geçen hafta"). |
| D5 | The Staff form has three sections: **Bu hafta** (`summary`, required), **Sorunlar ve destek ihtiyacı** (`blockers`, optional), **Gelecek hafta planı** (`nextWeekPlan`, required). `highlights`, `fieldObservations` and `supportNeeded` are no longer offered for new writing. |
| D6 | The five preset manager questions are removed. Managers add only report-specific custom questions. |
| D7 | Historical data is never rewritten: existing 7-day reports, their due dates, drafts, submissions, frozen questions/answers, source-work snapshots and PDFs remain exactly as stored and keep rendering all their original fields **with their original labels** (a 7-day record shows the six V1 sections as "Haftanın özeti", "Sorunlar / engeller", …; only working-week records use the D5 labels). |
| D8 | A manager request that resolves to an **existing** report never navigates as if a report had been created; the screen states that the report already exists, links to it, and says that a cancelled report can be replaced only after an Admin removes it. A bulk result states created and existing counts separately. |
| D9 | A request created after the deadline of its week (e.g. Tuesday or later for the previous week via "Geçen hafta") is never born overdue: `due_date = max(period_end + 2, organization-local creation date)`. A normal request (any day up to and including the Monday after the period) is due on that Monday. Rejected (b): always the Monday with an "opens overdue" warning, because OVR-3/OVR-4 would open `LATE_SUBMISSION`, remind Staff after 15 min and escalate after 60 min on a report that was requested late. |
| D10 | Create and report screens use the owner-accepted UI proposals of 2026-11-21: week choice "Bu hafta / Geçen hafta / Başka hafta", a period + deadline preview before sending, Turkish calendar dates instead of raw ISO dates on weekly-report surfaces, and Staff save/submit actions reachable on mobile without scrolling past the form. |

### Rationale and rejected alternatives

- **Monday–Friday period with a Friday deadline:** the first same-day draft;
  superseded by the owner before release because Saturday is a working day and
  reports are sent on Sunday/Monday.
- **Keep Monday–Sunday:** rejected; the report would claim Sunday it does not
  describe and could list Sunday work.
- **Block submission before Sunday:** not requested; Staff may submit as soon as
  the report is ready.
- **Rewrite existing periods:** rejected; frozen submissions and PDFs are
  historical evidence (D7).
- **Automatic Friday request:** out of scope; recurrence retirement stays binding.

## 3. Data and migration

Migration `068_weekly_report_workweek.sql` (051 and 061 stay untouched; 068 is
not released anywhere, so it is edited in place on this branch):

- `weekly_reports`: replace `weekly_reports_period_end_check`
  (`period_end = period_start + 6`) with
  `CHECK (period_end = period_start + 5 OR period_end = period_start + 6)`.
  `weekly_reports_period_monday_check` is unchanged.
- `weekly_report_submissions`: replace `weekly_report_submissions_period_check`
  with `CHECK (EXTRACT(ISODOW FROM period_start) = 1 AND (period_end =
  period_start + 5 OR period_end = period_start + 6))`.
- Submission/report period agreement: add
  `UNIQUE (organization_id, id, period_start, period_end)` on `weekly_reports`
  and a composite foreign key `(organization_id, weekly_report_id,
  period_start, period_end) REFERENCES weekly_reports (organization_id, id,
  period_start, period_end) ON DELETE RESTRICT` on `weekly_report_submissions`.
  The widened CHECKs alone would allow a 6-day submission under a 7-day report;
  existing rows copy the parent period, so validation succeeds, and any
  mismatch makes the migration fail clearly instead of being repaired.
- No new column, no data update. The six `draft_*` columns and their bounds stay.
- The current-report partial unique index
  `weekly_reports_current_staff_week_key (organization_id, staff_user_id,
  period_start) WHERE removed_at IS NULL` is unchanged and still identifies one
  report per Staff/week, because both shapes start on the ISO Monday.

**Why not a `period_days` discriminator or a `created_at` cutover in the CHECK:**
the period length is already derivable from the immutable `period_start` /
`period_end` pair, so a discriminator duplicates state; a discriminator with a
new default would also make the previous release's 7-day inserts fail, turning
any rollback into a forward-fix. A `created_at < cutover` CHECK would reject
post-deploy submissions of pre-deploy 7-day reports (A8). The rule "new reports
are Monday–Saturday" is owned by the single server parser `parsePeriodStart`
and pinned by tests; the database guarantees that every row is either a valid
working week or a legacy calendar week. Period columns are written only at
insert and never updated.

## 4. Server behaviour

| Area | Change |
|---|---|
| `weekly-reports/validation.ts` `parsePeriodStart` | `periodEnd = periodStart + 5`; ISO-Monday check unchanged. |
| `weekly-reports/reference.ts` | `weeklyReportDueDate(periodEnd, requestDateKey) = max(periodEnd + 2, requestDateKey)`. `currentWeeklyReportPeriod` returns `{ timezone, today, periodStart, periodEnd: start + 5, dueDate }` where `today` is the organization-local date key used for D9. The Monday offset already returns the just-ended week on Sunday (D4). |
| Reference DTO | Gains `today` (organization-local `YYYY-MM-DD`) so the create preview can apply D9 for any selected week without the device clock. Additive field; the web parser is updated in the same PR. |
| `weekly-reports/create.ts` single create and bulk request | Both commands use the same deadline calculation: `weeklyReportDueDate(periodEnd, organization-local date of the request instant)`. |
| `weekly-reports/source-work.ts` `weekInstants` | Exact signature `weekInstants(periodStart: string, periodEnd: string, timezone: string)`; window end = `periodEnd + 1` 00:00 organization-local: Sunday 00:00 for working-week reports, Monday 00:00 for open legacy 7-day reports. All callers pass the stored period. |
| Body validation | Unchanged API shape: drafts still accept the six optional keys and submission still requires `summary` + `nextWeekPlan`. Old web bundles and open legacy drafts keep working; the reduction to three sections is a presentation decision (§5). |
| Idempotency hashes | Unchanged. A create request sent before the deploy and retried with the same `clientActionId` after it gets `CLIENT_ACTION_REUSED` (its derived `periodEnd` differs); this is the safe outcome and is documented in the release note. |
| PDF `document-model.ts` | A working-week record (`period_end = period_start + 5`) renders the three D5 sections with the new labels (plus any legacy field with text, under its V1 label). A 7-day record renders the six V1 sections with their original labels, exactly as today (D7). Frozen preset questions render as stored. |
| Unchanged | overdue contract, lateness/OVR, reports, overview, offboarding, removal, identity index, `weeklyReportTitle` format (it follows the stored period). |

## 5. Web behaviour

| Surface | Change |
|---|---|
| `WeeklyReportQuestionEditor.tsx` | Remove `WEEKLY_REPORT_PRESET_QUESTIONS` and the preset checkboxes; keep custom question add/edit/remove. Remove the now-unused `.weekly-question-preset*` styles. |
| `WeeklyReportCreate.tsx` week choice | Choices "Bu hafta · 16–21 Kasım", "Geçen hafta · 9–14 Kasım" and "Başka hafta" (date input kept for the last one), computed from the server reference. |
| `WeeklyReportCreate.tsx` preview | Before submit: "Dönem 16–21 Kasım 2026 · Son teslim 23 Kasım Pazartesi"; deadline = `max(selected Saturday + 2, reference.today)` (D9). Intro copy describes the Monday–Saturday week and the Monday deadline. |
| `WeeklyReportCreate.tsx` outcomes (D8) | Navigate only when the single item's outcome is `created`. For `existing`, show "Bu personelin bu hafta için raporu zaten var" with "Mevcut rapora git", plus the hint that a cancelled report can be replaced only after an Admin removes it. Bulk result copy reports created and existing counts separately. |
| `WeeklyReportDetail.tsx` editor | Working-week report (`periodEnd = periodStart + 5`): three fields: **Bu hafta** (`summary`, required), **Sorunlar ve destek ihtiyacı** (`blockers`, optional), **Gelecek hafta planı** (`nextWeekPlan`, required). A legacy field with stored text stays visible and editable under "Önceki form alanları" until submission (complete-replacement PATCH must not null it). `draftsEqual` compares all six keys. An open 7-day report keeps the six-field V1 editor and labels. |
| `WeeklyReportDetail.tsx` mobile actions | On narrow viewports the save/submit actions are reachable without scrolling past the form (sticky action bar following DESIGN.md); readiness checklist summary shown above the form. |
| `WeeklyReportDetail.tsx` frozen/history | Frozen report and history render every stored body field that has text, with the labels of the record's shape (D7); this also fixes the history view, which today omits `highlights`, `fieldObservations`, `supportNeeded`. |
| Date display | One shared web helper formats `YYYY-MM-DD` calendar days and ranges in Turkish ("16–21 Kasım 2026", "23 Kasım Pazartesi"), replacing raw ISO dates in weekly report detail header/facts, create screen, removal dialog and staff history. The page header no longer repeats the period three times. |
| `weekly-report-api.ts` | `parseWeeklyReportReference` accepts the additive `today` field; other parsers unchanged (they accept any `YYYY-MM-DD` period and the six body keys). |

## 6. Acceptance scenarios

Organization timezone `Europe/Istanbul`; dates are organization-local.

| # | Given | When | Then |
|---|---|---|---|
| A1 | Friday 2026-11-20 10:00 | reference read | `today 2026-11-20`, `periodStart 2026-11-16`, `periodEnd 2026-11-21`, `dueDate 2026-11-23` |
| A2 | Sunday 2026-11-22 | reference read | same week as A1 (the working week that just ended), `dueDate 2026-11-23` |
| A3 | Monday 2026-11-23 00:30 | reference read | `2026-11-23 – 2026-11-28`, due `2026-11-30` |
| A4 | manager bulk request for week 2026-11-16 on Friday | create | each new report has `period_end 2026-11-21`, `due_date 2026-11-23`, title shows the 6-day range |
| A5 | request body with any `periodEnd`/`dueDate` field | create | rejected as unknown field (server-only authority unchanged) |
| A6 | a 2026-11-16 report still open | 2026-11-24 00:00 | report is currently overdue; on 2026-11-23 23:59 (Monday) it is not |
| A7 | work completed Sat 2026-11-21 23:59, Sun 2026-11-22 10:00 and Mon 2026-11-23 00:00 | draft/live list and submission snapshot | only the Saturday item appears in the 2026-11-16 report |
| A8 | an existing 7-day report (e.g. 2026-11-09 – 2026-11-15, due 2026-11-16) | draft save, submit, approve, remove, PDF | all succeed unchanged; period, due date and title are not rewritten; its live list and snapshot still include Saturday/Sunday (2026-11-14/15) completions |
| A9 | historical submission containing `highlights`, `fieldObservations`, `supportNeeded` and preset answers | detail, history, PDF | every stored field and frozen question renders |
| A10 | new draft | Staff form | exactly three sections; submit requires `summary` and `nextWeekPlan` |
| A11 | an in-progress legacy draft with text in a removed section | Staff form | that text stays visible and editable until submission; nothing is silently dropped |
| A12 | manager selects one staff member whose report for the week already exists (any status, not removed) | bulk request | no navigation; message "Bu personelin bu hafta için raporu zaten var" with a link to it |
| A13 | bulk request with created and existing outcomes | result screen | copy states both counts; never "each report was created" |
| A14 | manager create screen | open | no preset question checkboxes; custom questions still work; due-date preview shows "23 Kasım Pazartesi" |
| A15 | two parallel creates for the same staff/week | create | exactly one report (existing locking/uniqueness unchanged) |
| A16 | organization timezone `America/New_York`, week 2026-03-09 (DST starts Sunday 2026-03-08) | window | Monday 2026-03-09 00:00 EDT → Sunday 2026-03-15 00:00 EDT |
| A17 | a submission row whose period differs from its report row; `+4` or `+7` periods | direct insert | rejected (composite foreign key, CHECK) |
| A18 | Monday 2026-11-23 requests week 2026-11-16 ("Geçen hafta"); Tuesday 2026-11-24 requests week 2026-11-16 | create and reference | due `2026-11-23` (normal); due `2026-11-24` (late, D9), not overdue at creation, no immediate `LATE_SUBMISSION` |
| A18b | Wednesday 2026-11-18, request for a future week 2026-11-23 | create | due `2026-11-30` (Monday after that week) |
| A19 | legacy draft text in `supportNeeded` | Staff edits only that field | form becomes dirty, save keeps all six keys, submit includes it |
| A20 | 7-day historical submission | history view and PDF | six V1 labels; working-week submission shows the three D5 labels |
| A21 | create screen on Friday 2026-11-20 | open | "Bu hafta · 16–21 Kasım" preselected; preview "Son teslim 23 Kasım Pazartesi"; on Tuesday 2026-11-24 choosing "Geçen hafta" previews "Son teslim 24 Kasım Salı" |
| A22 | Staff in IN_PROGRESS at 390 px | open report | save and submit reachable without scrolling past the form; readiness summary visible above it |

## 7. Implementation plan and fleet split

Owner instruction (2026-11-21): the worker fleet for this feature is
**Hydrogen**. The first implementation (Monday–Friday draft) is merged on this
branch; the revision is applied as follow-ups by the same three writers, each in
its own worktree and test database, no two writers on the same file.

| Step | Worker | Files | Done when |
|---|---|---|---|
| 1. Backend | Hydrogen (writer) | migration 068; `weekly-reports/{validation,reference,source-work,types,history-port,create-input,repository}.ts`; `weekly-reports/pdf/document-model.ts`; `job-cards/{service,submission-policy}.ts` call sites and comments; server unit tests (`weekly-report-validation`, `-pdf`, `-submission-policy`, `-migration`, `job-card-routes`), `weekly-report-source-work-postgres.test.ts`, migration head/count pins | `npm run build` + touched tests pass |
| 2. Web | Hydrogen (writer) | `WeeklyReportCreate.tsx`, `jobs/WeeklyReportQuestionEditor.tsx`, `jobs/WeeklyReportDetail.tsx`, `jobs/WeeklyReportRemovalAction.tsx`, `jobs/weekly-report-api.ts` (reference parser only), `StaffProfiles.tsx`, `ui/calendar-date.ts`, `styles.css` weekly rules, web tests, `web/scripts/weekly-report-*`, `visual-improvements-fixture.ts`, `sof2c-actionable-resolution-browser.mjs` | `npm run build` + web tests + `npm run smoke:weekly-report` pass |
| 3. PostgreSQL tests | Hydrogen (independent writer) | the remaining `server/tests/weekly-report-*-postgres.test.ts` and `weekly-report-workweek-postgres.test.ts` covering A1–A8, A15–A18b | tests pass after merge |
| 4. Docs | lead | user manual weekly report section, `docs/README.md` index, this contract's status | — |
| 5. Review | Hydrogen critic (separate session) → lead | merged branch | findings resolved |
| 6. Visual check | Hydrogen | Playwright captures per UI-003 (390 px and 1440 px; create, NEW/ACCEPTED/IN_PROGRESS/COMPLETED detail, legacy 7-day report) | evidence recorded |
| 7. Verification | lead | `cd server && npm run build && npm test -- --run`, `cd web && npm run build && npm test -- --run`, smokes; exact-head hosted CI | all pass |

Order follows the project's fleet rules: writers → Hydrogen review → lead review
and fixes → authoritative build/tests → commit/PR. Migration 068 must be
re-checked for a number collision with any branch merged first.

## 8. Rollout and rollback

- **Open reports at deploy time** keep their stored 7-day period and deadline
  (D7). Only reports created after the deploy use the working week. The week of
  the deploy can contain both kinds; the release note says so.
- **Rollback:** the migration only widens the period constraints, so the
  previous release can still write 7-day rows, and its web parsers accept any
  `YYYY-MM-DD` period and the unchanged six-key body. The previous web bundle's
  exact reference parser would reject the new `today` field, so the web bundle
  and server roll back together (they ship as one release). After a rollback
  the previous server would compute a Monday→Monday work-list window for
  working-week reports created meanwhile (Sunday work could appear in their
  live list and snapshot); stored periods and deadlines stay correct. Rollback
  is therefore allowed but not lossless for that window; prefer forward fixes.
- **Idempotent retries across the deploy** receive `CLIENT_ACTION_REUSED`
  (§4); the user simply creates the request again.
- **Night notifications:** a report still open at the end of Monday opens
  `LATE_SUBMISSION` at Tuesday 00:00, so OVR-4 reminds Staff at about 00:15 and
  escalates at about 01:00. This is today's behaviour as well; quiet hours are
  stage 2 of the lateness plan and out of scope here.
- **Production label shift (read-only inspection, 2026-11-21).** Production
  (release `b0d3341`, schema 065) holds 57 Weekly Reports, all 7-day, none open.
  The team has created each report on Friday/Saturday with the **next** Monday as
  `period_start`, so every historical label is one week ahead of the work it
  describes (e.g. reports created 21 Nov for 16–21 Nov work carry 23 Nov). The
  data is compatible with 068 (0 period mismatches, 0 orphans), but at the
  switch each Staff member's last old-convention report occupies the first
  new-convention week (current/active identity is Staff + `period_start`).
- **Transition step (owner decision 2026-11-21, "Yayın günü sınır raporları"):**
  nothing is removed before the release. Immediately after the WR-WEEK release,
  every report whose `period_start` is the release week or later and that was
  created under the old convention is removed with the existing Admin "Raporu
  kaldır" command (mandatory reason, history kept, readable in personnel
  history). Older reports are not touched. The list is produced by a read-only
  query at release time and the removals need the owner's go for that list.
- **Release order:** production is at schema 065; OVR-5a (066) and OVR-5b (067)
  must be released first, each separately as the OVR-5 contract requires, then
  WR-WEEK (068).
- **Production:** migration, deploy and any production read remain separate
  owner-approved gates (one-click deploy contract).
