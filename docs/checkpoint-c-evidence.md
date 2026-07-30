# Checkpoint C — Evidence

## Scope
Operational Notes feature: realtime projection, pagination, Web Push, Notification Center, and policy verification.

## Branch & PR
- Branch: `feat/job-operational-notes-realtime-c`
- Base: `327f460f59718b7afcb77f0a8c8c581503d3a501`
- Head: `996847ce2ffffebd7e4dfad5a75288db01603e3b`
- PR: #81 (Draft)

## Test Results

### Server Tests
```
cd server && npm test -- --run
```
- **Result:** 1398/1405 pass (7 pre-existing failures, unrelated)

### Web Tests
```
cd web && npm test -- --run
```
- **Result:** 1137/1137 pass

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
- Run #30572395811: SUCCESS ✅

## Files Changed
- `web/tests/job-notes.test.tsx` — 4 new focused tests for realtime merge, pagination, deduplication, lifecycle separation
