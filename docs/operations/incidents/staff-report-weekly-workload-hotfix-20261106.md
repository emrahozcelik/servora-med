# Staff report weekly workload P1 — confirmed source fix

Status: ROOT CAUSE CONFIRMED / HOTFIX PREPARED / PRODUCTION INCIDENT OPEN.

Observed release: `3da00aeeb7863df7196a02f9290ab6cda11b8240`.

## Cause

Staff operational counters intentionally include outstanding weekly-report jobs.
The productive-work type buckets intentionally exclude them. ReportsService
compared those different cohorts for exact equality, so one active weekly report
could fail the entire team report and the affected individual report. The observed
schema head matched the release and preceding SQL reads succeeded; the failure is the service reconciliation invariant,
not an HTTP parsing, query syntax or JSON serialization error.

## Minimal correction

The staff summary query keeps the productive-work buckets unchanged and supplies
a separate internal weeklyReportWorkload count from the same SQL snapshot.
The service includes that count in its strict reconciliation without adding it
to the productive-work distribution. No new public API field, schema,
migration, activity definition, historical attribution or approval stage is added.
Weekly obligations remain in open/waiting/revision counts and do not become
productive completed activities. This hotfix is separate from PR #412's UI work.

## Evidence and limits

See [the evidence bundle](../../evidence/staff-report-p1-20261106/README.md).
The same five-state synthetic PostgreSQL regression fails on production source
and passes on the hotfix. Existing report regression coverage also passes.

The first revision (bbb1f3d) failed hosted CI's existing weekly-report exclusion
contract because it added a weekly bucket to an established productive read-model
field. The revised fix preserves that field and its existing test expectation;
the read model now supplies a separate count for administrative obligations.

Production checks used the existing servora-deploy connection and an explicitly
READ ONLY transaction with a bounded statement timeout. No account/session was
created and no real data was copied into tests. host.md/root credentials were not
opened. Journal access was unavailable; authenticated HTTP replay and production
activation are not claimed. A narrow operator-approved journal reader remains an
operational follow-up, not a permission change performed by this task.

Merge, deployment and post-deployment authenticated HTTP acceptance require the
separately authorized release process. The production incident stays OPEN until
that acceptance succeeds; source/CI success alone does not close it.
