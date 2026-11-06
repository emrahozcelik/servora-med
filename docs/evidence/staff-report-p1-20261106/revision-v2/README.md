# Revision v2 — preserve productive bucket contract

The previous hotfix head bbb1f3dd859a54dd8fe5716660d46ac11c0b2e13 failed hosted CI
run 42258474826: 1 server test failed, 4343 passed, 8 skipped. Web/Auth KDF passed.
The existing weekly-report-reporting-exclusion-postgres test correctly required
productive-only buckets. ci-contract-red.log reproduces that failure locally.

The revised source keeps currentWorkloadByType unchanged and adds a separate
internal weeklyReportWorkload aggregate. Both counts come from the same SQL
snapshot and are reconciled with operational totals using strict equality.
The internal field never appears in public Staff/team report responses. The
existing productive-bucket expectation is unchanged; a new assertion checks that
the internal count includes only the active weekly obligation, not completed ones.

Test port/row fixtures explicitly provide zero weekly obligations. Two SQL-text
checks now verify that the outer assigned-work join remains unfiltered by type;
a conditional weekly COUNT no longer triggers an overly broad regex. No test
expectation was weakened to allow a weekly productive bucket.

Node 22.23.3; task-owned PostgreSQL 17, UTF-8/SCRAM; no production data.

- Build: PASS.
- Focus: npm test -- --run reports- tests/weekly-report-reporting-exclusion-postgres.test.ts:
  20 files / 185 tests PASS, including the existing CI failure and five-state P1 cases.
- Full server: npm test -- --run: 373 files PASS, 5 files SKIPPED;
  4344 tests PASS, 8 SKIPPED, zero failures. Unexecuted cases are not counted as PASS.
- Source diff whitespace check: PASS.

The original production-root-cause evidence and baseline five-state RED remain
historical in the parent directory. This revision does not relabel the failed
bbb1f3d CI run. The new commit requires its own hosted run. Current source hashes
are in this directory, not the parent's v1 manifest. Retained logs omit only extra
blank lines at EOF; stdout-hashes.json records original and retained bytes.

Production incident remains OPEN. There is no merge, deploy, migration, data,
permission or service change in production; no root credentials/host.md were used.
