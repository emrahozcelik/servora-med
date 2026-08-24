# R3B JobCard Invalidation Admin UI Acceptance

Runtime gate: `R3B_JOBCARD_INVALIDATION_ADMIN_UI_REAL_RUNTIME_ACCEPTANCE`

## Result

`PASS` — 45/45 assertions passed on real PostgreSQL, Fastify, Vite, and Playwright Chromium.

Evidence: [runtime-results.json](./runtime-results.json)

## Acceptance matrix

| Area | Result | Evidence |
| --- | --- | --- |
| Admin-only destructive action | PASS | Admin action rendered; Manager/Staff received 403 from the real route. |
| Inline reason capture | PASS | Reason form is disclosure-based; no nested dialog. |
| Single confirmation and focus | PASS | Exactly one `role=dialog`; initial focus and restoration verified. |
| Pending mutation lock | PASS | Confirmation controls disabled; JobCard-local mutation surfaces locked; navigation remains available. |
| Strict mutation response validation | PASS | ID, status, version, reason, timestamps/actors, and source-status facts validated after generic parsing. |
| Ambiguous-result recovery | PASS | Aborted response produced one POST, then the first CTA was GET status recheck; no automatic POST retry. |
| Already-invalidated semantics | PASS | Canonical `INVALIDATED` state showed normal history and did not claim the current attempt as success. |
| Invalidated list capability | PASS | Explicit `status=INVALIDATED` forced list mode while `Tümü` remained separate. |
| User-facing reason labels | PASS | Turkish labels rendered; raw reason enums were not exposed. |
| Responsive/accessibility flow | PASS | 390px and 200–400% reflow checks passed without horizontal overflow or page errors. |
| Database persistence | PASS | Status, reason, one activity, one note, no follow-up cascade, and one idempotency receipt verified. |
| Messaging continuity | PASS | Existing conversation history remained readable after invalidation; new message mutation returned 403. |

## Repository verification

- PostgreSQL migrations 001–036: passed on disposable real PostgreSQL.
- Server full suite: 2,270 passed, 4 skipped across 201 files.
- Web full suite: 1,798 passed across 141 files.
- Server and web builds: passed.
- Web bundle budget: passed.
- Responsive smoke and calendar responsive smoke: passed.
- Server dependency audit: 0 vulnerabilities.
- Web dependency audit: the repository’s existing RSC-only `GHSA-qwww-vcr4-c8h2` waiver was accepted by `audit:high`; no new dependency was added by R3B.
- `npm run lint`: N/A; no repository script exists.
