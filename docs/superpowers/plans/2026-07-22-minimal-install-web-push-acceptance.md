# Phase R Task 10 — Manual Browser/Device Acceptance Log

**Status:** PARTIAL / BLOCKED on real-device evidence
**Branch:** `feature/minimal-install-web-push`
**Exact head at Task 10A start:** `bfb27c8c5ee219f7cd891b7902a8f34a91d7b580`
**PR:** #45 Draft
**Timezone:** Europe/Istanbul

## Safety

- Synthetic organization/users/JobCards only.
- No production customer data.
- No VAPID private keys, endpoints, `p256dh`, or `auth` values in this file.
- Screenshots are not committed by default.
- Playwright/device emulation is **not** accepted as AC evidence for Android/iOS/Safari lock-screen.

## Synthetic fixtures (for all cases)

```text
Organization: Phase R Acceptance
Users:
- push-recipient-a
- push-recipient-b
- manager-acceptance
JobCard:
- generic synthetic customer
- no phone / email / note / delivery detail / location
```

## Automated evidence already recorded (Task 10A/B)

| Area | Result |
|------|--------|
| Clean disposable PostgreSQL (scram-sha-256, port 55432) | PASS |
| Migrations 001–014 | PASS |
| Server tests | 1267 passed / 0 failed |
| Web tests | 752 passed / 0 failed |
| Web build + bundle | PASS |
| Responsive smoke | PASS |
| Audits (server/web omit=dev) | 0 vulnerabilities |
| SW build artifact (no SPA HTML, no fetch listener) | PASS |
| Backup/restore with web_push tables | PASS (subs=1, dels=1, notifs=1, migrations=14, fk=6; artifacts deleted) |
| Local Caddy/tunnel/systemd validate | BLOCKED (no docker/caddy/systemd-analyze); scripts are in GitHub CI |
| Exact-head CI at Task 9 close | server SUCCESS, web SUCCESS on `bfb27c8` |

## Staging config record (secrets omitted)

```text
environment name: local-task10-disposable-pg (not public HTTPS staging)
application origin: not provisioned for public browser push acceptance
WEB_PUSH_ENABLED production: false (must remain false until enablement gate)
VAPID subject: not provisioned by agent
VAPID public-key SHA-256 fingerprint: not provisioned by agent
database migration version: 014_create_web_push
server/web commit SHA: bfb27c8c5ee219f7cd891b7902a8f34a91d7b580
deployment timestamp: 2026-07-22 (local Task 10A run)
secrets committed: no
```

**Operator action required for 10C:** provision isolated HTTPS staging with operator-generated VAPID (umask 077, secret manager only), then fill the cases below.

---

## Case template

```text
Case ID:
Date/time with timezone:
Tester:
Device model:
OS exact version:
Browser exact version:
Installed/standalone state:
Permission before:
Scenario:
Expected:
Observed:
Result: PASS / FAIL / BLOCKED
Evidence reference:
Provider family: Google / Mozilla / Apple
Notes:
```

---

## Local Chrome acceptance session (2026-07-22, Europe/Istanbul)

```text
Tester: agent + operator-assisted
Browser: Chromium via Playwright MCP (local Chrome profile family)
Origin: http://localhost:5173 (secure context for SW)
Account: sezer.dener@dunyadental.com (STAFF, synthetic session)
Provider family: Google (FCM-style endpoint)
VAPID public SHA-256: d44eca69edffda62796ab385501d85e30c86950d1670860d762a178678eff4a5
WEB_PUSH_ENABLED: true (local gitignored .env only; production remains false)
```

| Case ID | Scenario | Result | Observed |
|---------|----------|--------|----------|
| AC-CD-01 | Install / manual guidance | PASS (local) | Settings shows “Uygulamayı yükle” when canPrompt; privacy copy present; login does not auto-prompt notifications |
| AC-CD-02 | Permission allow + subscribe | PASS (local) | Explicit “Cihaz bildirimlerini aç” → SW register `/service-worker.js`, browser sub + server sub present; UI → “Cihaz bildirimlerini kapat” |
| AC-CD-03 | Permission deny | BLOCKED | Needs fresh browser profile with denied permission (operator) |
| AC-CD-04 | Foreground provider delivery | PASS (local backend) | Synthetic delivery rows moved PENDING→DELIVERED (2/2) via live dispatcher; no secrets logged |
| AC-CD-05 | Background delivery UI | PARTIAL | Provider accepted delivery; operator should confirm OS/system tray banner text is generic |
| AC-CD-06 | Closed browser delivery | BLOCKED | Operator/device |
| AC-CD-07 | Exact open client click | PARTIAL | SW `showNotification` + click harness previously proven in automated tests; local OS click TBD |
| AC-CD-08 | Different open client click | BLOCKED | Operator |
| AC-CD-09 | No client click | BLOCKED | Operator |
| AC-CD-10 | Logged-out click | BLOCKED | Operator |
| AC-CD-11 | Disable / re-enable | PASS (local) | Disable clears server+browser sub; re-enable recreates both |
| AC-CD-12 | Retry schedule | BLOCKED | Needs controlled outbound block |
| AC-CD-13 | Duplicate/tag coalescing | BLOCKED | Operator/staging |
| AC-CD-14 | Stale endpoint | BLOCKED | Operator/staging |

### Chrome desktop matrix (summary)

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-CD-01 | Install / manual guidance | PASS (local Chromium) |
| AC-CD-02 | Permission allow | PASS (local Chromium) |
| AC-CD-03 | Permission deny | BLOCKED — operator fresh profile |
| AC-CD-04 | Foreground delivery | PASS (DELIVERED×2 via dispatcher) |
| AC-CD-05 | Background delivery | PARTIAL — confirm OS banner |
| AC-CD-06 | Closed browser delivery | BLOCKED |
| AC-CD-07 | Exact open client click | PARTIAL — automated SW harness + local showNotification |
| AC-CD-08 | Different open client click | BLOCKED |
| AC-CD-09 | No client click | BLOCKED |
| AC-CD-10 | Logged-out click | BLOCKED |
| AC-CD-11 | Logout / account switch | BLOCKED (disable/re-enable PASS separately) |
| AC-CD-12 | Retry schedule (controlled outbound) | BLOCKED |
| AC-CD-13 | Duplicate/tag coalescing | BLOCKED |
| AC-CD-14 | Stale endpoint 404/410 | BLOCKED |

## Chrome Android (physical device)

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-CA-01 … AC-CA-n | Install / allow / deny / bg / lock-screen / click | BLOCKED — physical device required |

## Firefox desktop

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-FF-01 … | Allow/deny / Mozilla endpoint / click / logout | BLOCKED |

## Safari macOS

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-SF-01 … | Add to Dock / allow / closed-browser / click | BLOCKED |

## iOS / iPadOS Home Screen

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-IOS-01 … | Home Screen install / permission / background / Focus | BLOCKED — physical device required |

---

## Privacy checklist (pending device runs)

- [ ] Lock-screen text has no customer/contact/JobCard title/note/delivery/actor/location
- [ ] Application logs have no endpoint/keys/payload/VAPID private key
- [ ] Access logs have no subscription secrets
- [ ] Provider logs review recorded without pasting secrets

## Production enablement gate (open)

- [ ] All real-device AC matrices PASS
- [ ] Staging VAPID stored outside Git
- [ ] Backup/restore production-like staging accepted by operator
- [ ] Branding PR #47 merged + Phase R rebased + re-verified
- [ ] Explicit product approval for `WEB_PUSH_ENABLED=true`
- [ ] PR #45 Ready only after gates above

**WEB_PUSH_ENABLED remains false in production config.**

## Known residual risk

At-least-once crash window: claimed-but-not-resulted deliveries reclaim after lease expiry; stable notification tag/topic reduces visible duplicates; external exactly-once is not claimed.
