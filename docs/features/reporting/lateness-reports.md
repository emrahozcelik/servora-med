# Lateness reports (OVR-7)

- **Status:** Draft for owner review. Ships with the code; not accepted until the
  owner approves this text.
  The owner chose the direction on 2026-11-20 (lateness plan stage 3, item 6:
  "A, within REPORT-001 limits") and answered the open questions on
  2026-11-22: (Q1) a Staff report section plus an organization summary card on
  the Reports page, no new page; (Q2) an incident belongs to the period of the
  day its deadline was missed (`breached_at`); (Q3) Staff see their own records
  on their own report page; (Q4) lateness tied to a change request that
  management resolved without rejecting is separated as operational, derived
  from existing data.
  Revised the same day after a critic review (Staff self-cancellation is not a
  management decision, canonical duration expression, reconciliation total,
  paging bounds, deduplication, UI placement and wording).
- **Date:** 2026-11-22
- **Scope:** Stage 3 ("reports") of the owner's lateness plan. Read-only.
- **Implements:** REPORT-001 §6 (lateness reporting) and JOB-010 D1 §7
  (operational reasons are never Staff fault) for OVR-2 incidents.
  **Does not implement:** REPORT-001 performer attribution (§3–§4) or optional
  lateness explanations and manager notes (§5); both remain separate slices.

## 1. Context (observed on `main` `381e263`)

1. **No report reads lateness incidents.** `job_card_overdue_incidents` is read
   only by the per-job management history (`GET /api/job-cards/:id/overdue-incidents`),
   the live per-job snapshot and the open late-submission list.
2. **Two other "late" measures exist and stay unchanged.**
   - `STAFF_ON_TIME_SQL` compares the submit instant with the planned end. It
     is sent in the Staff report DTO but no screen shows it.
   - "Gecikmiş" counters are a current condition (`due_date` passed today)
     over active jobs, not history.
   This contract adds a third, explicitly named measure. It does not merge or
   reword the other two.
3. **Incidents already carry what a report needs.** Breach instant, deadline,
   type, episode and schedule revision, recovery or OVR-5 ending, and
   accountability frozen at the breach instant (`accountable_role`,
   `accountable_source`, `accountable_user_id` from assignment history, never
   the current assignee).
4. **The performer gap does not block this slice.** REPORT-001 §2 assigns
   historical lateness to "the proven accountable person or management role at
   the breach instant", which is the incident's own accountability. Neither
   `assigned_to`, `staff_completed_by` nor a future performer is used here.
5. **No link exists between an incident and a change request.** JOB-010 release
   2a stores the Staff reason (`reason_code`, `reason_text`) and the management
   resolution, but nothing ties a request to an incident.
6. **Tracking start.** Incidents are written from 2026-09-16 (migration 047)
   and the clock scanner runs in production from 2026-09-21. Earlier periods
   have no or incomplete records; no backfill exists or is allowed.

## 2. Principles

- **Evidence is not fault.** Every proven incident stays visible. Only the
  grouping decides what counts as Staff responsibility.
- **Separate groups never add up into a score.** No rate, score, ranking,
  per-Staff comparison table or summed duration (REPORT-001 §6, LATE-03).
- **Unknown stays unknown.** Unprovable accountability is never assigned to
  a person.
- **Server owns every classification.** The web renders server groups and
  never re-derives them.

## 3. Cohort and period

An incident is in the report for organization *O* and period [*from*, *to*]
when all hold:

- `organization_id = O`;
- `breached_at` falls in the period using the existing instant bounds:
  `breached_at >= (from::timestamp AT TIME ZONE tz)` and
  `breached_at < ((to + 1)::timestamp AT TIME ZONE tz)`, `tz` =
  `organizations.timezone` (same idiom as `STAFF_ON_TIME_SQL`);
- its JobCard is readable under the existing `saleReadableJobsSql` gate and
  its status is not `INVALIDATED` (a record created by mistake is not
  lateness evidence for reports; the incident row itself is preserved).

Range parsing, defaults (current month) and the 366-day limit are the existing
`ReportRangeQuery` rules. The request instant (`requestTime`) is sampled once
per request and shared by every read, as today.

## 4. Classification

Each cohort incident gets exactly one accountability class, one outcome and,
for Staff classes, an operational flag.

### 4.1 Accountability class

| Class | Rule | Shown where |
| --- | --- | --- |
| `STAFF_PROVEN` | `accountable_role = 'STAFF'`, `accountable_source = 'ASSIGNMENT_AT_BREACH'`, `accountable_user_id IS NOT NULL` | That Staff member's report and the organization card |
| `STAFF_UNKNOWN` | Any other row with `accountable_role = 'STAFF'` | Organization card only, as "Sorumlusu belirlenemeyen" |
| `MANAGEMENT` | `accountable_role = 'MANAGEMENT'` (the producer writes it only for `APPROVAL_WAIT`) | Organization card only, as management approval wait |

The classes partition on `accountable_role`, `accountable_source` and
`accountable_user_id` only; `delay_type` is not used to classify, so no row can
fall between classes. `APPROVAL_WAIT` therefore never appears in a Staff report.
The Staff lists and breakdowns still group by `delay_type`; a `STAFF_PROVEN`
row with a type other than `LATE_START` / `LATE_SUBMISSION` fails the read
closed (the producer never writes one).

A user who was Staff at the breach and later changed role stays in the
organization's `STAFF_PROVEN` totals, while `GET /api/reports/staff/:userId`
keeps its existing `STAFF_IDENTITY_SQL` rule (404 for a non-Staff user).

### 4.2 Outcome (at `requestTime`)

| Outcome | Rule | Duration |
| --- | --- | --- |
| `RECOVERED` — "Kapandı" | `recovered_at IS NOT NULL` | `recovered_at − breached_at` |
| `EXTENDED` — "Tarih uzatıldı" | `ended_at IS NOT NULL` (OVR-5) | `ended_at − breached_at` |
| `OPEN` — "Devam ediyor" | both NULL | elapsed `requestTime − breached_at` |

Every duration uses one canonical SQL expression, matching the per-job history
(`service.ts` `Math.max(0, Math.floor(ms / 1000))` for `totalDelaySeconds`,
`endedDurationSeconds` and open elapsed):
`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (end_instant - breached_at))))::int`,
where `end_instant` is `recovered_at`, `ended_at` or `requestTime`. The same
integer is used for `durationSeconds`, `maxSeconds`, `maxElapsedSeconds` and as
the `percentile_cont(0.5)` input; the median is then `FLOOR(...)::int`.
`EXTENDED` is neither success nor on time; it is a separate outcome.

### 4.3 Operational flag (JOB-010 D1 §7)

Only `STAFF_PROVEN` incidents carry the flag; `STAFF_UNKNOWN` stays in the
unknown group either way. A `STAFF_PROVEN` incident is **operational** when a
change request exists for the same organization and JobCard with:

- `state = 'CLOSED'` and `resolution IN ('CANCELLED', 'CORRECTED',
  'RESCHEDULED', 'LINKED_JOB_CREATED')` (`REJECTED` and the automatic
  `SUPERSEDED` do not qualify);
- `resolved_by` is a user of the organization whose role is `MANAGER` or
  `ADMIN`. This is required because the `CANCEL` command closes an open request
  as `CANCELLED` with the canceller as `resolved_by` (`service.ts`), and Staff
  could still `CANCEL` before the JOB-010 window was enabled (`policy.ts`). A
  Staff self-cancellation is not a management decision. The role is the
  current role: a later role change of the resolver is accepted as a known
  limitation; and
- an interval that overlaps the incident:
  `requested_at <= COALESCE(recovered_at, ended_at, requestTime)` and
  `resolved_at >= breached_at`.

A request opened before the deadline and still open at the breach, or opened
while the incident was open, therefore qualifies. A request resolved before the
breach, or opened after the incident closed, does not. Any reason code
qualifies, including `OTHER`, because the management resolution is the
approval. When several requests qualify, the latest by `resolved_at DESC, id
DESC` supplies the shown reason, selected with one `LEFT JOIN LATERAL (…
LIMIT 1)` per incident so that no aggregate or page counts an incident twice.

The flag only regroups the incident. The incident, its outcome and its duration
are unchanged and remain visible.

## 5. Staff report section — "Gecikme kayıtları"

Added to `StaffReportResponse` as `lateness`, so both
`GET /api/reports/staff/:userId` (management) and `GET /api/reports/staff/me`
(Staff, self only) return it with the existing access rules. Scope: cohort
incidents with class `STAFF_PROVEN` and `accountable_user_id` = that Staff
member.

```ts
type LatenessDurationStats = {
  count: number;
  medianSeconds: number | null; // floor of percentile_cont(0.5); null when count = 0
  maxSeconds: number | null;
};
type LatenessTypeBreakdown = {
  delayType: 'LATE_START' | 'LATE_SUBMISSION';
  incidentCount: number;
  recovered: LatenessDurationStats;
  extended: LatenessDurationStats;
  open: { count: number; maxElapsedSeconds: number | null };
};
type StaffLatenessSummary = {
  trackingStartedOn: '2026-09-21';
  staffResponsibility: {          // operational = false
    delayedJobCount: number;      // COUNT(DISTINCT job_card_id)
    incidentCount: number;
    byType: LatenessTypeBreakdown[]; // both types always present, fixed order
  };
  operational: {                  // operational = true
    delayedJobCount: number;
    incidentCount: number;
    // zero-count reasons omitted; order incidentCount DESC, then the
    // JOB_CHANGE_REQUEST_REASON_CODES order
    byReason: Array<{ reasonCode: ChangeRequestReasonCode; incidentCount: number }>;
  };
};
```

The staff report query parser is unchanged (`exactScalarQuery` already accepts
`includeSaleCapability=true`, which the web always sends); the lateness read
receives the same `includeSaleCapability` as the rest of the report.

Invariants checked by the service (fail closed like `onTime`):
`incidentCount = Σ byType.incidentCount`,
`byType.incidentCount = recovered.count + extended.count + open.count`,
`operational.incidentCount = Σ byReason.incidentCount`, and
`delayedJobCount <= incidentCount` in each group. A JobCard may appear in both
groups when it has one operational and one non-operational incident; the two
job counts are therefore not added together.

**UI** (`StaffOperationalReport.tsx`, both the management view in
`StaffReportRoute` and the Staff self view in `OwnStaffProfileView`):

- Placement: a new `staff-analysis-group` section between "Seçilen dönem —
  yönetici onaylı sonuçlar" (`staff-analysis-period`) and "Operasyon bağlamı"
  (`staff-analysis-context`), heading level `h3`.
- Title "Gecikme kayıtları"; helper text "Seçilen dönemde süresi aşılan
  başlama ve onaya gönderme kayıtları. Tek başına başarı veya zamanında
  bitirme oranı değildir."
- "Personel sorumluluğundaki gecikmeler": "Geciken iş", "Gecikme kaydı", then
  per type ("Geç başlama", "Geç onaya gönderme") the counts "Kapandı", "Tarih
  uzatıldı", "Devam ediyor" and, where a count is above zero, "Ortanca süre" and
  "En uzun süre" for closed and extended rows, "Devam eden en uzun süre" for
  open rows. Zero in this group: "Bu dönemde personel sorumluluğunda gecikme
  kaydı yok."
- "Operasyonel nedenli gecikmeler" with "Yönetimin sonuçlandırdığı düzenleme /
  sonlandırma önerisiyle ilişkili; personel kusuru sayılmaz.", "Geciken iş",
  "Gecikme kaydı" and counts per reason using the existing
  `changeRequestReasonLabels`. Hidden when its count is zero.
- When the period starts before `trackingStartedOn`: "Gecikme kayıtları 21 Eylül
  2026'dan önce eksik olabilir."
- Both groups zero: only "Bu dönemde gecikme kaydı yok." (plus the tracking
  note when it applies).
- A `<button type="button" aria-expanded>` "Kayıtları göster" / "Kayıtları
  gizle" toggles the §6 list below the summary. The component receives a new
  prop `loadLatenessIncidents(page)` from both parents (management: the
  `/staff/:userId/…` path; Staff: the `/staff/me/…` path), so it never decides
  the path itself. Expansion and loaded pages reset when the Staff member or
  range changes; the existing `useRealtimeInvalidation(['reports'], …)` reload
  also reloads loaded pages.
- The existing copy guard in `web/tests/staff-operational-report.test.tsx`
  forbids "stok". The reused reason label "Stok veya ekipman eksik" is context,
  not a stock metric: the guard keeps forbidding stock metrics and is narrowed
  to allow exactly this label.

## 6. Staff incident list

`GET /api/reports/staff/:userId/lateness-incidents` (MANAGER/ADMIN) and
`GET /api/reports/staff/me/lateness-incidents` (STAFF only, own records). Query: the range keys, `includeSaleCapability`,
`limit` and `offset`, parsed by a new `parseStaffLatenessIncidentQuery` in
`reports/query.ts` with the existing report bounds
(`integerQuery(limit, 'limit', 50, 1, 200)`, `offset` from 0). The web requests
pages of 20 and shows "Daha fazla göster" while `offset + items.length <
total`. Scope is the §5 scope (both groups). Order: `breached_at DESC, id DESC`.
In `reports/routes.ts` the `/staff/me/lateness-incidents` route is registered
before `/staff/:userId/lateness-incidents`; the route-count assertion in
`server/tests/reports-routes.test.ts` is updated.

```ts
type StaffLatenessIncidentItem = {
  incidentId: string;
  delayType: 'LATE_START' | 'LATE_SUBMISSION';
  episodeNo: number;
  scheduleRevisionNo: number;
  deadlineAt: string;
  breachedAt: string;
  outcome: 'RECOVERED' | 'EXTENDED' | 'OPEN';
  closedAt: string | null;        // recovered_at or ended_at
  durationSeconds: number;        // closed duration or open elapsed (§4.2)
  operationalReason: { reasonCode: ChangeRequestReasonCode;
    resolution: 'CANCELLED' | 'CORRECTED' | 'RESCHEDULED' | 'LINKED_JOB_CREATED';
    resolvedAt: string } | null;
  job: { id: string; title: string; type: JobCardType; jobPath: string } | null;
};
// response: { range: ResolvedReportRange, items, total, limit, offset }
```

Instants are formatted in `range.timezone` (`Intl.DateTimeFormat` with
`timeZone`), not the browser timezone.

`job` is always present for management. For Staff it is present only when the
JobCard is currently assigned to them (the existing Staff read rule,
`policy.ts` `actor.id === job.assignedTo`); otherwise it is `null` and the row
shows "Devredilmiş iş" with no title or link (REPORT-001 §5, ACCESS-01). Reason
text and the request's author are not exposed. Another Staff member's id in
the management path that is not an organization Staff user returns the same
404 as the existing Staff report.

Each row shows the type, deadline, breach time (organization time), outcome,
duration, "Operasyonel neden: …" when flagged, and the job link or
"Devredilmiş iş". So that repeated incidents of one job are not read as
separate jobs, a row shows "Gönderim turu N" when `episodeNo > 1` and "Plan
sürümü N" when `scheduleRevisionNo > 1`; nothing is shown for the first round
or the original plan.

## 7. Organization card — Reports page

`GET /api/reports/lateness` (MANAGER/ADMIN; Staff 403), range keys and
`includeSaleCapability` through `exactScalarQuery`. Fetched independently
(like `BusinessTrend`) and rendered as a visible `report-section` titled
"Gecikme kayıtları" directly after "Dikkat Gerektirenler", outside the
collapsed `reports-overview-details` block, with its own loading / error /
retry state.

```ts
type OrganizationLatenessSummary = {
  range: ResolvedReportRange;
  trackingStartedOn: '2026-09-21';
  totalIncidentCount: number;     // the §3 cohort size, same CTE
  staffResponsibility: { delayedJobCount: number; incidentCount: number };
  operational: { delayedJobCount: number; incidentCount: number };
  unknownAccountability: { delayedJobCount: number; incidentCount: number };
  managementApprovalWait: {
    delayedJobCount: number;
    incidentCount: number;
    recovered: LatenessDurationStats;
    open: { count: number; maxElapsedSeconds: number | null };
  };
};
```

`staffResponsibility` and `operational` cover all `STAFF_PROVEN` incidents of
the organization; `unknownAccountability` covers `STAFF_UNKNOWN` (operational
or not); `managementApprovalWait` covers `MANAGEMENT`. The service fails closed
unless the four incident counts sum to `totalIncidentCount` (DATA-01), and in
every group `delayedJobCount <= incidentCount` and `delayedJobCount = 0` exactly
when `incidentCount = 0`. There is no per-Staff breakdown on this card.

Labels: "Personel sorumluluğunda", "Operasyonel nedenli", "Sorumlusu
belirlenemeyen", "Yönetici onayı beklemesi" (with "Ortanca süre", "En uzun
süre" and "Devam eden en uzun süre"), each as "N kayıt · M iş", plus the §5
tracking note. All zero: "Bu dönemde gecikme kaydı yok."

## 8. Implementation boundaries

- **Read-only.** No migration, no new column, no index, no write path. Reports
  stays read-only (`DECISIONS.md` DOM-006). No `(organization_id,
  breached_at)` index exists; the only incident index is
  `(organization_id, job_card_id, breached_at DESC, id DESC)`, so the period
  filter scans the organization's incidents. This is acceptable at the current
  single-organization volume (incidents exist only since 2026-09-16). An index
  needs a separate decision if report latency becomes visible.
- All new reads run inside the existing `ReportReadSnapshot` transaction with
  the shared `requestTime`.
- Unchanged: `STAFF_ON_TIME_SQL`, "Gecikmiş" counters, `StaffPerformanceTable`,
  the per-job incident endpoints and their access, OVR-4/OVR-6 workers, and the
  `staff_completed_by` / `assigned_to` attribution of existing metrics.
- Shared vocabulary: the delay types, change-request reason codes and
  resolutions come from `server/src/modules/job-cards/types.ts`; the web reuses
  `jobs-api.ts` types and `job-labels.ts` labels.
- UI follows UI-001, `DESIGN.md` and `PRODUCT.md`: 390×844 without overflow,
  44 px targets, loading / error / retry states, Playwright visual evidence.

## 9. Acceptance scenarios

| ID | Scenario |
| --- | --- |
| LR-01 | A `LATE_START` breached on 31 October and recovered on 3 November is in the October report, `RECOVERED`, with duration `recovered_at − breached_at`; not in November. |
| LR-02 | Reassignment after the breach keeps the incident in the former assignee's report; the new assignee's report does not show it. |
| LR-03 | `APPROVAL_WAIT` never appears in a Staff report; it appears in the organization card's management group. |
| LR-04 | A `STAFF_UNKNOWN` incident is counted only in the organization card's unknown group; no Staff report shows it. |
| LR-05 | An OVR-5 extended incident is `EXTENDED` with `ended_at − breached_at`, counted in the Staff group, never `RECOVERED`. |
| LR-06 | A change request with `CUSTOMER_ABSENT` resolved `RESCHEDULED` by a manager while the incident was open makes it operational; the same request `REJECTED` or `SUPERSEDED` does not; a request resolved before the breach does not; a request closed `CANCELLED` by a Staff self-`CANCEL` (window disabled) does not; two qualifying requests still count the incident once and show the later reason. |
| LR-07 | Two `LATE_SUBMISSION` episodes on one job give incident count 2 and delayed-job count 1; a job with one operational and one non-operational incident counts once in each group. |
| LR-08 | Incidents on an `INVALIDATED` job are excluded; incidents on a `SALE` job are excluded when the Sale capability gate excludes the job. |
| LR-09 | Staff `/staff/me` and `/staff/me/lateness-incidents` return only their own `STAFF_PROVEN` incidents; a transferred job shows `job: null`; Staff calling the management paths or `/lateness` get 403. |
| LR-10 | Cross-organization incidents and Staff ids never appear; an unknown Staff id returns 404. |
| LR-11 | Medians and maxima are per type and outcome, integer seconds, never negative, equal to the per-job history values for the same rows; no response field contains a summed duration, rate or rank. |
| LR-12 | Organization incident counts reconcile with the cohort size; service invariants fail closed on violation. |
| LR-13 | A period before 2026-09-21 shows the tracking note; empty periods show the empty state. |
| LR-14 | 390×844 Staff and management views render without horizontal overflow; list paging and retry work. |
