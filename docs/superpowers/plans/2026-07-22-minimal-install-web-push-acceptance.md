# Phase R Task 10 — Manual Browser/Device Acceptance Log

**Status:** PARTIAL — **desktop cross-browser push CLOSED (PASS)**; mobile/production enablement deferred to **Phase S**; Task 10 overall not closed
**Branch:** `feature/minimal-install-web-push`
**Exact head at desktop push close:** `69b16885d6acb60ca66d2a94564b73e2087a0ba8` (+ smoke contract follow-up if present)
**Exact head at Task 10A start:** `bfb27c8c5ee219f7cd891b7902a8f34a91d7b580`
**PR:** #45 Draft
**Timezone:** Europe/Istanbul

```text
Chrome Desktop push: PASS (operator)
Firefox Desktop push: PASS (operator)
Safari macOS push: PASS (operator)
Cross-browser subscription setup: COMPLETED (69b1688 readiness + enable fallback)
Android physical acceptance: deferred → Phase S
iPhone/iPad Home Screen acceptance: deferred → Phase S
Task 10 overall: PARTIAL
Production WEB_PUSH_ENABLED: false
```

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
| AC-CD-03 | Permission deny | PASS (agent CDP) | denied → guidance only, no enable CTA, no server sub, no re-prompt surface |
| AC-CD-04 | Foreground provider delivery | PASS (local backend) | Synthetic delivery rows moved PENDING→DELIVERED via live dispatcher; no secrets logged |
| AC-CD-05 | Background delivery UI | PASS (operator) | Operator confirmed staff↔manager instant notification traffic works on Chrome |
| AC-CD-06 | Closed browser delivery | PARTIAL | SW showNotification path OK; real closed-browser OS banner needs operator |
| AC-CD-07 | Exact open client click | PARTIAL | SW harness + local showNotification; operator OS click TBD |
| AC-CD-08 | Different open client click | BLOCKED | Operator |
| AC-CD-09 | No client click | BLOCKED | Operator |
| AC-CD-10 | Logged-out click / deep-link | PASS (agent) | Unauthenticated /jobs/:id → login wall, no JobCard data |
| AC-CD-11 | Disable / re-enable | PASS (local) | Disable clears server+browser sub; re-enable recreates both |
| AC-CD-11b | Logout isolation | PASS (agent) | Session revoke + browser clear; post-logout delivery stays PENDING |
| AC-CD-11c | Relogin no auto-rebind | PASS (agent) | New session does not auto-expose prior session subscription |
| AC-CD-12 | Retry schedule | BLOCKED | Needs controlled outbound block |
| AC-CD-13 | Duplicate/tag coalescing | BLOCKED | Operator/staging |
| AC-CD-14 | Stale endpoint | BLOCKED | Operator/staging |

### Chrome desktop matrix (summary)

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-CD-01 | Install / manual guidance | PASS (local Chromium) |
| AC-CD-02 | Permission allow | PASS (local Chromium) |
| AC-CD-03 | Permission deny | PASS (Chrome agent) |
| AC-CD-04 | Foreground delivery | PASS (DELIVERED via dispatcher + operator) |
| AC-CD-05 | Background delivery | PASS (operator) |
| AC-CD-06 | Closed browser delivery | PARTIAL — operator closed-browser eyeball still needed |
| AC-CD-07 | Exact open client click | PARTIAL — SW path proven |
| AC-CD-08 | Different open client click | BLOCKED |
| AC-CD-09 | No client click | BLOCKED |
| AC-CD-10 | Logged-out click | PASS (Chrome agent) |
| AC-CD-11 | Logout / rebind isolation | PASS (Chrome agent) |
| AC-CD-12 | Retry schedule (controlled outbound) | BLOCKED |
| AC-CD-13 | Duplicate/tag coalescing | BLOCKED |
| AC-CD-14 | Stale endpoint 404/410 | BLOCKED |

## Operator multi-browser confirmation (2026-07-22)

```text
Tester: operator (user)
Scope: Personel ↔ yönetici anlık bildirim trafiği
Browsers: all local desktop browsers under test (Chrome + Firefox + Safari)
Result: PASS — traffic works end-to-end in every browser tested
Notes:
- Covers in-app + device push path used by staff/manager workflow
- Playwright Chrome session was closed so operator could use real Chrome
- Local WEB_PUSH_ENABLED remains gitignored-only; production stays false
DB snapshot after session (counts only):
- web_push_deliveries DELIVERED count >= 3
- active subscriptions >= 1
```

### Desktop browser matrix — delivery gate (operator)

| Browser | Staff↔manager instant traffic | Result |
|---------|-------------------------------|--------|
| Chrome desktop | Allow + live traffic | PASS (operator) |
| Firefox desktop | Allow + live traffic | PASS (operator) |
| Safari macOS | Allow + live traffic | PASS (operator) |

**Sub-gate:** `desktop multi-browser push delivery = PASS` — **CLOSED**

### Desktop cross-browser push matrix (operator closeout 2026-07-22)

| Browser | Install UI | Device push enable + OS notification | Result |
|---------|------------|--------------------------------------|--------|
| Chrome Desktop | Chromium install button where available | PASS (operator) | **PASS** |
| Firefox Desktop | Manual install guidance (no beforeinstallprompt) | PASS (operator) | **PASS** |
| Safari macOS | Manual install guidance (File → Add to Dock) | PASS (operator) | **PASS** |

Cross-browser subscription setup fix: `69b1688` (bounded SW ready, Turkish errors, explicit-enable fallback). Service worker display path and server dispatcher unchanged.

**Residual (not blocking desktop push close; production still gated):**

| Gate | Chrome | Firefox | Safari |
|------|--------|---------|--------|
| Permission deny → no re-prompt / no enable CTA | PASS (agent CDP) | optional residual | optional residual |
| Closed-browser notification + safe deep-link | PARTIAL (SW show path) | optional residual | optional residual |
| Logout → browser sub cleared; revoked session not claimed | PASS (agent) | — | — |
| Relogin / session change → no auto server sub without enable | PASS (agent) | — | — |
| Logged-out deep-link → login wall, no JobCard leak | PASS (agent) | — | — |

#### Chrome lifecycle/security evidence (2026-07-22)

```text
AC-CD-03 deny:
- Notification.permission=denied
- UI shows “Bildirim izni kapalı…” only
- enable button hidden → no re-prompt surface
- hasServerSub=false (starting from unsubscribed)

Logout isolation:
- After Oturumu kapat: /api/auth/me → 401, login UI shown
- browser PushSubscription cleared
- Delivery forced to latest sub with revoked session stayed PENDING
  (dispatcher did not claim/send)

Account/session rebind:
- After re-login without explicit enable: hasServerSub=false
  (prior session-bound sub not exposed as current)

Logged-out deep-link:
- Navigate /jobs/<uuid> without session → login wall
- no job detail, no customer-like data leak

Closed-browser:
- SW showNotification synthetic path OK
- Real OS closed-browser receive still needs operator eyeball
```

Desktop cross-browser **push** acceptance is **closed PASS**. Mobile and production
enablement move to **Phase S**. PR #45 remains Draft until branding rebase + CI +
merge decision; production `WEB_PUSH_ENABLED=false`; Task 10 overall **partial**.

## Chrome Android (physical device) — Phase S

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-CA-01 … AC-CA-n | Install / allow / deny / bg / lock-screen / click | **Deferred — Phase S** (physical device + HTTPS staging) |

## Firefox desktop

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-FF-core | Staff↔manager + device OS notification | **PASS** (operator) |
| AC-FF-enable | Explicit enable after readiness fix `69b1688` | **PASS** (operator) |

## Safari macOS

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-SF-core | Staff↔manager + device OS notification | **PASS** (operator) |
| AC-SF-install-guidance | Manual install copy (no Chromium install button) | **PASS** (operator) |

## iOS / iPadOS Home Screen — Phase S

| Case ID | Scenario | Result |
|---------|----------|--------|
| AC-IOS-01 … | Home Screen install / permission / background / Focus | **Deferred — Phase S** |

## Phase S — Mobile Web Push Acceptance and Production Enablement

Deferred from desktop closeout (not required for desktop push PASS):

- Chrome Android physical-device acceptance
- iPhone/iPad Home Screen Web Push acceptance
- Lock-screen privacy review
- Mobile logout / account-switch
- Focus / Do Not Disturb behavior
- Production HTTPS / VAPID approval
- Metadata / retention approval
- Final production enablement (`WEB_PUSH_ENABLED`)

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
