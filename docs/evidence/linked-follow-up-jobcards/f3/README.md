# Linked Follow-up JobCards — F3 checkpoint evidence

Status: **F3 focused verification only**. This is not the F4 canonical closeout, not production evidence, and not staging evidence. All browser fixtures are synthetic; no real customer, patient, user, credential, token, or production database was used.

## Handoff identity

- Repository: `emrahozcelik/servora-med`
- Worktree: `/Users/emrah/Documents/Servora-Med-Linked-Follow-Up-F3`
- Branch: `feat/linked-follow-up-jobcards-f3`
- Canonical base: `d9a9e50c5050c426193ea98e7c434c9ad4fd7119`
- Implementation code head: `9935a87532b9074453db65af5cb3024a30185058`
- Evidence is committed immediately after this implementation head; the final PR exact head is recorded in the external-review handoff and PR metadata.
- Database: no local PostgreSQL service and no `TEST_DATABASE_URL`/`DATABASE_URL` were available in this environment. PostgreSQL integration coverage is CI-gated and the local PostgreSQL test file is skipped when the URL is absent.
- Synthetic actors: Admin, Manager, Staff A (source assignee), Staff B (follow-up assignee), Staff C (unrelated), and a cross-organization actor. Synthetic data used one customer, source/follow-up JobCards, open/completed rows, and scheduled calendar events.

## Automated verification

All commands were run from this F3 worktree unless noted.

| Area | Command/result |
| --- | --- |
| Server typecheck | `./node_modules/.bin/tsc -p tsconfig.json --noEmit` — passed |
| Server build | `npm run build` — passed |
| Server dependency audit | `npm audit --audit-level=high` — passed, 0 vulnerabilities |
| Server focused F3/regression tests | Vitest, 8 files / 65 tests — passed |
| Server non-DB suite | Vitest excluding PostgreSQL/web-push integration files — 105 files, 1,345 passed, 7 skipped — passed |
| Server full wrapper | `npm test -- --run` — not run to completion because the repository wrapper requires a database URL unavailable locally; CI is authoritative for the PostgreSQL suite |
| Web build | `npm run build` — passed (Vite, 1,594 modules) |
| Web focused F3 tests | 6 files / 57 tests — passed |
| Web full suite | `npm test -- --run --reporter=dot` — 99 files / 1,180 tests — passed |
| Web bundle check | `npm run bundle:check` — passed (57 JavaScript chunks within the configured limit) |
| Web responsive smoke | `npm run smoke:responsive` — passed (`responsive smoke OK`) |
| Web high-level audit | `npm run audit:high` — `PASS_WITH_WAIVER`; only the documented RSC-only `GHSA-qwww-vcr4-c8h2` waiver remains |
| Lint | No server/web lint script is defined in the repository; not run |

Existing React `act(...)` and CSS parser warnings were non-failing warnings. No test or build result was fabricated.

## Focused synthetic browser verification

The browser pass used Playwright against the F3 worktree Vite dev server on `127.0.0.1:5173`, with route-mocked synthetic HTTP responses. It was intentionally not presented as an authenticated Fastify/PostgreSQL runtime because no local database was available. `EventSource` was made inert for the mock pass so a deliberately closed mock stream could not create artificial reconnect traffic.

- Customer history as management: source and follow-up rows rendered with type, status, assignee, and `Takip`; open/completed/all tabs and pagination surface were exercised.
- Customer history as Staff B: only Staff B’s follow-up row/count was visible; Staff A’s source marker was absent.
- Staff profile as management: Staff A’s history rendered, including the follow-up marker and row navigation.
- Staff self history: Staff B’s own history rendered; Staff A’s identity/row did not appear.
- Calendar FULL fixture: `Takip`, source link, and the exact labels `Planlanan tarih`, `Gerçekleşme tarihi`, `Tamamlanma tarihi` rendered.
- Calendar RESTRICTED fixture: `Takip` and the three date labels rendered; source link was absent.
- Mobile checks: customer, Staff, and restricted Calendar surfaces were checked at 375px/390px-class widths; `scrollWidth` matched the viewport and horizontal overflow was false.
- Fresh current-navigation console check: zero console errors with the inert mock EventSource. Mock stream abort/reconnect noise was excluded from the finding because it was produced by the synthetic closed-stream fixture, not the application runtime.
- Payload/privacy checks: history and Calendar fixtures contained no follow-up instructions, operational note bodies, meeting summaries, source Staff identity, chain/sibling data, or hidden organization totals; restricted source paths were null.

Keyboard/focus and pagination controls were exercised in the existing web test/runtime paths. No credentials or sensitive values were persisted in this document.

## Known limitations

- No local PostgreSQL database was available, so the disposable-schema PostgreSQL history test could not execute locally; exact-head CI must remain the authoritative database gate.
- The browser pass used synthetic route mocks and Vite, not a live authenticated Fastify + PostgreSQL deployment.
- Reassignment and cross-organization database scenarios are covered by server tests/CI contracts but were not claimed as local live-database observations.

## Scope boundary

F3 history/calendar integration is the only implementation scope documented here. F4 evidence and multi-role F4 closeout were not started. No migration, follow-up creation contract redesign, new notification kind, staging action, production action, PR Ready transition, merge, branch cleanup, or worktree cleanup is authorized by this checkpoint.
