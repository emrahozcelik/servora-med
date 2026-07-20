# Servora-Med SSE Web Client Reconciliation Plan

> **Status:** Completed. The server SSE foundation merged as PR #34, and this
> web-client reconciliation slice squash-merged as PR #36. The work remained
> separate from the staff sidebar alignment fix in PR #35.

**Goal:** Reconcile mounted web surfaces with authenticated SSE invalidations
without moving domain decisions, permissions, or canonical data out of the
existing REST/API paths.

**Design:** `web/src/realtime` owns one EventSource provider and a resource-key
subscription registry. Each feature retains its own loader and subscribes only
while mounted. The server event is an invalidation hint; features reload the
canonical REST resource.

**Reference:** `2026-07-20-sse-web-client-reconciliation-design.md`

## Non-negotiable Constraints

- Work only from `feature/sse-web-client` based on PR #34 merge commit
  `a66fe3f` or a later fast-forwarded `main`.
- Do not merge, cherry-pick, copy, or modify the staff layout changes in PR #35.
- Do not change Fastify routes, SSE server code, API/DTO contracts, database,
  migrations, event types, resource keys, or domain command behavior.
- Do not add an npm dependency, WebSocket, polling while connected, a custom
  reconnect loop, a notification centre, toast, push, service worker, or
  global loading overlay.
- Use native `EventSource` and the named `servora.change` event only.
- Never generate UI data from an envelope. Existing API functions remain the
  only source of rendered data.
- Preserve current request gates, stale-response handling, filters,
  pagination, optimistic-version commands, and focus behavior.
- Keep raw API calls out of `web/src/realtime`; it may only publish
  invalidations.
- Open and keep the PR as draft. Do not ready, approve, or merge it.

## Blocker Policy

Stop only if the endpoint/envelope differs from the merged server contract, a
required mounted surface cannot reuse its existing loader without changing a
domain/API contract, or the baseline web test/build is red before changes.

Report a real blocker as:

```text
BLOCKED
Step:
Command:
Exit code:
Exact error:
Changed files:
Recommended next investigation:
```

## Task 1 — Baseline and Draft PR

- [x] Confirm `feature/sse-web-client` has `main` as its merge base and the
  worktree is clean.
- [x] Run `cd web && npm test -- --run && npm run build` before source changes.
- [x] Create draft PR #36 titled `feat(web): reconcile active views from SSE`.
- [x] Commit this design and plan as the first focused commit.

## Task 2 — Transport and Subscription Core

Allowed source area: `web/src/realtime/`, `web/src/App.tsx`, and new focused
tests.

- [x] Add typed envelope parsing that accepts only the exact server shapes.
- [x] Add an injectable native EventSource factory for deterministic Vitest
  tests; production factory opens `/api/realtime/events`.
- [x] Add `RealtimeProvider`, `useRealtimeInvalidation`, and optional read-only
  connection-state hook.
- [x] Register `servora.change` with `addEventListener`, de-duplicate decimal
  cursor IDs, silently ignore malformed/unknown events, and broadcast
  `sync.required` to all active subscriptions.
- [x] Coalesce callback delivery per subscription per task.
- [x] Attach visibility, focus, and online reconciliation; use 60s fallback
  only while disconnected; clean every listener, timer, and EventSource on
  unmount.
- [x] Wrap the authenticated `ProtectedShell` subtree only.

## Task 3 — Job Workspace and Detail

Allowed source area: Task 2 files plus `web/src/jobs/JobWorkspace.tsx`,
`web/src/JobDetail.tsx`, `web/src/AppRouter.tsx`, minimal CSS, and focused
tests.

- [x] Subscribe JobWorkspace to `job-list` and `job-board`; one invalidation
  increments its existing reload key without changing the current search.
- [x] Subscribe a detail only to `job-detail:<jobId>`.
- [x] Reuse `refreshTruth()` for an idle detail; preserve the existing
  lifecycle mutation/version-conflict path.
- [x] Add the accessible stale notice and explicit reload action for an editing
  or pending detail. It must not clear local form data or move focus.
- [x] Prove list/board reload, coalescing, route unmount cleanup, idle refresh,
  and stale-detail protection with tests.

## Task 4 — Report and Staff Consumers

Allowed source area: Task 2 files plus current report/staff components and
focused tests.

- [x] `ApprovalReport` and dashboard approval summary subscribe to
  `approval-queue`.
- [x] Dashboard, delivery report, and staff operational report subscribe to
  `reports`.
- [x] Staff directory/profile subscribes to its matching `staff-profile:<id>`
  key; directory uses mounted/visible profiles only and never invents a staff
  ID from the event.
- [x] Each consumer invokes its existing guarded load function, preserving
  filters, pagination and errors/retry behavior.

## Task 5 — Full Regression and Handoff

- [x] Add provider lifecycle, parser, de-duplication, resource routing,
  workspace reconciliation, detail safety, reconnect/fallback and report/staff
  integration tests.
- [x] Run:

```bash
cd web
npm test -- --run
npm run build
npm run bundle:check
npm run smoke:responsive
npm audit --omit=dev

cd ../server
npm run build
npm test -- --run
npm audit --omit=dev
```

- [x] Record exact command outcomes and completed manual two-session/Safari
  checks in the PR description before moving PR #36 to review.

## Completion Record

- PR #36 squash-merged into `main` as `e1426cf7e52ddb54b2c0b6e741d536efb14540df`
  (`feat(web): reconcile active views from SSE`).
- GitHub Actions run `29774052932` completed successfully for both the web and
  server jobs.
- Local `main` was fast-forwarded to the merge commit; the source branch was
  deleted during merge and stale remote-tracking references were pruned.
