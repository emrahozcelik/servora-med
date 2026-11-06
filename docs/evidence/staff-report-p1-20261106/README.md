# Staff report P1 evidence — 2026-11-06

Base and observed production release: `3da00aeeb7863df7196a02f9290ab6cda11b8240`.
Root cause is CONFIRMED. The production incident remains OPEN: this work does not
merge or deploy the hotfix.

The deployed ReportsService failed for both sale capability values with
`Staff current workload type aggregate invariant could not be resolved`.
All preceding SQL reads succeeded. Anonymous reconciliation showed that the
operational/typed difference equals the active WEEKLY_REPORT count. See the two
production JSON records. They contain no identities, request credentials or rows.
The observed schema was 60 migrations at `060_crm_duplicate_review_decisions`,
PostgreSQL 17.11. No migration, restart, log setting or production write occurred.

The authenticated HTTP request was not replayed: the HTTP 500 is operator-reported;
the independently reproduced deployed service error maps through the existing
INTERNAL_ERROR / HTTP 500 boundary. Existing journal records were inaccessible to
the deploy account; no root credentials or host.md were used.

## Reproduction and verification

Node 22.23.3; new task-owned PostgreSQL 17 cluster, UTF-8 locale and SCRAM auth;
separate empty `servora_med_test_staff_p1_20261106` database. Only synthetic data.

- `red.log`: the final five-state test against baseline repository/service source
  failed in the same service invariant (5 FAIL).
- `green.log`: identical test against the fixed source passed (5 PASS).
- `reports-suite.log`: all report regressions passed (19 files / 184 tests), including
  routes/authorization, organization isolation, active/inactive Staff, current and
  historical quantities, snapshots and both sale capability shapes.
- `build.log`: server build passed.

Expanded fixture setup initially failed database timestamp/pair constraints and
parameter inference. The fixture was corrected; these were not product failures.
The final RED/GREEN uses the same schema-valid fixture in both phases.

Commands: `cd server && npm run build`; with the isolated TEST_DATABASE_URL,
`npm test -- --run tests/reports-weekly-workload-postgres.test.ts` and
`npm test -- --run reports-`.

The internal summary includes the weekly bucket to preserve exact reconciliation;
the service filters it before returning the existing productive-work API buckets.
Counters, completed activity, attribution, date ranges and public DTOs are unchanged.
Source file hashes are in source-hashes.json. Hosted CI is verified separately
against the eventual PR commit; local logs do not assert hosted CI success.
