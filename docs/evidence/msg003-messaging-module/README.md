# MSG-003 messaging module acceptance — local real-runtime evidence

- Executed at: 2026-11-27T07:19:06.129Z
- Commit: `98e3a8080eac9ab78ca71b1ba63b75e7c73ec46d` (branch `fleet/20261127-101353-deepseek-162a`)
- Result: **PASS** — 91 PASS, 0 FAIL, 1 NOT_RUN
- Command: `cd web && node scripts/msg003-messaging-acceptance.mjs`

## Scenarios

| Scenario | Status | PASS/records | What was exercised |
| -------- | ------ | ------------ | ------------------ |
| A1 | PASS | 7/7 | Fresh-database takeover with MESSAGING_ENABLED=true; operator Modules page shows Mesajlaşma Açık with the takeover source |
| A2 | PASS | 50/50 | Two off/on operator cycles with an open MANAGER session: nav, /messages, Job Detail action, Overview summary and notification visibility |
| A3 | PASS | 4/4 | Messaging API while disabled: authenticated 404 NOT_FOUND and unauthenticated 401 |
| A4 | NOT_RUN | 0/1 | Push queue while disabled (WEB_PUSH stays disabled; DB only) |
| A5 | PASS | 11/11 | Pending assignee sync: reassignment while off, later notice and explicit participant sync, unread 0 for the new assignee |
| A6 | PASS | 5/5 | Offboarding a STAFF assignee while messaging is off transfers the job conversation; replacement opens it with unread 0 |

## Failures observed by the harness

- Yok

## Findings

- Yok

## Environment

- Real built Fastify server (`node dist/index.js`) started with `MESSAGING_ENABLED=true` on a fresh disposable database.
- Isolated PostgreSQL 17 cluster created with `initdb` / `pg_ctl` on a random loopback port and removed at the end.
- Real Vite web app and Playwright Chromium at 1440 and 390 CSS px.
- Synthetic organization, users, customer, job, conversation and messages only.
- Operator account granted through the host CLI (`operator grant --password-stdin`).
- No staging environment exists; deployment is not authorized.

## Limits / not covered

- No staging environment exists and deployment is not authorized (docs/operations/staging-contract.md). Acceptance ran locally against the real Fastify server, a disposable PostgreSQL 17 cluster, real Vite and Playwright Chromium with synthetic data only.
- A4 was not run: WEB_PUSH_ENABLED=false means no web-push dispatcher is constructed (server/src/app.ts), so there is no dispatcher tick to observe. No push delivery rows were fabricated.
- No Web Push device or service worker subscription is exercised; the push queue, VAPID delivery and service-worker click routing are outside this run.
- No backup/restore cycle is included here; restore-*.json/md in this folder belong to a separate author.
- Realtime SSE fan-out, multi-tab concurrency, version-conflict races and cross-organization isolation are not covered by this acceptance run (covered by server suites where applicable).
- Screenshots use Chromium at 1440 and 390 CSS pixels; other browsers and real mobile devices are not covered.

## Screenshots

- `screenshots/a1-operator-modules-1440.png`
- `screenshots/a1-operator-modules-390.png`
- `screenshots/a2-c1-operator-disable-dialog-1440.png`
- `screenshots/a2-c1-customer-off-stale-badge-1440.png`
- `screenshots/a2-c1-notifications-off-1440.png`
- `screenshots/a2-c1-customer-off-1440.png`
- `screenshots/a2-c1-customer-off-390.png`
- `screenshots/a2-c1-job-detail-off-1440.png`
- `screenshots/a2-c1-job-detail-off-390.png`
- `screenshots/a2-c1-operator-enable-dialog-1440.png`
- `screenshots/a2-c1-customer-on-1440.png`
- `screenshots/a2-c1-customer-on-390.png`
- `screenshots/a2-c1-overview-on-1440.png`
- `screenshots/a2-c2-operator-disable-dialog-1440.png`
- `screenshots/a2-c2-customer-off-stale-badge-1440.png`
- `screenshots/a2-c2-notifications-off-1440.png`
- `screenshots/a2-c2-customer-off-1440.png`
- `screenshots/a2-c2-customer-off-390.png`
- `screenshots/a2-c2-job-detail-off-1440.png`
- `screenshots/a2-c2-job-detail-off-390.png`
- `screenshots/a2-c2-operator-enable-dialog-1440.png`
- `screenshots/a2-c2-customer-on-1440.png`
- `screenshots/a2-c2-customer-on-390.png`
- `screenshots/a2-c2-overview-on-1440.png`
- `screenshots/a5-sync-notice-1440.png`
- `screenshots/a5-sync-notice-390.png`
- `screenshots/a5-sync-dialog-1440.png`
- `screenshots/a5-staff-b-conversation-1440.png`
- `screenshots/a5-staff-b-conversation-390.png`
- `screenshots/a6-offboarding-preview-1440.png`
- `screenshots/a6-offboarding-preview-390.png`
- `screenshots/a6-offboarding-success-1440.png`
- `screenshots/a6-staff-c-conversation-1440.png`
- `screenshots/a6-staff-c-conversation-390.png`

## Files

- `runtime-results.json` — every assertion with status, observed value and timestamp.
- `screenshots/` — scenario screenshots named `<screen>-<width>.png`.
- Raw logs (`runtime-log.txt`, `fastify.log`, `vite.log`) are not committed: the
  harness writes them to `$FLEET_EVIDENCE_DIR` when set, else to an OS temp directory.
