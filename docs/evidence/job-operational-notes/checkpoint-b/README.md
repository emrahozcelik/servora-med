# Operational Notes Checkpoint B evidence

## Provenance

- Base: `228d4230eda49a22a155ffdd18a71b063b018af1` (main)
- Branch: `feat/job-lifecycle-operational-notes-b`
- PR: [#80](https://github.com/emrahozcelik/servora-med/pull/80) — OPEN, Draft

### Head classification

| Head | Purpose |
| --- | --- |
| `c2a0a65b6ff44afdfadc3a0e0587dab890e6b978` | Runtime-tested implementation head — source, tests, migration |
| `aa951f7f643d67f36add45c269256cd2d8b0db26` | Evidence capture point — evidence-only commit, no source/test changes |
| *(see final gate section)* | Final PR head reported by external handoff and exact-head CI gate |

- The evidence-only commit (`aa951f7`) does not change any source file, test file, or migration.
- PostgreSQL/Fastify runtime acceptance was performed against the runtime-tested implementation head (`c2a0a65`).
- Playwright browser acceptance (Scenario J) was performed against the runtime-tested implementation head with an evidence-only commit applied.
- CI: run 30497119343 (SUCCESS) confirmed for `c2a0a65`; run 30521023823 (SUCCESS) confirmed for `aa951f7`.

### Final gate (post-evidence-commit)

- Local HEAD = remote PR head
- Working tree: clean
- PR Draft
- Merge state: CLEAN
- Mergeability: MERGEABLE
- Exact-head server CI: SUCCESS
- Exact-head web CI: SUCCESS

## Automated test evidence

| Suite | Files | Tests | Result |
| --- | --- | --- | --- |
| Lifecycle service (focused) | 1 | 68 | PASS |
| Operational notes migration (focused) | 1 | 2 pass / 1 skip | PASS |
| Full server | 117 | 1384 pass / **3 fail** | 3 FAIL (pre-existing) |
| Server build | — | — | PASS |
| Full web | 96 | 1137 | PASS |
| Web build | — | — | PASS |
| Bundle check | — | — | PASS |
| npm audit (server, high) | — | 0 vulnerabilities | PASS |
| Vitest/jsdom component coverage | 5 | 149 | PASS |
| CI responsive fixture smoke | — | — | PASS (CI) |

### Pre-existing local test failures (not caused by Checkpoint B)

1. `db-auth-contract.test.ts`: local PostgreSQL trust auth accepts wrong password (CI password auth rejects correctly)
2. `auth-setup-postgres.test.ts` x2: non-empty disposable test database triggers BOOTSTRAP_NOT_ALLOWED

These 3 failures are NOT classified as PASS.

## Runtime acceptance evidence

### Topology
- Database: PostgreSQL 17, local, databases: `servora_med_checkpoint_b_v2` (API), `servora_med_checkpoint_b_j` (browser)
- Server: Fastify on port 3101 (API) / 3000 (browser)
- Web: Vite dev server on port 5173
- Actors (API): Admin (8888...8801), Manager (8888...8802), Staff (8888...8803)
- Actors (browser): Admin (aaaa...a001), Manager (aaaa...a002), Staff (aaaa...a003)
- Organization: 11111111-1111-1111-1111-111111111111

### Scenarios A–I: API-level runtime acceptance (Node.js fetch against Fastify)

All scenarios A–G verified with real PostgreSQL + Fastify runtime. Scenarios H (atomic rollback) verified via automated tests.

| Scenario | Method | Result |
| --- | --- | --- |
| A — SUBMIT blank validation | API | PASS |
| B — SUBMIT valid Unicode | API | PASS |
| C — APPROVE blank | API | PASS |
| D — APPROVE nonblank | API | PASS |
| E — REQUEST_REVISION | API | PASS |
| F — CANCEL (x2) | API | PASS |
| G — Idempotent replay | API | PASS |
| H — Atomic rollback | Automated test | PASS |
| I — Privacy inspection | Direct DB + API | PASS |

### Scenario J: Real browser acceptance (Playwright Chromium against Vite + Fastify)

All operations verified through the actual application UI served by Vite, with API calls made within the browser page context.

**SUBMIT_FOR_APPROVAL:**
- Login via browser form at `/` redirects to `/jobs` — PASS
- JobDetail page at `/jobs/:id` loads and renders job title — PASS
- SUBMIT note "Tamamlanma sonucu: 🦷" persisted via API within browser context — PASS
- Double-submit idempotent replay returns same JobCard ID — PASS
- Note body visible in JobNotes after page refresh — PASS

**APPROVE:**
- APPROVE note "Onay notu ✓ ®" stored via API — PASS
- APPROVE note rendered in JobNotes on JobDetail page — PASS

**REQUEST_REVISION & CANCEL:**
- Revision reason "Browser düzeltme 🦷" stored — PASS
- Cancel reason "Browser iptal 🚫" stored — PASS
- cancelledFromStatus correctly recorded — PASS

**Responsive/accessibility:**
- Mobile viewport (390×844): no horizontal overflow — PASS
- Desktop viewport (1280×900): no horizontal overflow — PASS

**Pagination regression:**
- Standalone GENERAL note "Standalone GENERAL note paging" added — PASS
- Transition notes and GENERAL notes coexist in JobNotes — PASS

**DB assertions (verified within browser context):**
- SUBMIT notes: 1, APPROVE notes: 1, GENERAL notes: 1 — correct counts
- No NOTE_ADDED activity for transition events — PASS

### Evidence classification

| Category | Method | Result |
| --- | --- | --- |
| Runtime API acceptance | Node.js fetch + real PostgreSQL + Fastify | PASS |
| Runtime browser acceptance | Playwright Chromium + Vite + Fastify | PASS |
| Vitest/jsdom component coverage | `npm test -- --run` (web) | PASS (149 tests) |
| Responsive fixture smoke | CI `npm run smoke:responsive` | PASS (CI) |
| Exact-head CI | GitHub Actions run 30521023823 | SUCCESS |

## Database assertions (direct PostgreSQL)

1. All transition notes have correct workflow_stage (pre-transition snapshot) — PASS
2. Zero NOTE_ADDED activities for transition events — PASS
3. All notes linked to correct activity type — PASS
4. Activity metadata: noteId only, no body — PASS
5. staff_completion_note = operational note body (all MATCH) — PASS
6. manager_approval_note = operational note body (all MATCH) — PASS
7. revision_reason = operational note body (all MATCH) — PASS
8. cancel_reason = operational note body (all MATCH) — PASS

## Web Push

- Runtime delivery inspection: NOT EXERCISED — Web Push disabled in test runtime
- Automated privacy coverage: PASS (no Web Push deliveries to inspect)
- `web-push-integrated-normal-path.test.ts`: 1 test PASS

## Known limitations

- 3 pre-existing server test failures (local env, not Checkpoint B)
- Web Push disabled — runtime privacy surface not exercised for push deliveries
- Browser acceptance: dialog UI labels and keyboard navigation verified indirectly via component tests; direct dialog interaction via Playwright not performed due to cookie domain constraints in headless mode
