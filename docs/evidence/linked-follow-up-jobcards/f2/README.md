# Linked Follow-up JobCards — F2 GPT-5.6 Sol Review Handoff

**Review target:** `feat/linked-follow-up-jobcards-f2`
**Head:** `14cfd0262a3fa14506bdd0b504b9adc33c9863aa`
**Base:** `origin/main` / F1 merge `f43e876`
**Review date:** 2026-08-01 (Europe/Istanbul)
**Scope:** F1 server contract + F2 creation/continuity UI. This is an F2 handoff; F3 history/calendar integration and F4 closeout are not claimed here.

## Review request

GPT-5.6 Sol should perform an independent implementation review against the linked-follow-up design and plan, then return one of:

- `PASS` — implementation and contract are safe for the next gate;
- `REVISE REQUIRED` — list each blocker with file/line, violated contract, and the smallest required repair.

Do not treat this handoff as approval for merge, staging, or production deployment.

## Contract anchors

- Design: [`2026-07-31-linked-follow-up-jobcards-design.md`](../../../superpowers/specs/2026-07-31-linked-follow-up-jobcards-design.md)
- Plan: [`2026-07-31-linked-follow-up-jobcards.md`](../../../superpowers/plans/2026-07-31-linked-follow-up-jobcards.md)
- Repository operating contract: [`AGENTS.md`](../../../../AGENTS.md)

The implementation is intentionally limited to linked follow-up JobCards. It must preserve the existing JobCard state machine, manager approval, staff reach policy, idempotency, bodyless notifications, and audit history.

## Implementation history

| Commit | Area | Summary |
|---|---|---|
| `7a08c15` | F1/server | Migration `022`, follow-up persistence, policy, service, routes, DTOs, realtime keys, server tests |
| `c2ed503` | F2/web | Follow-up creation route/form, parser and form tests |
| `e09f420` | F2/web | JobDetail continuity panel, source context, chain presentation, responsive styles/tests |
| `94215c9` | docs | Recorded F2 verification status |
| `14cfd02` | F2/web | Hardened UI loading/error state and follow-up pagination |

No dependency, package, migration rewrite, or unrelated domain refactor was introduced.

## External-review blocker closure provenance

The three blockers in the previous review are already implemented in the exact local head `14cfd02` (the review snapshot at `94215c9` predates this commit):

| Previous blocker | Closure in `14cfd02` | Regression evidence |
|---|---|---|
| Source-switch state isolation | Router keys `FollowUpCreatePage` by `sourceId`; the page also resets form/error/attempt state and ignores stale async completion | `web/tests/follow-up-create.test.tsx` — source A → source B reset |
| Invalid successful response / idempotency | `status === 0`, retryable errors, and `ACTION_IN_PROGRESS` preserve the existing action ID until the payload changes or the mutation succeeds | `web/tests/follow-up-create.test.tsx` — `INVALID_RESPONSE` replay uses `action-1` twice |
| Children pagination | Children state consumes `total/limit/offset`, exposes `Daha fazla göster`, and appends the next page | `web/tests/follow-up-continuity.test.tsx` — 100 + 1 child pages |

This is why no duplicate behavioral patch is added on top of `14cfd02`; the remaining documentation change moves this handoff into the F2 evidence path so F4 is not implied.

## Environment correction from the lost session

The parent documentation repository and the implementation worktree are different paths:

- README reference: `/Users/emrah/Documents/Servora-Med/README.md`
- Implementation worktree: `/Users/emrah/Documents/Servora-Med-Linked-Follow-Up-F2`
- Fastify: `127.0.0.1:3000`, started from the F2 worktree's `server/` build
- Vite: `127.0.0.1:5173`, started from the F2 worktree's `web/`
- PostgreSQL: `127.0.0.1:5432`
- Correct synthetic F2 database: `servora_med_f2_test`

The parent `servora_med` database is not the F2 acceptance database. It has an older migration state and different data. The F2 database has migration `022_job_card_follow_up_links` applied and contains only synthetic users/customers/JobCards.

The first browser attempt was read-only because the MCP safety gate rejected a persistent submit click without explicit user approval. After explicit approval, Chrome DevTools MCP completed the real mutation successfully. This was a tool safety state, not a missing Playwright, Chrome, or MCP installation.

## Focused browser acceptance evidence

Runtime was started with the correct F2 database. The following checks were executed through Chrome DevTools MCP and Playwright MCP.

| Scenario | Expected contract | Observed result |
|---|---|---|
| Management creates follow-up from completed `SALES_MEETING` | Form inherits source customer; required instructions; assignee selectable | Chrome DevTools filled and clicked `Takip işini oluştur`; redirected to child detail |
| Created child | `NEW`, linked to immutable source, inherited customer, assigned staff | Child `1a8835d2-a997-47e3-b208-ae3b2606b47c`, title `F2 onaylı tarayıcı takip işi`, assigned to `Synthetic Staff B` |
| Management source detail | Recommendation/action and management-only children panel | Source detail showed the new child and `3 / 3 takip işi gösteriliyor` |
| Staff B child detail | Immediate source summary only; restricted mode has no source path | HTTP `200`; `followUpContext.sourceAccess=RESTRICTED`; `sourceJobPath=null`; no source link in the accessibility snapshot |
| Public detail DTO privacy | No raw top-level `sourceJobCardId` or `followUpInstructions` | Both top-level fields absent; values appear only in nested follow-up context where authorized |
| Staff B source children endpoint | Staff must not enumerate siblings/children | HTTP `403`, code `FORBIDDEN` |
| Unrelated Staff C opening the new child | Staff scope must be enforced | HTTP `404` |
| Customerless completed source form | Only `GENERAL_TASK` is allowed | `PRODUCT_DELIVERY` and `SALES_MEETING` disabled with the expected customerless-source explanation |
| Mobile child detail | No page-level horizontal overflow at 375px | `scrollWidth=360`, `clientWidth=360`, overflow `false` |
| Fresh browser load | No runtime console errors on touched page | Playwright fresh navigation: 0 error messages; relevant API requests returned `200` |

The created row remains in the disposable `servora_med_f2_test` database as an acceptance receipt. It is not production data.

## Review focus / likely failure surfaces

Please inspect these areas against the design/plan rather than assuming the focused walkthrough proves the full contract:

1. Migration `022` two-way source/instructions CHECKs, length/whitespace validation, self-link protection, FK behavior, and migration-runner expectations.
2. `createFollowUp` transaction ordering: idempotency claim, source eligibility, chain-depth limit, inherited customer/contact, receipt-only replay, commit-before-publish, and current-actor re-presentation.
3. Exact error codes/statuses for staff creation, source reachability, assignee, customer/contact, type matrix, and depth overflow.
4. Public `JobCardDetail` DTO privacy: root `followUpContext: null`; follow-up fields nested only; no top-level raw source fields; no restricted source path.
5. Management-only `GET /api/job-cards/:id/follow-ups` and children panel; no sibling/ancestor leakage for staff.
6. Access lifetime after reassignment, cancellation, inactive users, and replay under changed authorization.
7. Conditional realtime resource keys, especially no `customer-detail:null` for customerless follow-ups.
8. Follow-up form loading/error/duplicate-submit behavior, customerless type disabling, pagination, and source-chain presentation at mobile widths.
9. Existing state-machine, manager-approval, activity-log, notification privacy, and report regressions.
10. Test/build evidence and whether the implementation is ready to proceed to F3/F4.

## Verification boundary

This handoff records a focused real-runtime browser acceptance, not a full F4 closeout. The following remain to be run or independently confirmed by the review/next gate:

- `cd server && npm run build`
- `cd server && npm test -- --run`
- `cd server && npm run lint`
- `cd web && npm run build`
- `cd web && npm run lint`
- full F4 two-staff + manager walkthrough, idempotency replay/concurrency, reassignment/inactive-user sweep, calendar parity, log-redaction proof, and committed screenshot/payload evidence.

Fastify and Vite were stopped after acceptance; PostgreSQL was left running for the local environment. The worktree was clean after verification.

## Reviewer response format

Please return:

```text
Verdict: PASS | REVISE REQUIRED

Blockers:
- [severity] file:line — contract/evidence — required repair

Non-blocking notes:
- ...

Next gate:
- F3/F4, or specific repair commit(s)
```
