# WeeklyReport retirement acceptance — WR-RET-1 remediation

Scope: close independent review R1/R2/R3 without changing retirement policy or
application behavior. Production remains NO-GO under the 2026-10-23 retirement
amendment in DECISIONS.md. Migration 052 and staff lifecycle guards are retained.

## Commands

Use the password-bearing isolated TEST_DATABASE_URL and PG17 client/server
contract in local-test-environment.md. Build server before the tests. Provision
only disposable test databases; these commands do not authorize production access.

```sh
cd server
npm run build
npm test -- --run tests/weekly-report-recurrence-retirement.test.ts
cd ../web
npm run build
WRRET_EVIDENCE_DIRECTORY=/absolute/new/evidence/path node scripts/weekly-report-retirement-browser.mjs
```

To reproduce the negative control, build exact base 8017414 in a separate source
snapshot and set WRRET_BASE_SERVER to its absolute server directory when running
the retirement test from the remediation checkout. This changes only the child
process executable: fixture, credentials and assertions stay the same. Never set
this override in a passing-head gate. Set WRRET_EVIDENCE_DIRECTORY to a distinct
path for every attempt; preserve unsuccessful attempts.

## Finding mapping and dependency inventory delta

- R1: server/tests/weekly-report-recurrence-retirement.test.ts replaces the minimal
  buildApp fixture with server/scripts/acceptance/weekly-report-retirement.mjs.
  The helper launches actual dist/index.js, waits for /api/health after onReady,
  authenticates through the real repository and probes all five removed routes.
  The old bootstrap exposes routes and processes the due rule. No fixed sleep
  is used to infer absence of wiring. SIGTERM must exit zero; application-named
  PostgreSQL sessions must disappear before the owned schema is dropped.
- R2: the same scenario seeds active users and staff profiles, enabled and paused
  rules with questions, instructions, requester, version, expired lease, retry,
  outcome and microsecond timestamps, plus a real approved historical report.
  Snapshots use to_jsonb over complete rows, avoiding JS Date truncation. This
  proves logical equality of every persisted column and row membership, not
  PostgreSQL heap-byte equality. Staff create, Manager/Admin multi-staff bulk,
  duplicate handling, submission reads, PDF download and frozen PDF model
  equality execute while legacy rules remain present and unchanged.
- R3: web/scripts/weekly-report-retirement-browser.mjs imports that fixture and
  runs actual Vite proxying to actual Fastify. Chromium drives the real routed
  WeeklyReportCreateScreen at 1440px and 390px for Staff, Manager and Admin.
  Requests are recorded without cookies/passwords. Only the deliberately lost
  successful response is intercepted: route.fetch first commits to Fastify,
  then aborts delivery; the retry must carry the identical body/action id.
  The script checks client/backend validation, duplicates, navigation/results,
  keyboard and error focus, scroll/reflow, 320px/200% text, >=44px submit targets,
  absent recurrence UI/requests, screenshots and full legacy-row equality.

The baseline deletion inventory remains in the original immutable evidence
package. Its claim that the old retirement test exercised successful single/bulk
commands is superseded by this document: the original test only checked a 401
probe and six selected rule columns. The remediation now exercises the actual
commands and complete rows. Baseline modified files omitted there are:
web/src/jobs/WeeklyReportQuestionEditor.tsx,
web/scripts/weekly-report-question-fixture.tsx and
web/scripts/weekly-report-question-geometry.mjs. Their changes remain retained;
existing editor geometry checks remain part of smoke:responsive.

## Test accounting and release assessment

One server test is replaced one-for-one: expected totals remain 4285 server
(4277 passing and eight environment-dependent skips in prior CI) and 2698 web.
Six browser scenarios are external acceptance cases, not added Vitest passes.
Actual new gate results and exact head/tree belong to the remediation evidence
bundle; this document does not predeclare them passed.

Release/rollback risk is unchanged. No recurrence manager remains to quiesce
legacy enabled rules. Authorized read-only production inspection and separately
approved quiescence, if required, remain gates for deploy and older-release
rollback; the latter can restart the worker. Production enabled-rule counts
remain unknown. Disposable tests do not establish production state.
