# Production Staff performance report — HTTP 500 triage (2026-11-06)

**Status: OPEN / ROOT CAUSE CONFIRMED / HOTFIX NOT DEPLOYED.** User observed "Personel operasyon analizi yüklenemedi — Beklenmeyen bir hata oluştu." on the deployed `3da00aeeb7863df7196a02f9290ab6cda11b8240` release. Do not label this incident resolved merely because UI or CI passes.

## Independent diagnosis — 2026-11-06

The deployed ReportsService reproduced `Staff current workload type aggregate
invariant could not be resolved` with both sale capability settings. All preceding
SQL reads passed. Operational counters include outstanding WEEKLY_REPORT jobs;
productive-work buckets exclude them. The service incorrectly compared these
different totals for exact equality. Anonymous read-only reconciliation confirmed
that the difference equals the active weekly-report count.

Observed release SHA matches the reported SHA; PostgreSQL 17.11 and migration
head `060_crm_duplicate_review_decisions` (60 migrations) were read-only verified.
The existing deploy account ran bounded READ ONLY transactions. No production
data, schema, service, log level or permissions were changed; no session was
created. No real data was copied into tests. host.md/root credentials were not
opened. Existing journal records remain inaccessible to the deploy account;
an authenticated HTTP request was not replayed. The operator-reported HTTP 500
and the independently reproduced service error are distinct evidence.

The separate [P1 hotfix PR #413](https://github.com/emrahozcelik/servora-med/pull/413)
keeps strict internal reconciliation and filters the weekly bucket before public
productive-work output. The same final PostgreSQL regression gave 5 FAIL on
baseline source and 5 PASS with the fix; all report regressions passed (19 files /
184 tests). The fix is not part of PR #412. Merge/deployment and authenticated
post-deployment acceptance remain separate authorization gates.

## Scope and safety

- Management-only `GET /api/reports/staff` (`server/src/modules/reports/routes.ts`). Do not use unscoped test identities or reveal organization, staff, customer, token, cookie, session or database values.
- `web/src/reports/StaffPerformanceReport.tsx` displays the API error. `server/src/errors/index.ts` maps uncaught errors to HTTP 500 with safe `INTERNAL_ERROR` and "Beklenmeyen bir hata oluştu." These facts identify the error boundary, **not** its underlying cause.
- Production access and read-only investigation require the authorized operator. The initial UI author had no production evidence; the authorized independent diagnosis above supersedes that limitation without claiming production activation.

## Authorized read-only evidence collection (no mutations)

1. Record approximate occurrence time (Europe/Istanbul), authenticated role, selected date range, request path, HTTP status and safe response error code using browser Network tools. **Never export HAR with cookies, authorization headers or PII.**
2. Correlate that window with existing server process logs through the approved operator workflow (systemd `servora-med.service`). Inspect privately; share only the error category, stack frame/function or SQLSTATE and timestamps after redaction. Avoid raw request payloads, SQL bind values, secrets, names and raw query strings.
3. Determine whether failure is in query parsing, snapshot transaction, `getStaffPerformanceScope`, one of the batch reads, a service aggregate invariant, or response serialization. Verify against the **actual deployed SHA and migration catalog**; do not infer production schema state from tests alone.
4. Reproduce with sanitized, synthetic data in isolated PostgreSQL 17 at the exact code/schema version. Include active/inactive staff, no-work staff, archived/historical work, boundary timestamps and organizational isolation. First establish a failing regression (RED), then fix the actual cause (GREEN).
5. Validate management-only authorization and no data disclosure across organizations. Preserve REPORT-001 attribution and period semantics.

## Deployment gate

Treat staff-report HTTP 500 as a separate, unresolved production incident until supported by production evidence and a tested fix. Avoid speculative SQL or fail-open changes. No schema migration, new release, log-verbosity increase, credentials access or production writes without explicit approval.

This document supports the operator/Codex handoff only; it is not a PASS certificate.
