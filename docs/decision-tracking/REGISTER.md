# Decision delivery register

**Snapshot:** 2026-11-23 (initial, non-exhaustive). For meaning of checkboxes and mandatory update behavior see [README.md](README.md). `[x]` denotes a specific evidence-backed milestone, **not** an automatically completed overall feature. Source policy is [DECISIONS.md](../../DECISIONS.md).

## W0-DISCOVERY — Warehouse / Inventory

- **Authority:** [MOD-001](../../DECISIONS.md#mod-001--warehouse-accounting-and-integration-boundaries) accepts **future module boundaries only**; it explicitly creates no warehouse tables or stock balances. [Decision reconciliation](../architecture/decision-reconciliation-report.md) names W0 discovery without implementation authorization.
- [x] Future ownership/boundary accepted — MOD-001 (2026-10-14).
- [ ] W0 module-specific design and acceptance criteria approved.
- [ ] Implementation verified on the intended source revision.
- [ ] PR merged and exact-main checks verified.
- [ ] Deployment/activation separately authorized and verified.
- [ ] End-to-end operational acceptance verified.
- [ ] **Closed**.
- **Next:** Define and approve W0 scope; do not interpret MOD-001 as approval to construct the full module.

## SVC-DISCOVERY — Maintenance / Repair / Service

- **Authority:** Product direction discussed with owner in November 2026; **no independently accepted in-repository service contract was established during this review**. Existing JobCard rules remain authoritative; the discussion is not an implementation grant.
- [ ] Service case, asset/equipment, and JobCard boundaries accepted in a new decision/contract.
- [ ] Delivery slices and acceptance criteria approved.
- [ ] Implementation verified.
- [ ] PR merged and exact-main checks verified.
- [ ] Deployment separately authorized and verified.
- [ ] End-to-end operational acceptance verified.
- [ ] **Closed**.
- **Next:** Document the candidate design, reconcile it with current JobCard policy, obtain explicit acceptance before implementation.

## WR-WEEK — Weekly Report calendar and deadline

- **Authority:** [WR-WEEK](../../DECISIONS.md#wr-week--weekly-report-working-week-mondaysaturday-and-monday-deadline), [feature contract](../features/weekly-report-workweek.md). The accepted policy covers **Monday–Saturday** and a **following-Monday deadline**, replacing earlier Friday assumptions.
- [x] Policy and contract accepted — 2026-11-21.
- [x] Implementation merged — [PR #476](https://github.com/emrahozcelik/servora-med/pull/476), merged 2026-11-21.
- [ ] Production release containing WR-WEEK verified against exact deployment evidence (**NOT_VERIFIED in this initial review**).
- [ ] Historical/new report period handling and real operational acceptance verified.
- [ ] **Closed**.
- **Next:** Reconcile the known historical report date correction against the exact production release and acceptance report, rather than relying on a PR merge.

## JOB-010 — Assignment acceptance window

- **Authority:** [JOB-010](../../DECISIONS.md#job-010--assignment-acceptance-window-and-delivery-rescue), [feature contract](../features/assignment-acceptance-sla.md).
- [x] Contract accepted — 2026-11-20.
- [x] Source releases merged — [PR #470](https://github.com/emrahozcelik/servora-med/pull/470), [PR #471](https://github.com/emrahozcelik/servora-med/pull/471), [PR #472](https://github.com/emrahozcelik/servora-med/pull/472), per decision record.
- [x] Flag activated in production — [2026-11-21 activation record](../operations/2026-11-21-job010-assignment-window-activation.md), release `b0d3341`.
- [ ] First live offer/deadline/reminder functional evidence reviewed — activation record states **not yet observed**.
- [ ] **Closed**.
- **Next:** Read-only verify initial actual business events and acceptance before closure; activation remains an established fact.

## OVR-6 — Lateness alerts and quiet hours

- **Authority:** [OVR-6](../../DECISIONS.md#ovr-6--lateness-notifications-quiet-hours-start-reminder-and-management-alerts), [feature contract](../features/lateness-notifications-quiet-hours.md).
- [x] Contract accepted — 2026-11-22.
- [x] Implementation merged — [PR #477](https://github.com/emrahozcelik/servora-med/pull/477), merged 2026-11-22.
- [x] Production deployed/worker activated — [2026-11-22 record](../operations/2026-11-22-ovr6-lateness-alerts-activation.md), release `2dd1baf`, schema 069, deployment smoke/backup/observation PASS.
- [ ] First in-window delivery rows, activity and notification events inspected — activation record explicitly says **not yet observed**, first eligible window 2026-11-23 08:00 Europe/Istanbul.
- [ ] **Closed**.
- **Next:** Verify actual events read-only; do not claim every alert type delivered without evidence.

## OVR-7 — Lateness reporting

- **Authority:** [OVR-7](../../DECISIONS.md#ovr-7--lateness-reports), [feature contract](../features/reporting/lateness-reports.md).
- [x] Contract accepted — 2026-11-22.
- [x] Implementation merged — [PR #480](https://github.com/emrahozcelik/servora-med/pull/480), merged 2026-11-22; no migration or write path in the accepted slice.
- [ ] Exact production release containing OVR-7 verified (**NOT_VERIFIED in this initial review**).
- [ ] Staff self/management report functional acceptance and regression verified.
- [ ] **Closed**.
- **Next:** Check exact-main release and read-only report output; merge alone is not production verification.

---

**Last reviewed:** 2026-11-23. Unchecked gates can already be complete in reality; they remain unchecked until the referenced evidence is inspected. Do not "clear" this register based only on elapsed time.
