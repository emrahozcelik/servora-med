# Linked Follow-up JobCards — F4 canonical acceptance and closeout

**Status:** `BLOCKED_BY_RUNTIME_DEFECTS` (PR remains Draft; Ready and merge are not authorized)

This is the canonical F4 acceptance artifact for the already-merged F1–F3
implementation. It is verification evidence only. The runtime data is synthetic;
it is not production, staging, or real-customer evidence.

## 1. Executive verdict

The external-review repair pass completed with **145 PASS / 4 FAIL / 149 total
checks**. It used the F4 worktree's real Fastify API, Vite proxy, a fresh
PostgreSQL database, seven authenticated synthetic browser sessions, and the
installed Google Chrome executable through Playwright. The four failed records
map to two product-runtime blockers:

1. An open management children panel did not re-fetch
   `GET /api/job-cards/:sourceId/follow-ups` after a new follow-up was created
   (`0 → 0`). JobDetail, customer history and staff history did refresh.
2. The Calendar date/event control was absent from the first 80 real Tab stops,
   so keyboard Enter activation could not be exercised.

The additional reflow pass found no horizontal overflow on all five affected
surfaces at both accepted text/reflow conditions. Server and web builds, the web
suite, responsive smoke, bundle budget, server audit, and the policy-based web
audit passed. The server wrapper's only remaining failure is the host's
macOS-service-identity authentication contract (`expected connection failure but
connected`); exact-head CI remains authoritative for the complete PostgreSQL
gate.

The repaired harness also closed the requested payload, replay-side-effect,
breadcrumb, multi-surface observation and non-Calendar keyboard evidence gaps.
Because the two runtime defects require production-code changes and F4 repair
authority is evidence/harness-only, no product fix was applied. Draft PR #87,
staging, production, and branch/worktree state remain unchanged.

## 2. Provenance

| Field | Value |
| --- | --- |
| Repository | `emrahozcelik/servora-med` |
| Worktree | `/Users/emrah/Documents/Servora-Med-Linked-Follow-Up-F4` |
| Branch | `docs/linked-follow-up-jobcards-f4-closeout` |
| Canonical F3/resulting-main base | `1fd65ad4f2a1654b45e856ffd5813bf88f731e58` |
| F4 evidence repair provenance | Repair commit containing this artifact, based on reviewed head `c5488108cb9bdb88e0ed70e12b79055e554b3f05`; exact commit SHA is recorded externally in Draft PR #87 because a commit cannot embed its own final SHA |
| F4 branch/PR exact-head gate | Not eligible: runtime acceptance is `BLOCKED` and PR #87 must remain Draft |
| Draft PR | #87 — `docs: close linked follow-up JobCards acceptance` — [GitHub](https://github.com/emrahozcelik/servora-med/pull/87) |
| Database | `servora_med_f4_test` (dedicated synthetic PostgreSQL database) |
| Schema | Migrations 001–022 applied |
| API | Fastify on `http://127.0.0.1:3000` |
| Web | Vite on `http://127.0.0.1:5174`, proxying to the API |
| Browser | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` via Playwright; no Chromium download |
| Runtime-only rate limit setting | `LOGIN_RATE_LIMIT_MAX=20` on the dedicated local process so seven synthetic sessions could log in; production code/config was not changed |
| Evidence declaration | Synthetic-only; no production/staging credentials, cookies, authorization headers, patient data, or real customer data are stored here |

Runtime process shape (password value intentionally omitted):

```text
DATABASE_URL=postgresql:///servora_med_f4_test
NODE_ENV=development HOST=127.0.0.1 PORT=3000
CORS_ORIGIN=http://127.0.0.1:5174
ACTION_SCOPED_GEOLOCATION_ENABLED=false
CALENDAR_ENABLED=true MESSAGING_ENABLED=false
OVERVIEW_DASHBOARD_ENABLED=true LOGIN_RATE_LIMIT_MAX=20
npx tsx src/index.ts
```

The Vite process served the F4 worktree's `web/` directory. The browser harness
does not persist raw request bodies or credentials. For the follow-up POST it
persists only the sorted field names plus instruction presence, Unicode
code-point length and SHA-256 fingerprint; other network evidence contains
method, URL, status, console and page-error observations.

## 3. Canonical decision traceability

| Decision/contract | Implementation location | Automated coverage | F4 runtime/evidence |
| --- | --- | --- | --- |
| One nullable `JobCardFollowUpContext`; public detail omits raw top-level source fields | `server/src/modules/job-cards`, `web/src/jobs`, `web/src/JobDetail.tsx` | Job-card detail/parser and follow-up tests in server/web suites | `ROOT-FOLLOW-UP-CONTEXT`, `ROOT-RAW-FIELDS`, `ADMIN-FULL`, `STAFF-B-RESTRICTED` in [`runtime-results.json`](./runtime-results.json) |
| Management-only children endpoint/panel; `total/limit/offset` contract | Job-card routes/service and `web/src/JobDetail.tsx` | F1/F2/F3 children and pagination tests | `STAFF-CHILDREN-403`, `STAFF-CHILDREN-PANEL-HIDDEN`, `STAFF-NO-CHILDREN-REQUEST`, `MANAGEMENT-CHILDREN`, `MANAGEMENT-CHILDREN-PANEL` |
| Customerless source permits only `GENERAL_TASK`; no `customer-detail:null` | Follow-up validation/service and realtime mapper | Follow-up policy/event-mapper tests | `CUSTOMERLESS-*`; direct realtime query recorded in §14/§19 |
| Role-filtered customer/staff history, truthful totals, anti-enumeration | `server/src/modules/crm`, `server/src/modules/people`, history port | CRM/People history and wiring tests | `CUSTOMER-HISTORY-*`, `STAFF-HISTORY-*` |
| Calendar uses the same source-access decision as JobDetail | `server/src/modules/calendar`, realtime mapper, `web/src/calendar` | Calendar parity/realtime tests | `CALENDAR-ADMIN-FULL`, `CALENDAR-STAFF-A-FULL`, restricted UI screenshot and `CALENDAR-PRIVACY` |
| Receipt-only idempotency and current-view replay | Job-card service/repository and `FollowUpCreatePage` | Server idempotency tests; `web/tests/follow-up-create.test.tsx` | `REPLAY-ACCESS-*`, `REPLAY-NO-*`, `REPLAY-*-SIDE-EFFECTS`; live FULL → RESTRICTED → FULL replay with stable receipt and unchanged activity/notification/realtime observations |
| Immutable instructions and 4,000-code-point boundary | Follow-up create input/service; `FollowUpCreatePage` | Server input/migration tests and web form tests | `INSTRUCTIONS-IMMUTABLE`, `MISSING-INSTRUCTIONS-400`; direct 4,000-code-point parser check |
| Reassignment/access lifetime and depth-10 cap | Job-card policy/service and realtime mapper | Follow-up policy/postgres/realtime tests | `REASSIGN-*`, `DEPTH-10-REJECTION`, cancelled/inactive checks in §14 |
| Log and payload privacy | `server/src/app.ts` redaction, presenters, event mapper | log-privacy/calendar/history/realtime tests | marker sweep in §20; `/tmp/servora-f4-server.log` contained no private marker |
| Responsive/reflow and keyboard contract | web responsive styles/components/scripts | web suite and `responsive-smoke.mjs` | [`reflow-results.json`](./reflow-results.json), `RESPONSIVE-*`, `KEYBOARD-*`; form/history/FULL/RESTRICTED pass, Calendar keyboard control is blocking |

## 4. Synthetic data manifest

The seed script is [`server/scripts/f4-seed.ts`](../../../../server/scripts/f4-seed.ts).
It creates a clearly synthetic organization, a cross-organization fixture, Admin,
Manager, Staff A (source assignee), Staff B (different follow-up assignee), Staff
C (unrelated), Staff D (reassignment target), and cross-organization Staff.

Stable graph fixtures:

| Fixture | Purpose | Stable ID/reference |
| --- | --- | --- |
| S1 | Completed `SALES_MEETING`, Staff A, Customer A, Contact A, `FOLLOW_UP_REQUIRED`, next follow-up date | `843521a9-7f23-4b8b-b455-6dd95410eb07` |
| P1 | Completed product-delivery source with private delivery marker | `45780022-482e-468d-a5de-7dc2c638f82b` |
| G1 | Completed customerless `GENERAL_TASK` source | `da3d1aa6-fdd1-4712-8581-2d83561f9ee7` |
| C1 | Completed chain source | `5c693c75-f5ae-4c61-8103-323f7aafd0a3` |
| U1 | Customer A row assigned to unrelated Staff C | `8b22d285-7934-4085-882f-d169d2d25221` |
| X1 | Cross-organization JobCard | `6c5bc242-e710-449c-a94b-7d353a25832f` |
| Depth 0–10 | Fixed chain for the maximum-depth rejection | `90000000-0000-4000-8000-000000000000` … `90000000-0000-4000-8000-000000000010` |
| History 01–22 | Completed Customer A / Staff A jobs for real keyboard pagination | `70000000-0000-4000-8000-000000000001` … `70000000-0000-4000-8000-000000000022` |

The browser run created F1, F2, GF1, C2 and an idempotent replay fixture; the
created IDs are recorded in `runtime-results.json`. After the acceptance run,
GF1 was cancelled and Staff C was deactivated for the access-lifetime check.
No production data was changed.

## 5. Automated validation

Commands were run from the F4 worktree. No command result below is inferred.

| Area | Command/result |
| --- | --- |
| External-review repair runtime | `DATABASE_URL=<dedicated synthetic DB> node web/scripts/f4-acceptance.mjs` with real Chrome/Fastify/Vite — **145 PASS / 4 FAIL / 149**, status `BLOCKED`; failures are the two product-runtime blockers in §21 |
| Server build | `cd server && npm run build` — **passed** |
| Server full wrapper | `DATABASE_URL=postgresql:///servora_med_f4_suite TEST_DATABASE_URL=postgresql:///servora_med_f4_suite npm test -- --run` — **1 failed / 126 passed files; 1 failed / 1451 passed tests**. The sole failure is `tests/db-auth-contract.test.ts`: the host's macOS service identity setup made the deliberately wrong-password probe connect (`expected connection failure but connected`). |
| Server non-failing suite | `TEST_DATABASE_URL=postgresql:///servora_med_f4_suite npx vitest --run --exclude tests/db-auth-contract.test.ts --exclude tests/web-push-lifecycle.test.ts` — **125 files, 1443 tests passed**. The wrapper's `DATABASE_URL` prerequisite was supplied in the second full run; `web-push-lifecycle` then passed. |
| Server audit | `cd server && npm audit --audit-level=high` — **passed, 0 vulnerabilities** |
| Server lint | No server `lint` script exists; not run |
| Web build | `cd web && npm run build` — **passed**, Vite transformed 1,594 modules |
| Web full suite | `cd web && npm test -- --run` — **101 files, 1,185 tests passed** |
| Web responsive smoke | `cd web && npm run smoke:responsive` — **passed**, `responsive smoke OK`; includes 390/720/768/1024/1440, 200% text and accepted 320px reflow checks |
| Web bundle | `cd web && npm run bundle:check` — **passed**, 57 JavaScript chunks within the configured 500,000-byte limit |
| Web policy audit | `cd web && npm run audit:high` — **PASS_WITH_WAIVER**, only the documented RSC-only `GHSA-qwww-vcr4-c8h2` waiver |
| Raw web audit | `cd web && npm audit --audit-level=high` reports two high React Router advisory entries for that same RSC-only chain; no `npm audit fix` was applied because F4 authorizes no dependency or product change |
| Web lint | No web `lint` script exists; not run |
| Boundary check | Direct `tsx` parser check accepted 4,000 Unicode code points; existing server/web tests reject 4,001 |

## 6. Admin acceptance

**Scenario IDs:** `REPO-RUNTIME`, `ROOT-FOLLOW-UP-CONTEXT`,
`ROOT-RAW-FIELDS`, `ADMIN-SOURCE-ACTION`, `ADMIN-CREATE-F1`,
`ADMIN-CREATE-PAYLOAD`, `ADMIN-FULL`, `MANAGEMENT-CHILDREN`,
`MANAGEMENT-CHILDREN-PANEL`, `CUSTOMER-HISTORY-MANAGEMENT`,
`CALENDAR-ADMIN-FULL` — **PASS**.

Admin opened completed S1, saw the management action, created F1, and landed on
the created JobCard. The observed form request contained type/title/instructions,
assignee and scheduled date; `customerId`, `sourceJobCardId`,
`scheduledEndsAt`, source notes and meeting summary were not form-controlled
fields. The source remained completed, the follow-up badge/context rendered, and
management could list/render both direct children.

The management Calendar showed the follow-up with `FULL` source link parity.
The full management customer-history UI and Staff-history UI were rendered; a
focused screenshot is [`admin-customer-history.png`](./screenshots/admin-customer-history.png).

## 7. Manager acceptance

**Scenario IDs:** `MANAGER-CREATE-F2`, `CALENDAR-REALTIME-REFRESH`,
`STAFF-HISTORY-MANAGEMENT` — **PASS**.

Manager independently opened S1 and created F2. The already-open Admin Calendar
received the existing `servora.change` invalidation and issued a new Calendar
list request (`2 → 3` observed). No new notification kind or realtime event type
was introduced.

## 8. Source Staff FULL acceptance

**Scenario IDs:** `STAFF-A-FULL`, `CALENDAR-STAFF-A-FULL`, `JOBDETAIL-FULL-UI`
— **PASS**.

Staff A, the S1 assignee, opened F2 and received `sourceAccess: FULL`, a working
source path, the source-context panel and the exact date labels. Staff views did
not render management children or ancestor breadcrumbs. Screenshot:
[`staff-a-job-full.png`](./screenshots/staff-a-job-full.png).

## 9. Different-assignee Staff RESTRICTED acceptance

**Scenario IDs:** `STAFF-B-RESTRICTED`, `RESTRICTED-*`,
`CALENDAR-RESTRICTED-UI` — **PASS**.

Staff B opened F1 and received the authorized follow-up instructions plus safe
source dates, but `sourceAccess: RESTRICTED`, `sourceJobPath: null`, no source
link, no source operational note, meeting summary, activity, delivery detail or
source Staff identity. The restricted Calendar UI retained the follow-up
indicator/date context without source text or link. Screenshot:
[`staff-d-calendar-restricted.png`](./screenshots/staff-d-calendar-restricted.png).

## 10. Unrelated Staff and cross-organization rejection

**Scenario IDs:** `STAFF-C-404`, `CALENDAR-STAFF-C-HIDDEN`,
`CROSS-ORG-ISOLATION`, `STAFF-HISTORY-ANTI-ENUMERATION` — **PASS**.

Unrelated Staff C received canonical 404 for direct F1 access and no F1/F2
Calendar events. Cross-organization Staff received no Customer A, JobCard,
history, Staff profile or Calendar data; the Staff profile endpoint's canonical
role boundary was 403/404 as permitted by the contract. Staff parameterized
history returned the same canonical `404 STAFF_PROFILE_NOT_FOUND` for another
existing Staff target and an absent target.

## 11. Customer history privacy

**Scenario IDs:** `CUSTOMER-HISTORY-MANAGEMENT`,
`CUSTOMER-HISTORY-STAFF-A`, `CUSTOMER-HISTORY-STAFF-B`,
`CUSTOMER-HISTORY-PRIVACY`, `CUSTOMER-HISTORY-UI` — **PASS**.

Management saw S1, follow-ups and the authorized unrelated Staff C row. Staff A
and Staff B received only their own-assignment rows, and each returned `total`
matched its visible item count. No source instructions, notes, summaries,
activity descriptions, source Staff identity or hidden-count wording appeared.
The management UI was captured in the screenshot linked above.

The >100-row pagination contract is covered by the merged F3 automated
`100 + 1` test and the implementation's `total/limit/offset` handling; this F4
browser fixture intentionally used two children rather than creating 101
synthetic records. **Browser 101-row scenario: NOT EXERCISED; authoritative F3
test: PASS.**

## 12. Staff history privacy

**Scenario IDs:** `STAFF-HISTORY-MANAGEMENT`, `STAFF-HISTORY-SELF`,
`STAFF-HISTORY-ANTI-ENUMERATION`, `STAFF-HISTORY-UI` — **PASS**.

Management Staff A history attributed S1/F2 correctly. Staff self-history was
own-filtered with a truthful total; the parameterized other-target route was
uniform 404. The management Staff-history UI rendered and is included in the
reflow artifact.

## 13. Calendar parity

| Actor/card | JobDetail | Calendar | Result |
| --- | --- | --- | --- |
| Admin → F1 | `FULL`, source path | `FULL`, source path | **PASS** |
| Staff A → F2 | `FULL`, source path | `FULL`, source path | **PASS** |
| Staff B → F1 before reassignment | `RESTRICTED`, no path | `RESTRICTED`, no path | **PASS** |
| Staff C → F1/F2 | canonical 404/not visible | not listed | **PASS** |
| Staff D → F1 after reassignment | `RESTRICTED`, no path | `RESTRICTED`, no path | **PASS** |

**Scenario IDs:** `CALENDAR-ADMIN-FULL`, `CALENDAR-STAFF-A-FULL`,
`CALENDAR-STAFF-C-HIDDEN`, `CALENDAR-PRIVACY`, `CALENDAR-NO-INSTRUCTIONS`,
`CALENDAR-RESTRICTED-UI` — **PASS**.

Calendar payloads carried the narrow follow-up context only. They contained no
`followUpInstructions`, source notes, summaries, source Staff identity, or chain
data. The Calendar route in this runtime uses the existing date-cell interaction;
the harness did not rely on a broken deep link.

## 14. Reassignment and realtime

F1 was reassigned from Staff B to Staff D. Before reassignment, Staff B could
open the follow-up and see its Calendar entry. After reassignment, Staff B's
JobDetail and Calendar access disappeared; Staff D received the current
restricted mode and Calendar entry. **Scenario IDs:** `REASSIGN-F1`,
`REASSIGN-OLD-LOSS`, `REASSIGN-NEW-MODE`, `REASSIGN-CALENDAR-NEW`,
`REASSIGN-CALENDAR-OLD` — **PASS**.

The sanitized database observation after the run showed existing event types and
resource keys, including bodyless `calendar`, `job-detail`, customer, board,
notification, overview, reports and assignee-specific keys. The F1 reassignment
event had Admin/Manager role audience plus the old/new assignee user audience;
unrelated Staff was not added. No private text is present in the realtime schema
or browser network evidence.

The external-review repair added one-mutation/one-surface network observation
with a 750 ms quiet window:

| Open surface | Matching request delta | Result |
| --- | ---: | --- |
| JobDetail | 1 | **PASS**, stable in quiet window |
| Customer history | 1 | **PASS**, stable in quiet window |
| Staff history | 3 | **PASS**, bounded and stable; one persisted `job.assignment_changed` event, with the development-only React StrictMode remount trace documented |
| Management children panel | 0 | **FAIL**, no children-list refresh after creation |

The Staff trace is not an ongoing loop: all three requests occurred after the
single persisted event and the count remained unchanged throughout the quiet
window. The Children panel result is a product-runtime blocker. The server-side
F3 realtime tests still cover planning, field updates, assignment, cancellation
and approval invalidation, but they do not make the open Children panel reload.
No new notification kind was introduced.

## 15. Chain and multiple-child behavior

**Scenario IDs:** `CHAIN-CREATE`, `MANAGEMENT-CHILDREN`,
`STAFF-CHILDREN-403`, `STAFF-CHILDREN-PANEL-HIDDEN`,
`STAFF-NO-CHILDREN-REQUEST`, `DEPTH-10-REJECTION` — **PASS**.

The browser run created C2 from completed C1; C1 remained independent. Management
received a working C2 → C1 breadcrumb with the source title and path. Staff saw
no ancestor breadcrumb and issued zero ancestor-detail requests. S1 had two
direct children at the initial boundary assertion and management returned
`total: 2`; Staff source ownership still returned canonical 403 and the UI made
no children request. The fixed depth-0…10 fixture rejected a
depth-11 child with `409 FOLLOW_UP_MAX_DEPTH_REACHED`. The >100 direct-child
pagination behavior is an automated F3 proof, not a browser claim (see §11).

## 16. Customerless source behavior

**Scenario IDs:** `CUSTOMERLESS-CREATE`, `CUSTOMERLESS-EXPLANATION`,
`CUSTOMERLESS-TYPE-DISABLE`, `CUSTOMERLESS-TYPE-409` — **PASS**.

G1 opened the follow-up form with only `GENERAL_TASK` usable. The exact UI copy
was rendered:

> Bu takip işi için müşteri bağlantısı bulunmadığından yalnız Genel Görev oluşturulabilir.

GF1 was created successfully. A direct `PRODUCT_DELIVERY` attempt returned
`409 FOLLOW_UP_SOURCE_CUSTOMER_REQUIRED`. Realtime inspection found no
`customer-detail:null` key; `job-detail:<source>` remained present.

## 17. Idempotency and instructions contract

**Scenario IDs:** `IDEMPOTENT-REPLAY`, `REPLAY-ACCESS-*`,
`REPLAY-NO-ACTIVITY-DUPLICATE`, `REPLAY-NO-NOTIFICATION-DUPLICATE`,
`REPLAY-NO-REALTIME-DUPLICATE`, `REPLAY-*-SIDE-EFFECTS`,
`INSTRUCTIONS-IMMUTABLE`, `MISSING-INSTRUCTIONS-400` — **PASS**.

Two identical API requests using one `clientActionId` produced one logical
`P1 — idempotent F4 replay` JobCard (`REPLAY_ROWS=1`). The live repair harness
then changed the replay actor's source access through `FULL → RESTRICTED → FULL`
using only synthetic DB controls. Every replay returned the same receipt/job ID,
recomputed the current presentation mode, and left activity IDs/totals,
notification IDs and realtime refresh counts unchanged. The actor role and
assignments were restored in a `finally` path.

Whitespace-only instructions returned 400; the generic JobCard PATCH rejected
instruction mutation. The direct parser boundary check accepted 4,000 Unicode
code points, while existing server/web tests reject 4,001.

## 18. Responsive and accessibility verification

The live F4 harness checked JobDetail at 390px and 320px with
`scrollWidth === clientWidth` and no horizontal overflow. The repository smoke
also covered 1440px desktop plus 390/720/768/1024 widths and its accepted 200%
text/320px reflow fixtures.

[`reflow-results.json`](./reflow-results.json) measures these five real app
surfaces at the accepted methodology:

```text
200%: html { font-size: 200% !important; } at 390 CSS px
400%: WCAG-equivalent 320 CSS px viewport (not CSS zoom)
```

| Surface | 200% overflow | 400% reflow overflow |
| --- | --- | --- |
| Job detail FULL | false | false |
| Follow-up create form | false | false |
| Customer history | false | false |
| Staff history | false | false |
| Restricted Calendar | false | false |

Real Tab/Enter traces produced these results:

- **PASS:** form controls and submit traversal; visible submit focus ring;
  empty-submit error focus; `aria-invalid=true` on title, instructions and
  assignee; Customer history “Daha fazla göster”; Staff A FULL source link;
  Staff D RESTRICTED absence of a source link.
- **FAIL:** the Calendar date/event control was absent from the first 80 real
  Tab stops. Enter activation and retained focus context therefore could not be
  verified. This is a blocking accessibility defect, not a missing harness
  assertion.

## 19. Console and network

For Admin, Manager, Staff A/B/C/D and cross-organization sessions:

- page-error count was zero for every session;
- no prohibited `uncaught`, React key, state-update-after-unmount, parser,
  syntax-error or reconnect-loop finding occurred;
- no 5xx response occurred;
- the Staff source page issued no children request and no ancestor traversal;
- duplicate follow-up POST was not generated by the UI.

The harness deliberately exercised negative 401/403/404/400/409 branches. Their
expected browser resource messages are retained in `runtime-results.json` and
were not hidden. Real Chrome also emitted this non-blocking Ant Design warning:

```text
Warning: [antd: Descriptions] Sum of column `span` in a line not match `column` of Descriptions.
```

It is recorded as an observed UI-library warning, not classified as a parser or
application crash. No CSS parser warning appeared in the live Chrome harness;
the separate Vitest suite printed its existing jsdom CSS parse messages while
still passing all 1,185 tests.

## 20. Privacy-marker audit

Markers used by the synthetic seed were:

```text
PRIVATE_SOURCE_NOTE_F4
PRIVATE_MEETING_SUMMARY_F4
PRIVATE_ACTIVITY_F4
PRIVATE_DELIVERY_DETAIL_F4
PRIVATE_SOURCE_STAFF_F4
PRIVATE_FOLLOW_UP_INSTRUCTIONS_F4
```

Observed policy:

| Surface | Expected | Result |
| --- | --- | --- |
| Authorized follow-up JobDetail | Follow-up instructions only | **PASS** |
| Staff B restricted source context | No source note/summary/activity/delivery/source Staff marker | **PASS** |
| Calendar | No private marker and no instructions field | **PASS** |
| Customer history | No private marker | **PASS** |
| Staff history | No private marker | **PASS** |
| Children rows | No private source payload | **PASS** |
| Realtime/network | Bodyless resource keys; no private text | **PASS** |
| Fastify server log | All six markers absent | **PASS** |
| Evidence JSON/README | No password, cookie, Authorization header or private marker value | **PASS** |

The only deliberate authorized instruction marker is present in the synthetic
follow-up detail assertion; it is not copied to source notes, Calendar, history,
children or realtime payloads.

## 21. Blocking and non-blocking findings

### Blocking product-runtime findings

1. **Open management Children panel does not realtime-refresh.** After a real
   follow-up mutation, JobDetail and the other observed history surfaces
   refreshed, but `GET /api/job-cards/:sourceId/follow-ups` stayed at `0 → 0`.
   The newly created child is therefore absent until another reload trigger or
   navigation occurs.
2. **Calendar date/event cells are not keyboard reachable.** The focused date
   cell existed and was clickable, but no date/event control received focus in
   80 real Tab stops. Enter activation could not be tested.

Both require production-code changes. The external decision authorizes only
evidence/harness repairs in F4, so the defects are recorded and left unfixed.

### Non-blocking/environment findings

1. The 101-row children page remains proven by merged F3 tests (`100 + 1`), not
   by a 101-row live browser run. The repair seed instead adds 22 history rows to
   exercise real history pagination by keyboard.
2. The server wrapper's host-specific `db-auth-contract` wrong-password probe is
   affected by the local macOS service identity; exact-head CI remains the
   authoritative PostgreSQL gate after product repair is authorized and made.
3. The policy-waived React Router RSC advisory and the observed Ant Design
   `Descriptions` warning are unchanged; neither caused a page error or 5xx.

## 22. F1–F3 evidence reconciliation

- **F1:** server contract, migration and privacy tests remain the source of truth;
  this artifact adds live synthetic creation, idempotency, marker and log checks.
- **F2:** the earlier real Fastify/Vite browser walkthrough is preserved in
  [`../f2/README.md`](../f2/README.md). F4 confirms its FULL/RESTRICTED,
  customerless, children and mobile observations against a live PostgreSQL
  runtime; no F2 artifact was moved or rewritten.
- **F3:** the earlier history/calendar evidence is preserved in
  [`../f3/README.md`](../f3/README.md). Its route-mocked browser limitation is
  superseded for the covered scenarios by this live runtime; exact PostgreSQL
  CI and F3 pagination/realtime tests remain authoritative for broader cases.
- F4 is the only canonical closeout artifact. No F4 result is written into F2 or
  F3 evidence, and no F1–F3 branch/worktree is cleaned up.

## 23. Final acceptance matrix

| Area | Status | Evidence |
| --- | --- | --- |
| Admin create and FULL continuity | PASS | runtime IDs and Admin section |
| Manager create and realtime Calendar refresh | PASS | runtime IDs and Manager section |
| Staff A FULL | PASS | JobDetail/Calendar parity and screenshot |
| Staff B RESTRICTED | PASS | restricted detail/Calendar and marker sweep |
| Staff C unrelated | PASS | canonical 404 and hidden Calendar |
| Cross-organization isolation | PASS | cross session API matrix |
| Customerless source/type matrix | PASS | UI + API 409 + realtime key check |
| Ineligible source status matrix | PASS | direct HTTP sweep: NEW, ACCEPTED, IN_PROGRESS, WAITING_APPROVAL, REVISION_REQUESTED, CANCELLED |
| Children management/Staff boundary | PASS | 403/no Staff UI request/management total 2 |
| Open management Children panel realtime refresh | **FAIL / BLOCKER** | one mutation, children-list request `0 → 0` |
| Children >100 pagination | PASS (automated F3) | 101-row test; live browser NOT EXERCISED |
| Customer history role filtering/totals | PASS | management, Staff A/B live API/UI |
| Staff history/self/anti-enumeration | PASS | live API/UI and 404 parity |
| Calendar FULL/RESTRICTED parity | PASS | live API/UI |
| Reassignment/access lifetime | PASS | Staff B → D live sweep |
| Chain continuation/max depth | PASS | C2 live; depth-11 API conflict |
| Cancelled/inactive access lifetime | PASS | GF1 `CANCELLED`; Staff C login 401 after deactivation |
| Idempotency/current-view replay | PASS | same receipt across FULL → RESTRICTED → FULL; activity/notification/realtime observations unchanged |
| Privacy/log redaction | PASS | marker/payload/server-log sweep |
| Responsive 1440/390/320, 200%, 400% | PASS | smoke + reflow artifacts |
| Keyboard/focus except Calendar | PASS | real Tab/Enter form, error/ARIA, history pagination, FULL link, RESTRICTED no-link traces |
| Calendar keyboard event | **FAIL / BLOCKER** | no date/event control in first 80 real Tab stops; Enter not exercisable |
| Console/network | PASS with recorded non-blocking warning | runtime JSON |

## 24. Gate status

```text
F4 implementation-under-test: BLOCKED BY TWO RUNTIME DEFECTS
F4 synthetic runtime acceptance: 145 PASS / 4 FAIL / 149
F4 evidence artifact: PRESENT, status BLOCKED
Canonical plan closeout: BLOCKED CHECKPOINT RECORDED
Draft PR #87: OPEN / DRAFT
New repair exact-head server/web CI: NOT RUN; not a substitute for failed runtime acceptance
External F4 re-review: NOT ELIGIBLE UNTIL PRODUCT REPAIR IS AUTHORIZED AND VERIFIED
PR Ready: NOT AUTHORIZED
Merge: NOT AUTHORIZED
Staging/production: NOT AUTHORIZED
Branch/worktree cleanup: NOT AUTHORIZED
```

The final handoff uses `BLOCKED_BY_RUNTIME_DEFECTS`. No Ready, merge, staging,
production or cleanup action is authorized. The next step requires explicit
production-repair authority for the Children realtime invalidation and Calendar
keyboard interaction, followed by a fresh synthetic run and new exact-head CI.
