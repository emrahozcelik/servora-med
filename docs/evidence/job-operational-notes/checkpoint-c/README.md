# Operational Notes Checkpoint C evidence

## Provenance

- Base: `327f460f59718b7afcb77f0a8c8c581503d3a501` (main)
- Branch: `feat/job-operational-notes-realtime-c`
- PR: [#81](https://github.com/emrahozcelik/servora-med/pull/81) — OPEN, Draft

### Head classification

| Head | Purpose |
| --- | --- |
| `f1b0137c0f393d82d699ad197ee525368dc1a389` | Implementation head — source, tests, migration |
| `8673d251caa5b61c5d297f6b6805906277ba44cd` | Evidence commit — canonical evidence relocation + two-browser visual results (docs-only) |
| `2289a35ded20651826285d38faec0aa9920353ea` | Reviewer-fix commit — `notifications` resource key made unconditional for standalone-note events (code + test) |
| `9ea2acb0fd7b150d4e4723d996fa5310853cdae4` | Docs update — fix verification + true-390px mobile results + head reclassification (docs-only; then the local head became `9ea2acb`) |

- CI: run 30577288701 (SUCCESS) for `f1b0137` (exact-head). Commits after `f1b0137` (fix + docs) get CI verification after the final push (see Final gate).

### Final gate

- Local HEAD = `9ea2acb0fd7b150d4e4723d996fa5310853cdae4` (implementation `f1b0137` + evidence `8673d25` + reviewer fix `2289a35` + docs `9ea2acb`)
- Remote PR head = `f1b0137` until the final push (documented; push happens after review PASS)
- Evidence commits (`8673d25`, `9ea2acb`) are docs-only; the reviewer fix touches only `note-realtime-projection.ts` and its test
- PR Draft
- Merge state: CLEAN
- Mergeability: MERGEABLE

## Automated test evidence

| Suite | Files | Tests | Result |
| --- | --- | --- | --- |
| Note realtime projection (focused) | 1 | 7 | PASS |
| Notification policy (focused) | 1 | 17 | PASS |
| Notification delivery projection (focused) | 1 | 0 pass / 14 skip | SKIP (pre-existing) |
| Migration runner (focused) | 1 | 5 | PASS |
| Web Push integrated (focused) | 1 | 0 pass / 1 skip | SKIP (pre-existing) |
| Job card service (focused) | 1 | 21 | PASS |
| Job card notes (focused) | 1 | 36 pass / 1 skip | PASS |
| Realtime job card integration (focused) | 1 | 0 pass / 7 skip | SKIP (pre-existing) |
| Focused aggregate | 8 | **86 pass / 23 skip / 0 fail** | PASS |
| Full server | 118 | 1402 pass / **3 fail** | 3 FAIL (pre-existing) |
| Server build | — | — | PASS |
| Web test (job-notes) | 1 | 33 | PASS |
| Web test (notification-center) | 1 | 12 | PASS |
| Full web | 96 | 1141 | PASS |
| Web build | — | — | PASS |

Focused counts above were re-run after the reviewer-fix commit `2289a35` (10:13 local).

### Pre-existing local test failures (not caused by Checkpoint C)

1. `db-auth-contract.test.ts`: local PostgreSQL trust auth accepts wrong password (CI password auth rejects correctly)
2. `auth-setup-postgres.test.ts` x2: non-empty disposable test database triggers BOOTSTRAP_NOT_ALLOWED

These 3 failures are NOT classified as PASS.

## Runtime acceptance evidence

### Topology
- Database: PostgreSQL 17, local, database: `servora_med_checkpoint_c`
- Server: Fastify on port 3000
- Web: Vite dev server on port 5173
- Actors: Demo Admin, Demo Manager, Demo Staff (synthetic, seeded via `db:seed:dev`)
- `WEB_PUSH_ENABLED=true`, 3 active Web Push subscriptions (Admin, Manager, Staff)
- Password: supplied through local environment variable at seed time

### Scenario C-A: Manager adds standalone note

| Assertion | Method | Result |
| --- | --- | --- |
| Notes count: 1 | DB query | PASS |
| NOTE_ADDED activities: 1 | DB query | PASS |
| Realtime events: 1 | DB query | PASS |
| Resource keys: `job-notes:<id>`, `notifications`, `staff-profile:<id>` | DB query | PASS |
| Audience roles: ADMIN, MANAGER | DB query | PASS |
| Audience user IDs: [assignee] (Staff) | DB query | PASS |
| In-app notifications: 2 (Admin, Staff) | DB query | PASS |
| Manager excluded (actor) | DB query | PASS |
| Web Push deliveries: 0 | DB query | PASS |

### Scenario C-B: Staff adds standalone note

| Assertion | Method | Result |
| --- | --- | --- |
| Notes count: 2 (cumulative) | DB query | PASS |
| NOTE_ADDED activities: 2 (cumulative) | DB query | PASS |
| In-app notifications: Admin + Manager (Staff excluded) | DB query | PASS |
| Web Push deliveries: 0 | DB query | PASS |

### Scenario C-C: Replay (idempotency)

| Assertion | Method | Result |
| --- | --- | --- |
| Same result returned (id, createdAt) | API response | PASS |
| Notes count unchanged: 2 | DB query | PASS |
| NOTE_ADDED activities unchanged: 2 | DB query | PASS |
| In-app notifications unchanged: 4 | DB query | PASS |

### Scenario C-D: Inactive assignee

| Assertion | Method | Result |
| --- | --- | --- |
| Inactive user excluded from audience_user_ids | DB query (empty `{}`) | PASS |
| Inactive user receives 0 notifications | DB query | PASS |
| Resource keys include `staff-profile:<inactive_id>` | DB query | PASS |
| Web Push deliveries: 0 | DB query | PASS |

### Scenario C-F: Transition regression (SUBMIT_FOR_APPROVAL)

| Assertion | Method | Result |
| --- | --- | --- |
| NOTE_ADDED activities unchanged: 2 (standalone only) | DB query | PASS |
| JOB_SUBMITTED_FOR_APPROVAL activity created: 1 | DB query | PASS |
| Transition note context: `SUBMIT_FOR_APPROVAL` | DB query | PASS |
| `job.awaiting_approval` notifications: 2 (Admin, Manager) | DB query | PASS |
| Web Push for `job.awaiting_approval`: 2 | DB query | PASS (expected — transition creates Web Push) |
| Web Push for `job.note_added`: 0 | DB query | PASS (policy suppression) |

### Runtime data accumulation (after scenarios C-A..C-F)

The same database was reused for the visual acceptance phase. Final state on job
`66aafda6-2787-436f-8ff5-a84ffb02bc08`:

| Measure | Value |
| --- | --- |
| Total notes | 30 (3 original + 24 pagination seed "Sayfalama notu 1..24" + 3 visual/fix test notes "GÖRSEL KAPANIŞ …") |
| Realtime events | 33 (incl. event 33 from the reviewer-fix runtime check) |
| In-app notifications total | 61 |
| Unread at close: Admin | 1 (fix-check notification, not opened in UI) |
| Unread at close: Staff | 3 (assignee notifications from visual/fix notes — untouched, expected) |
| Unread at close: Manager | 0 (actor exclusion holds) |
| Web Push `job.note_added` deliveries | 0 (suppression intact) |
| Web Push `job.awaiting_approval` deliveries | 2 |

## Web Push suppression evidence

### Active subscriptions at test time

| User | Role | Subscription | Status |
| --- | --- | --- | --- |
| Demo Admin | ADMIN | `fcm.googleapis.com/fake-endpoint-admin` | Active |
| Demo Manager | MANAGER | `fcm.googleapis.com/fake-endpoint-manager` | Active |
| Demo Staff | STAFF | `fcm.googleapis.com/fake-endpoint-staff` | Active |

### Delivery summary

| Notification kind | Deliveries | Expected | Result |
| --- | --- | --- | --- |
| `job.note_added` (all scenarios) | 0 | 0 (policy suppression) | PASS |
| `job.awaiting_approval` (transition) | 2 | 2 (transition events allowed) | PASS |

The suppression is implemented at the source level in `appendStandaloneNoteProjection()`:
- In-app notifications are created for `job.note_added` events
- Web Push deliveries are explicitly NOT created for `job.note_added`
- This is a product policy decision, not an environment toggle

## Two-browser visual verification evidence

### Environment

- Tool: Chrome DevTools MCP (installed Chrome; no browser installation)
- Web: Vite on http://localhost:5173 (proxy to Fastify :3000)
- Viewports: desktop 1280x900, mobile 390x844
- Actors: Browser A = Manager (`manager@servora.local`), Browser B = Admin (`admin@servora.local`)
- Target: `/jobs/66aafda6-2787-436f-8ff5-a84ffb02bc08`
- Implementation head exercised: `f1b0137c0f393d82d699ad197ee525368dc1a389`

### Round 1 — tooling error, NOT a product failure

The first visual run reported FAIL claiming the backend created no notification. Root
cause was a verifier session error: its supplementary API checks were executed with the
Manager session cookie (Manager legitimately has 0 unread and exactly 3 notifications,
which matched the observed "3 old items"). Backend evidence disproved the claim:

- DB: `in_app_notifications` row `660cba52-0a40-40db-b59d-56ea7e0daba1` for Admin
  (kind `job.note_added`, entity `66aafda6…`, unread) + row `92e18818…` for Staff
  (assignee), both created 2026-07-31 09:24:28, same transaction as realtime event 31
  (resource keys include `notifications`)
- Admin-session curl: `GET /api/notifications/unread-count` → `{"unreadCount":1}`;
  `GET /api/notifications?limit=5` → first item `660cba52…`, `readAt: null`
- Manager-session curl: `{"unreadCount":0}` — exactly what the round-1 verifier saw

### Round 2 — fresh run with correct session discipline (all PASS)

| # | Assertion | Result |
| --- | --- | --- |
| 1 | Admin badge shows "1" at login (round-1 unread notification) | PASS |
| 2 | NC first item: title "Operasyon notu", body "Operasyon notu eklendi.", timestamp rendered | PASS |
| 3 | Privacy: item contains no note body ("GÖRSEL KAPANIŞ" absent), no actor-name preview, no note text in title | PASS |
| 4 | Admin-context API: unread-count=1; list first item id `660cba52…` readAt null | PASS |
| 5 | Click item → navigates to `/jobs/66aafda6-2787-436f-8ff5-a84ffb02bc08`; note body absent from URL | PASS |
| 6 | After read: badge disappears; Admin-context unread-count=0 | PASS |
| 7 | "Daha eski notları yükle" loads all 28 notes (round 1 state), no duplicates, button disappears | PASS |
| 8 | Manager adds "GÖRSEL KAPANIŞ TESTİ 2 20260731-094842" via real UI composer (POST 201) | PASS |
| 9 | Actor DOM (no reload): new note once, 28 older preserved, no duplicates, pagination button absent, badge stays hidden (actor exclusion) | PASS |
| 10 | Recipient DOM via SSE (no reload): new note appears, 28 older preserved, no duplicates, pagination button absent | PASS |
| 11 | Recipient badge 0 → 1 | PASS |
| 12 | NC live-refresh while open: new item "Operasyon notu" 09:48:51, unread | PASS |
| 13 | Privacy round 2: note body + actor name absent from notification item | PASS |
| 14 | Admin-context API: unread-count=1; first item id `88fa2fb3…` kind `job.note_added` readAt null | PASS |
| 15 | Click round-2 item → correct job URL; note body absent from URL | PASS |
| 16 | Mobile 390x844: composer reachable, NC reachable, notification navigation works (see "True-390px mobile re-verification" below) | PASS |
| 17 | Console errors / failed requests | NONE |

### Round 2 limitations

- Browser-level 200% zoom: NOT EXERCISED (CDP page-scale emulation unavailable in this harness; OS-controlled). CSS zoom is a different mechanism and was not used for acceptance.

### Reviewer-fix verification (notifications resource key unconditional)

Independent final review BLOCKED the conditional `notifications` resource key
(`note-realtime-projection.ts` added it only when at least one eligible notification
draft existed; the acceptance criterion requires the key on every standalone-note
event). Fix commit `2289a35`:

- `server/src/modules/job-cards/note-realtime-projection.ts` — resource keys are now a
  deterministic set (`job-notes:<jobId>`, `notifications`, `staff-profile:<assigneeId>`)
  for every standalone-note event; notification creation itself still honors actor
  exclusion and inactive-assignee suppression
- `server/tests/note-realtime-projection.test.ts` — zero-recipient case updated to
  require the `notifications` key (red → green verified)

Runtime verification after the fix (Manager adds note via API, event 33):

| Assertion | Result |
| --- | --- |
| Event resource keys = `job-notes:66aafda6…`, `notifications`, `staff-profile:5f2e1522…` | PASS |
| In-app notifications: Admin + Staff (Manager actor excluded) | PASS |
| Web Push `job.note_added` deliveries: 0 | PASS |

### True-390px mobile re-verification

The round-2 mobile measurement (scrollWidth 500 = clientWidth 500) did not prove the
390px case (the emulated CSS viewport was 500px). Re-verified with
`Emulation.setDeviceMetricsOverride width=390, height=844, deviceScaleFactor=1,
mobile=true` and confirmed `document.documentElement.clientWidth = 390`:

| Check (job detail, 390x844) | Result |
| --- | --- |
| `scrollWidth` 390 ≤ `clientWidth` 390 (no horizontal overflow) | PASS |
| `body.scrollWidth` 390 ≤ 390 | PASS |
| Composer `textarea#job-note` rect fully within viewport (35.39–354.61) | PASS |
| "Daha eski notları yükle" rect within viewport; loads all 30 notes, 0 duplicates, button disappears | PASS |
| NC trigger rect within viewport; dialog rect 46.81–390 x 0–844 (no overflow) | PASS |
| `/jobs` list page: no horizontal overflow | PASS |
| Console errors / failed requests | NONE |

## Privacy evidence

### Note body protection
| Assertion | Method | Result |
| --- | --- | --- |
| Note body NOT leaked in activity metadata (only noteId) | DB: `job_card_activity_logs.metadata` inspection | PASS |
| Author snapshot frozen at creation time (name, role) | DB: `job_card_notes.author_name_snapshot`, `author_role_snapshot` verified | PASS |
 | Inactive user not reachable (cannot authenticate) | Schema: `is_active=false` blocks login | PASS (schema — not specific to C) |
| Realtime audience does NOT include inactive users | DB: `audience_user_ids` empty for inactive-assignee event | PASS |

### Data isolation
| Assertion | Method | Result |
| --- | --- | --- |
| Notes scoped to organization_id (no cross-org leak) | Schema: FK constraint on `organization_id` | PASS (schema) |
| Author snapshot independent of profile rename | Code: snapshot taken at note creation, never re-read | PASS (source review) |

## Rollback evidence

### Transactional integrity

All note creation (`addNote`) and its projection (`appendStandaloneNoteProjection`) execute within a single `executeCriticalAction` transaction. If any step fails:

| Layer | Protection |
| --- | --- |
| Database | `BEGIN`/`COMMIT`/`ROLLBACK` via `JobCardTransaction` — all writes (note, activity, realtime event, notifications) atomically committed or fully rolled back |
| Idempotency | `clientActionId` + `operationKey` prevents duplicate execution — replay returns original result |
| Idempotency key | `clientActionId` + `operationKey` (`JOB_NOTE_ADD:${jobCardId}`) deduplication via `processed_actions` table |

### Failure scenario coverage

| Scenario | Coverage | Result |
| --- | --- | --- |
| Duplicate request with same `clientActionId` | C-C replay test (API + DB) | PASS |
| Inactive-user author rejection | `notes-service.ts:41-43` checks `author.isActive` and returns 403 | PASS (source review; runtime C-D confirms inactive assignee excluded, but inactive-author scenario not exercised in runtime) |
| Duplicate note creation prevented | `executeCriticalAction` idempotency (operationKey) + `processed_actions` table constraint | PASS (C-C replay test validates no duplicate notes/activities) |
| Transaction rollback on invalid data | `note-realtime-projection.ts` runs inside `executeCriticalAction`; any thrown error rolls back all writes | PASS (source review; all writes atomically committed via transaction client) |

## Evidence classification

| Category | Method | Result |
| --- | --- | --- |
| Runtime API acceptance | Node.js fetch + real PostgreSQL + Fastify | PASS (all scenarios) |
| Web Push suppression with active subscriptions | DB + API verification | PASS (0 deliveries for `job.note_added`) |
| Two-browser visual acceptance (pagination, realtime merge, NC live refresh, badge, privacy, mobile) | Chrome DevTools MCP, real Vite + Fastify | PASS (round 2 + true-390px re-verification) |
| Automated tests (focused) | Vitest | PASS (86 pass, 23 pre-existing skip) |
| Full server | Vitest | 1402 pass / 3 pre-existing fail |
| Full web | Vitest | 1141 pass |
| Server build | `tsc` | PASS |
| Web build | `vite build` | PASS |
| Exact-head CI | GitHub Actions | SUCCESS |

## Known limitations

- 3 pre-existing server test failures (local env, not Checkpoint C)
- Web Push deliveries for `job.note_added` are suppressed by policy; actual push delivery capability is verified through `job.awaiting_approval` notifications which do create deliveries
- Browser-level 200% zoom not exercised (CDP scale emulation unavailable; OS-controlled)
- Round-1 visual run initially reported a notification failure; disproven as a verifier session error (see "Two-browser visual verification evidence" — Round 1), backend and API verified correct via DB + Admin-session API + Round 2
- The zero-eligible-recipient runtime case (single active management user who is also the actor + inactive assignee) is covered by the updated unit test; it cannot be produced with the seeded organization (two active management users)

## Files changed (base-to-head PR diff)

### New files
- `server/src/db/migrations/021_job_card_note_added_notification_kind.sql` — migration adding `job.note_added` kind to notification constraint
- `server/src/modules/job-cards/note-realtime-projection.ts` — standalone note realtime projection with Web Push suppression, inactive assignee exclusion
- `server/tests/note-realtime-projection.test.ts` — 7 focused tests

### Modified files
- `server/src/modules/job-cards/notes-service.ts` — calls projection helper in transaction
- `server/src/modules/job-cards/service.ts` — publishes realtime events post-commit
- `server/src/modules/notifications/policy.ts` — `createNoteAddedNotificationDrafts()` with actor exclusion
- `server/src/modules/notifications/presenter.ts` — "Operasyon notu eklendi" message
- `server/src/modules/notifications/types.ts` — `job.note_added` added to `NOTIFICATION_KINDS`
- `server/tests/backup-restore-postgres.test.ts` — migration test update
- `server/tests/job-acceptance-postgres.test.ts` — acceptance test update
- `server/tests/job-card-notes.test.ts` — notes test update
- `server/tests/job-card-service.test.ts` — service test update
- `server/tests/job-card-workspace-postgres.test.ts` — workspace test update
- `server/tests/migrate-runner.test.ts` — migration runner test update
- `server/tests/notification-delivery-projection.test.ts` — delivery projection test update
- `server/tests/notification-policy.test.ts` — policy test update
- `server/tests/realtime-job-card-integration.test.ts` — realtime integration test update
- `server/tests/sales-meeting-postgres.test.ts` — sales meeting test update
- `server/tests/sales-meeting-schema.test.ts` — schema test update
- `server/tests/web-push-integrated-normal-path.test.ts` — web push test update
- `web/src/JobDetail.tsx` — `useRealtimeInvalidation(['job-notes:' + jobId])`
- `web/src/jobs/JobNotes.tsx` — `realtimeKey` prop with merge, `nextCursor` preservation
- `web/src/services/notifications-api.ts` — `job.note_added` added to frontend validation

### Reviewer-fix commit `2289a35` (in PR diff)

- `server/src/modules/job-cards/note-realtime-projection.ts` — `notifications` resource key unconditional
- `server/tests/note-realtime-projection.test.ts` — zero-recipient test updated to require the key

### Evidence-only commits (docs-only, after the implementation head)

- `docs/checkpoint-c-evidence.md` — deleted (moved to canonical path)
- `docs/evidence/job-operational-notes/checkpoint-c/README.md` — canonical evidence file (this file)

These commits change documentation only; they do not affect source code, tests, or migrations. The implementation head (`f1b0137c0f393d82d699ad197ee525368dc1a389`) referenced by the exact-head CI run 30577288701 is unchanged by them.

## Verification commands

```bash
cd server && npm test -- --run       # 1402/1405 pass (3 pre-existing)
cd server && npm test -- --run tests/note-realtime-projection.test.ts tests/notification-policy.test.ts tests/migrate-runner.test.ts tests/web-push-integrated-normal-path.test.ts tests/job-card-service.test.ts tests/job-card-notes.test.ts tests/realtime-job-card-integration.test.ts tests/notification-delivery-projection.test.ts   # focused: 86 pass / 23 skip
cd web && npm test -- --run          # 1141/1141 pass
cd server && npm run build           # compiles
cd web && npm run build              # compiles
git diff --check                     # clean
```
