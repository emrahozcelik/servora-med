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

- The evidence-only commit does not change any source file, test file, or migration.
- CI: run 30497119343 (SUCCESS) for `c2a0a65`; run 30521023823 (SUCCESS) for `aa951f7`.

### Final gate

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
- Database: PostgreSQL 17, local, database: `servora_med_checkpoint_b_j`
- Server: Fastify on port 3000
- Web: Vite dev server on port 5173
- Actors: Admin, Manager, Staff (synthetic, seeded via db:seed:dev)
- Credentials: supplied through local environment variables (`CHECKPOINT_B_TEST_PASSWORD`, `CHECKPOINT_B_TEST_EMAIL_STAFF`, `CHECKPOINT_B_TEST_EMAIL_ADMIN`). No password, token or secret is stored in this evidence or acceptance harness.

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

### Scenario J1: Real browser dialog acceptance (Playwright Chromium against Vite + Fastify)

**All lifecycle operations performed through actual UI button clicks, dialog inputs, and confirm actions. No page.evaluate() fetch used for lifecycle commands.**

**SUBMIT_FOR_APPROVAL (Staff):**
- Login via real browser form → redirects to `/jobs` — PASS
- Click real `Kontrole gönder` primary button on JobDetail — PASS
- ReasonDialog opens with `role="dialog"` and `aria-modal="true"` — PASS
- Persistent label `Tamamlanma sonucu` visible — PASS
- Helper text `Bu açıklama, yönetici kontrolüne gönderilen iş kaydında saklanır.` — PASS
- Blank submission blocked with `Tamamlanma sonucu zorunludur.` validation — PASS
- `aria-invalid="true"` set on textarea after blank submit — PASS
- Unicode input `Tamamlanma sonucu: 🦷` accepted, code-point counter updates — PASS
- Confirm button click → dialog closes on success — PASS
- Status transitions to `WAITING_APPROVAL` — PASS
- Note visible in JobNotes after page reload — PASS
- 1 SUBMIT_FOR_APPROVAL operational note created, `workflow_stage=IN_PROGRESS` — PASS
- 1 JOB_SUBMITTED_FOR_APPROVAL activity created — PASS

**APPROVE blank (Admin):**
- Click real `Kontrolü tamamla ve işi kapat` primary button — PASS
- ReasonDialog opens, label `Onay notu` — PASS
- Note left blank, confirm through dialog → dialog closes — PASS
- Status = `COMPLETED` — PASS
- No APPROVE operational note created (blank) — PASS
- 1 JOB_APPROVED activity, 0 NOTE_ADDED activities — PASS
- Focus containment verified via `dialog.contains(document.activeElement)` — PASS

**APPROVE nonblank (Admin):**
- Click approve button → dialog opens, label `Onay notu` — PASS
- Enter `Onay notu ✓ ®` → confirm → dialog closes — PASS
- Status = `COMPLETED` — PASS
- Note visible in JobNotes — PASS
- 1 APPROVE operational note, `workflow_stage=WAITING_APPROVAL` — PASS
- `manager_approval_note` matches input (via `workflowContext.lifecycle.approvalNote`) — PASS
- No NOTE_ADDED transition activity — PASS

**REQUEST_REVISION (Admin):**
- Click real `Düzeltme için personele geri gönder` secondary button — PASS
- ReasonDialog opens, label `Düzeltme nedeni` — PASS
- Exactly 1 user-editable textarea, no secondary operational-note field — PASS
- Enter `Browser düzeltme 🦷`, code-point counter present — PASS
- Tab key stays within dialog — PASS
- Confirm → dialog closes — PASS
- Status = `REVISION_REQUESTED` — PASS
- Note visible in JobNotes, label `Revizyon isteği` — PASS
- 1 REQUEST_REVISION operational note, `workflow_stage=WAITING_APPROVAL` — PASS
- `revision_reason` matches note body (via `workflowContext.lifecycle.revisionReason`) — PASS
- 1 JOB_REVISION_REQUESTED activity — PASS
- Focus restored after dialog close — PASS

**CANCEL (Staff):**
- Click real `İşi iptal et` destructive button — PASS
- ReasonDialog opens, label `İptal nedeni` — PASS
- Exactly 1 cancel-reason textarea — PASS
- Destructive confirm button present — PASS
- Enter `Browser iptal 🚫`, Tab stays within dialog — PASS
- Confirm → dialog closes — PASS
- Status = `CANCELLED` — PASS
- Note visible in JobNotes, label `İptal` — PASS
- 1 CANCEL operational note, `workflow_stage=IN_PROGRESS` (pre-cancel snapshot) — PASS
- `cancel_reason` matches (via `workflowContext.lifecycle.cancelReason`) — PASS
- `cancelledFromStatus=IN_PROGRESS` — PASS
- 1 JOB_CANCELLED activity — PASS
- Focus restored after dialog close — PASS

**NOTE_ADDED absence:**
- SUBMIT J1: 0 NOTE_ADDED activities — PASS
- APPROVE blank J2: 0 NOTE_ADDED activities — PASS
- APPROVE nonblank J3: 0 NOTE_ADDED activities — PASS
- REVISION J4: 0 NOTE_ADDED activities — PASS
- CANCEL J5: 0 NOTE_ADDED activities — PASS

### Scenario J2: Real pagination preservation (Playwright Chromium)

**Proves that adding a standalone GENERAL note does not reset an already loaded older JobNotes cursor page, while a lifecycle transition correctly refreshes the notes surface.**

- 27 seeded notes, PAGE_SIZE=25 → initial page shows 25 notes, "Daha eski notları yükle" button visible — PASS
- Click "Daha eski notları yükle" → all 27 notes visible — PASS
- Older note identifiers recorded (26 unique IDs via full note body Set) — PASS
- Add standalone GENERAL note through real JobNotes composer UI (`textarea#job-note` + "Not ekle" button) — PASS
- New GENERAL note appears, note count increases 26→27 — PASS
- All 26 older-page identifiers verified individually — 0 missing (key invariant preserved) — PASS
- Lifecycle transition (SUBMIT_FOR_APPROVAL) performed through real dialog UI — PASS
- Lifecycle transition note appears after manual page reload — PASS
- GENERAL note and lifecycle note coexist — PASS
- Lifecycle refresh resets cursor to latest 25 (by design); seed notes still present via DB — PASS
- No duplicate notes in final display — PASS
- DB: 1 new GENERAL note, 1 lifecycle transition note, stable note IDs — PASS

### Responsive and accessibility

| Viewport | Method | Result |
| --- | --- | --- |
| Desktop 1280×900 | Playwright Chromium real viewport | No horizontal overflow — PASS |
| Mobile 390×844 | Playwright Chromium real viewport | No horizontal overflow — PASS |
| 200% zoom/reflow | NOT EXERCISED (genuine browser zoom not available in harness) | See CI responsive fixture smoke below |
| Labels | `label[for]` association verified — PASS |
| Validation errors | `aria-invalid`, `role="alert"`, `.field-error` — PASS |
| Keyboard focus containment | `dialog.contains(document.activeElement)` assertion — PASS |
| Focus restoration post-transition | Assert focus on `.detail-feedback` or decision panel after trigger replaced — PASS |

### Pending protection

| Category | Method | Result |
| --- | --- | --- |
| Runtime browser pending | Safe request delay injection not practical without altering production behavior | NOT EXERCISED |
| Vitest/jsdom coverage | Automated component tests | PASS |

### Database assertions (direct PostgreSQL)

1. All transition notes have correct workflow_stage (pre-transition snapshot) — PASS
2. Zero NOTE_ADDED activities for transition events — PASS
3. All notes linked to correct activity type — PASS
4. Activity metadata: noteId only, no body — PASS
5. staff_completion_note = operational note body (all MATCH) — PASS
6. manager_approval_note = operational note body (all MATCH) — PASS
7. revision_reason = operational note body (all MATCH) — PASS
8. cancel_reason = operational note body (all MATCH) — PASS

### Evidence classification

| Category | Method | Result |
| --- | --- | --- |
| Runtime API acceptance | Node.js fetch + real PostgreSQL + Fastify | PASS |
| Runtime browser dialog acceptance | Playwright Chromium + real UI dialogs (no fetch for lifecycle) | PASS (79/79 + 2 NOT EXERCISED) |
| Runtime pagination preservation | Playwright Chromium + real JobNotes UI composer | PASS (21/21) |
| Desktop overflow 1280×900 | Playwright Chromium real viewport | PASS |
| Mobile overflow 390×844 | Playwright Chromium real viewport | PASS |
| 200% zoom/reflow | NOT EXERCISED (genuine browser zoom not available) | See CI fixture smoke below |
| Vitest/jsdom component coverage | `npm test -- --run` (web) | PASS (149 tests) |
| Responsive fixture smoke | CI `npm run smoke:responsive` | PASS (CI) |
| Exact-head CI | GitHub Actions | SUCCESS |

## Web Push

- Runtime delivery inspection: NOT EXERCISED — Web Push disabled in test runtime
- Automated privacy coverage: PASS (no Web Push deliveries to inspect)
- `web-push-integrated-normal-path.test.ts`: 1 test PASS

## Known limitations

- 3 pre-existing server test failures (local env, not Checkpoint B)
- Web Push disabled — runtime privacy surface not exercised for push deliveries
- Browser ambiguous-retry fault injection: NOT EXERCISED (cannot safely generate in real browser)
- Automated retry-preservation coverage: PASS (via API-level idempotent replay tests)

## Acceptance test scripts

Located in `web/tests/`:
- `checkpoint-b-dialog-acceptance.playwright.mjs` — Real UI dialog lifecycle flows (79 PASS, 2 NOT EXERCISED)
- `checkpoint-b-pagination-acceptance.playwright.mjs` — Real UI pagination preservation (21 PASS)
