# CI-PERF-001 — CI Performance & Test Architecture Optimization

Status: PROPOSED / research and measurement only
Date: 2026-11-27
Product: OPNEX (repository: servora-med)
Inspection baseline: `32e5449b8f7117428dfb11049b54d0022fad1414`

## 1. Objective and boundaries

Reduce PR feedback time toward 10–15 minutes without reducing regression,
security, database, migration, browser or operational assurance. Establish
a repeatable baseline and identify safe parallelization before implementing
changes. This document is a backlog research brief, not an approved runtime
contract or authorization to change required checks, merge, or deploy.

No test deletion, skip-list expansion, timeout relaxation, coverage reduction,
workflow change, fixture change, dependency update or production operation
belongs in this PR. Implementation requires separate reviewed PRs with CI enabled.

## 2. Historical evidence

Measurements transcribed from the 27 November CI duration analysis session.
Run identities and successful server/web/benchmark jobs were rechecked via
GitHub; release-package was skipped on both PR runs. Detailed timings and
counts below are session observations, to be reproduced from raw logs in the
research phase rather than represented as a new benchmark.

| Metric | 18 Nov, PR #445 | 27 Nov, PR #532 | Change |
| --- | ---: | ---: | ---: |
| Server passed tests | 4,396 | 5,338 | +21.4% |
| Web passed tests | 2,817 | 3,662 | +30.0% |
| Total passed tests | 7,213 | 9,000 | +24.8% |
| Test files (server + web) | 601 | 720 | +19.8% |
| Server test step | 23m 06s | 32m 44s | +41.7% |
| Web test step | 2m 04s | 2m 42s | +30.6% |

Sources: [18 Nov run](https://github.com/emrahozcelik/servora-med/actions/runs/44302716511),
[27 Nov run](https://github.com/emrahozcelik/servora-med/actions/runs/46054141842).
Eight server tests were reported skipped in each run; OPS and browser
acceptance are outside these counts. Verify pass/skip/total semantics from
Vitest output before using them as coverage parity gates.

Latest reported server job: 34m 47s, including 32m 44s in Vitest and
2m 03s outside it (~94% test step). Playwright installation reportedly
improved from ~22.5m to ~37s; retain existing mirror/retry safeguards.
Job time is not necessarily workflow elapsed time: queue and runner startup
must be measured separately. Main release packaging is not represented by
these PR runs.

Reported slow server PostgreSQL suites:

| Suite (descriptive name; resolve exact paths) | Tests | Seconds |
| --- | ---: | ---: |
| Sales S3 isolated PostgreSQL | 64 | 83.2 |
| Weekly report atomic draft | 60 | 75.9 |
| Job lateness events | 54 | 67.2 |
| Follow-up proposals | 46 | 58.9 |
| Staff offboarding | 46 | 57.2 |
| Weekly report ownership | 38 | 46.3 |
| Bulk weekly report request | 36 | 38.8 |
| CRM duplicate command and deadline | 6 | 37.3 |

## 3. Current architecture

At the inspection baseline, [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
defines benchmark-smoke, server, web, and release-package. The first three
can run in parallel; release-package requires all three and runs on main push.
Server combines infrastructure/OPS contracts, migration and schema checks,
application tests and security audit. The exact-SHA main CI receipt and
release-package must remain intact.

[server/vitest.config.ts](../../server/vitest.config.ts) explicitly sets
`fileParallelism: false` and includes tests/**/*.test.ts. The analysis reported
445 server files; establish actual discovery count at the benchmark SHA.
Do not simply enable file parallelism: identify why it was disabled and
audit shared DB, filesystem, environment, process, port, clock and other state.
The weekly-report atomic-draft PostgreSQL suite was reported to create
schemas, apply migrations, seed fixtures and drop schemas; quantify setup
frequency and cost before changing that lifecycle.

PR [#481](https://github.com/emrahozcelik/servora-med/pull/481) is open and
unmerged at inspection. It already proposes same-PR supersession cancellation
while preserving unique main/dispatch concurrency groups, with deployment
contract test and documentation. Do not duplicate its changes here;
reassess its current head, applicability and merge readiness separately.
Current inspected main has no CI concurrency block.

## 4. Research deliverables (first engineering phase)

* Pin current main and test dependency versions; record exact SHA, runner OS,
  CPU/memory, PostgreSQL version, workflow event, run/attempt/job IDs and cache
  state. Collect at least three comparable successful runs per configuration
  when feasible; distinguish cold/warm caches, queue, step wall time, total
  runner minutes, failures/retries and main release packaging.
* Inventory all test files and cases by unit, integration, PostgreSQL,
  migration, OPS and browser acceptance; record setup/teardown/migration time,
  slowest files, skip reasons, shared-resource dependencies and unique
  requirements/regression IDs. Mixed files must be classified conservatively.
* Locate history/rationale for disabled file parallelism. Map fixed schemas,
  database names, roles, locks, fixtures, shared state, external binaries and
  process/global dependencies. Verify Vitest version and supported sharding
  options; do not assume upstream defaults.
* Compare existing CI, local CI and deployment receipt consumers, including
  required check names, release-package dependencies, evidence validation,
  artifact names and branch rules. Identify which consumers require atomic
  updates; preserve fail-closed behavior.
* Produce a reproducible benchmark command set, anonymized evidence table,
  proposed shard manifest and implementation PR sequence. No production data,
  credentials or secrets in artifacts. Mark absent evidence as UNKNOWN.

## 5. Proposed implementation sequence (separate PRs)

| Priority | Work | Required evidence |
| --- | --- | --- |
| P0 | Experiment with 1/2/4 independently provisioned runner shards | Same discovered test identities and skip reasons; no overlap/omission; each shard isolated with its own PostgreSQL; serial execution within each shard initially; failures propagate |
| P1 | Optimize database setup and fixture lifecycle | Measured migration/setup costs; compare clean migrated template or safe fixture reuse; no cross-test leakage; migration chain still exercised independently |
| P1 | Separate unit/integration/PostgreSQL/migration/OPS/browser workloads | Complete coverage mapping; preserve existing checks or coordinated verified receipt compatibility; no scope reduction |
| P2 | Audit duplicate tests and obsolete contracts | Map each candidate to unique guarantees and requirements; owner approval before deletion; preserve independent regression, security and acceptance protection |
| P2 | CI timing reports and cancellation | Per-run timing/counts/slow files, trend and queue vs execution; coordinate #481 rather than recreate it |

For sharding, prefer separate hosted jobs with fresh PostgreSQL 17 service
instances and independent runner state. Preserve all tools and env required
by DB tests (including PostgreSQL client and age where needed). A deterministic
file-level partition must run every baseline test exactly once across shards;
compare stable full test identities, outcomes and skip reasons, not totals
alone. Investigate skew and memory/connection limits. Keep a stable required
server gate that cannot report success if a shard is failed, cancelled,
missing or unexpectedly skipped; validate exact-SHA deployment receipt and
release dependencies before adopting any workflow change. Do not use main
or production as an experimental test environment. Maintain local CI parity
or document and test an explicitly approved equivalent.

## 6. Performance hypothesis and acceptance

Ideal arithmetic: 32m44s / 4 + 2m03s = 10m14s server elapsed, versus
34m47s (~71% shorter). This is not measured and assumes perfectly balanced
shards and fixed overhead; real queue, duplicated setup and slowest shard
may dominate. Four runners can increase total billed minutes. Initial target
is 10–15m PR feedback, not a guaranteed SLA. Report median and range from
matched trials and total runner-minute cost alongside wall time; avoid
claiming improvement from a single favorable run.

Implementation acceptance gates:

- [ ] Reproduce baseline at pinned SHA with raw job/step evidence and inventory.
- [ ] Demonstrate complete file/case identity parity, unchanged expected skips
      and no silent omissions; include deliberate missing/failing shard checks.
- [ ] Demonstrate isolated DB/fixture state across shards and repeat runs;
      investigate flakes rather than masking them with retries.
- [ ] Preserve OPS, migration/schema, browser, security audit, KDF smoke and
      exact-main release-package requirements, including fail-closed admission.
- [ ] Compare repeated 1/2/4-runner experiments, queue time, elapsed time,
      aggregate runner minutes and runner quota effects; select configuration
      only after review.
- [ ] Document rollback to serial execution and independently validate full
      CI on implementation PRs. No automatic merge/deploy.

## 7. Handoff

Research agent: inspect actual current code and history, reproduce the
historical observations, enumerate all tests and classify isolation risks,
measure setup vs execution, and return an evidence-backed plan with exact
SHA, paths, commands, results, blockers, and prioritized follow-up PRs.
Flag contract or branch-protection access gaps explicitly. Do not implement,
delete tests, change CI or approve deployment in this research stage.
