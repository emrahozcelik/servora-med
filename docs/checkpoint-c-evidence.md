# Checkpoint C — Evidence

## Scope
Operational Notes feature: realtime projection, pagination, Web Push, Notification Center, and policy verification.

## Branch & PR
- Branch: `feat/job-operational-notes-realtime-c`
- Base: `327f460f59718b7afcb77f0a8c8c581503d3a501`
- Head: `60bdbefd507634280578beda4a0c0ed14aadb96c` (exact head, pushed to PR)
- PR: #81 (Draft)

## Test Results

### Server Tests
```
cd server && npm test -- --run
```
- **Result:** 1402/1405 pass (3 pre-existing failures, unrelated to checkpoint)

### Web Tests
```
cd web && npm test -- --run
```
- **Result:** 1141/1141 pass

### Build
```
cd server && npm run build
cd web && npm run build
```
- **Result:** Both compile successfully

### Lint
```
cd server && npm run lint
cd web && npm run lint
```
- **Result:** No errors

## API Acceptance (Real PostgreSQL + Fastify)

### C-A: Manager adds standalone note
- Notes count: 1 ✅
- Activities count: 1 ✅
- Realtime events: 1 ✅
- Resource keys: `job-notes:<id>,notifications` ✅
- Admin: 1, Staff: 1, Manager: 0, Inactive: 0 ✅
- Web Push: 0 ✅

### C-B: Staff adds standalone note
- Actor excluded from audience ✅
- Admin: 2, Manager: 1, Staff: 1 ✅

### C-C: Replay (idempotency)
- Duplicate request returns same result ✅
- All counts unchanged ✅

### C-D: Inactive assignee
- Inactive assignee excluded from audience userIds ✅
- Inactive user receives 0 notifications ✅
- Resource keys include `staff-profile:<id>` ✅

### C-F: Transition regression
- `job.note_added` count unchanged (4) ✅
- NOTE_ADDED activities: 2 (standalone only) ✅
- Transition note has `SUBMIT_FOR_APPROVAL` context ✅

## Web Push Acceptance
- Server started with `WEB_PUSH_ENABLED=true` ✅
- `web_push_deliveries` table exists ✅
- 0 deliveries (no browser subscriptions registered) ✅
- No server errors on startup ✅

## Visual Verification (Playwright MCP)
- **Verdict:** PASS
- Staff (recipient) sees note via realtime without page refresh ✅
- Manager (actor) self-event doesn't create duplicate ✅
- Notification badge increases for recipient ✅
- Notification Center works ✅
- Notifications show "Operasyon notu eklendi" generic text ✅
- Mobile responsive (375×812) ✅
- Keyboard accessible ✅

## CI
- Run #30576418222: SUCCESS (server PASS 2m51s, web PASS 2m7s) ✅

## Files Changed (base-to-head diff)

### New files
- `server/src/db/migrations/021_job_card_note_added_notification_kind.sql` — migration adding `job.note_added` kind
- `server/src/modules/job-cards/note-realtime-projection.ts` — realtime projection with conditional `notifications` resource key, inactive assignee exclusion
- `server/tests/note-realtime-projection.test.ts` — 7 focused tests
- `web/tests/job-notes.test.tsx` — 4 realtime merge/pagination tests

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
