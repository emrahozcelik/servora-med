# Slice 12 — Local Pilot Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use  
> superpowers:subagent-driven-development or superpowers:executing-plans.  
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship macOS + Cloudflare Tunnel pilot operations, restructured README,  
and Turkish user manual so a limited pilot can run without inbound ports—without  
implementing WebSocket.

**Design SSOT:** `docs/superpowers/specs/2026-07-15-local-pilot-cutover-design.md`  
**Baseline:** `main` @ `167d24a71f79c9c7a2f966c901700d6459ca1321`

## Global constraints

- No WebSocket, domain features, Docker/K8s, committed credentials.
- Do not break Ubuntu VPS Caddy/systemd contracts from Slice 11.
- User manual labels/routes must match `web/src` only.
- Prefer documentation + templates; minimal application code.
- No new runtime npm dependency unless unavoidable (default: none).

## File map

### Create

```text
docs/operations/local-macos-cloudflare-tunnel.md
docs/user-manual/servora-med-user-manual.md
ops/cloudflared/config.yml.example
ops/caddy/Caddyfile.tunnel.example
ops/launchd/com.servora-med.api.plist.example
ops/launchd/com.servora-med.backup.plist.example
ops/ci/verify-tunnel-caddyfile.sh   # optional if merged into existing verify
server/tests/tunnel-caddy-contract.test.ts
```

### Modify

```text
README.md
SERVORA_MED_MVP_SLICES.md
SERVORA_MED_ARCHITECTURE_PLAN.md
DECISIONS.md
docs/operations/production-deployment.md  # cross-link pilot vs VPS
docs/operations/backup-restore.md         # honesty table if missing
.github/workflows/ci.yml                  # plutil/caddy tunnel checks where feasible
```

### Do not modify

```text
ops/systemd/* (Ubuntu remains as-is)
ops/caddy/Caddyfile.example (VPS TLS) beyond shared conventions
server domain modules / migrations
```

---

### Task 1: Roadmap SSOT renumber (docs-first)

**Files:** `SERVORA_MED_MVP_SLICES.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md` (index only if needed)

- [ ] **Step 1:** Insert new Slice 12 section: Local Pilot Cutover… with deliverables and acceptance from design.
- [ ] **Step 2:** Rename current WebSocket section to **Slice 13**; preserve entry criteria and acceptance **verbatim**.
- [ ] **Step 3:** Update slice table row 12/13.
- [ ] **Step 4:** Commit

```bash
git commit -m "docs: renumber Slice 12 pilot cutover and defer WebSocket to 13"
```

---

### Task 2: Tunnel Caddyfile + contract tests (TDD)

**Files:**  
- Create `ops/caddy/Caddyfile.tunnel.example`  
- Create `server/tests/tunnel-caddy-contract.test.ts`  
- Optional: `ops/ci/verify-tunnel-caddyfile.sh`

- [ ] **Step 1: Write failing contract tests** that read the tunnel Caddyfile and assert:

```text
127.0.0.1:8080 or bind loopback
reverse_proxy 127.0.0.1:3000
Cache-Control no-store on API
Cache-Control no-cache on SPA shell
/assets/* immutable
no :443 site block / no automatic TLS directives for public certs
Cookie/Authorization log redaction present
trusted_proxies or equivalent client IP config present
client_ip_headers includes CF-Connecting-IP (exact final directive names per Caddy version used in validate)
```

- [ ] **Step 2: RED** — file missing or incomplete.
- [ ] **Step 3: Implement Caddyfile.tunnel.example** from design §5.3–5.4.
- [ ] **Step 4:** Add CI validation via pinned `caddy:2.9.1-alpine` (reuse Slice 11 pattern).
- [ ] **Step 5:** GREEN + commit

```bash
git commit -m "feat: add loopback Caddyfile for Cloudflare Tunnel pilot"
```

---

### Task 3: cloudflared config template + docs commands

**Files:** `ops/cloudflared/config.yml.example`

- [ ] **Step 1:** Author template with tunnel UUID placeholder, credentials-file absolute path placeholder, hostname → `http://127.0.0.1:8080`, catch-all `http_status:404`.
- [ ] **Step 2:** Add a lightweight test or CI step: YAML structure contains `ingress` and final catch-all service (no secrets).
- [ ] **Step 3:** Commit

```bash
git commit -m "docs: add cloudflared named tunnel config example"
```

---

### Task 4: launchd templates + lint

**Files:**  
`ops/launchd/com.servora-med.api.plist.example`  
`ops/launchd/com.servora-med.backup.plist.example`

- [ ] **Step 1:** Author plists with absolute path placeholders, KeepAlive, logging paths, no secret literals, backup calendar interval.
- [ ] **Step 2:** Verification

```bash
plutil -lint ops/launchd/*.plist.example   # when plutil exists
# else CI documents skip only if not on macOS; prefer XML well-formed check
```

- [ ] **Step 3:** Commit

```bash
git commit -m "docs: add macOS launchd examples for API and backup"
```

---

### Task 5: macOS Cloudflare Tunnel runbook

**Files:** `docs/operations/local-macos-cloudflare-tunnel.md`

- [ ] **Step 1:** Write full runbook covering design §5.1 and §5.6 (power/sleep checklist).
- [ ] **Step 2:** Cross official Cloudflare service install steps for macOS; document config path active for service (`~/.cloudflared` vs `/etc/cloudflared`).
- [ ] **Step 3:** Include IP chain diagram and rate-limit expectations.
- [ ] **Step 4:** Link backup-restore honesty table; host restore still pending until executed.
- [ ] **Step 5:** Commit

```bash
git commit -m "docs: add local macOS Cloudflare Tunnel pilot runbook"
```

---

### Task 6: Turkish user manual (code-grounded)

**Files:** `docs/user-manual/servora-med-user-manual.md`

- [ ] **Step 1:** Extract labels/routes from:

```text
web/src/paths.ts
web/src/AppShell.tsx
web/src/AppRouter.tsx
web/src/DeliveryCreate.tsx
web/src/GeneralTaskCreate.tsx
web/src/SalesMeetingCreate.tsx
web/src/JobDetail.tsx
web/src/jobs/*
web/src/StaffProfiles.tsx
web/src/UserManagement.tsx
web/src/CustomerList.tsx / CustomerDetail / ContactManagement
web/src/ProductList.tsx / ProductDetail / ProductForm
web/src/reports/*
web/src/PasswordChange.tsx
web/src/App.tsx (login)
```

- [ ] **Step 2:** Write all required sections (ortak, Staff, Manager, Admin, sorun giderme, güvenlik).
- [ ] **Step 3:** Add a small doc test or script that fails if manual references non-existent paths (optional but preferred): scan for `/jobs`, `/reports`, etc. against `paths.ts`.
- [ ] **Step 4:** Commit

```bash
git commit -m "docs: add Turkish Servora-Med user manual"
```

---

### Task 7: README restructure

**Files:** `README.md`

- [ ] **Step 1:** Rewrite per design §6; link runbooks and user manual; do not dump full manual into README.
- [ ] **Step 2:** Clearly separate dev vs pilot/prod commands.
- [ ] **Step 3:** Known limitations: host restore rehearsal, offsite, WebSocket deferred.
- [ ] **Step 4:** Commit

```bash
git commit -m "docs: restructure README for development and pilot install paths"
```

---

### Task 8: Architecture + decisions closeout partial

**Files:** `DECISIONS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, ops cross-links

- [ ] **Step 1:** Record durable pilot topology decisions.
- [ ] **Step 2:** Architecture: pilot = macOS+tunnel; VPS = reference; no inbound ports; tunnel ≠ backup.
- [ ] **Step 3:** Commit

```bash
git commit -m "docs: record macOS Cloudflare Tunnel pilot architecture decisions"
```

---

### Task 9: Client IP / rate-limit documentation + residual tests

**Files:** runbook + existing `trust-proxy-rate-limit.test.ts` + Caddy contract

- [ ] **Step 1:** Confirm Fastify tests still cover loopback trust vs spoof.
- [ ] **Step 2:** Document operator verification steps for two real browsers/IPs if automated CF path impossible.
- [ ] **Step 3:** Commit only if code/docs change needed

```bash
git commit -m "test: assert tunnel Caddy client IP trust contract"
```

---

### Task 10: CI gates for new artifacts

**Files:** `.github/workflows/ci.yml`

- [ ] **Step 1:** Validate tunnel Caddyfile with same pinned Caddy image.
- [ ] **Step 2:** shellcheck any new shell scripts; bash -n.
- [ ] **Step 3:** plutil when available (may skip on Linux with explicit message **only if** plist XML is otherwise validated).
- [ ] **Step 4:** Commit

```bash
git commit -m "ci: validate tunnel Caddyfile and pilot ops artifacts"
```

---

### Task 11: Full verification and Slice 12 closeout

- [ ] **Step 1: Run**

```bash
cd server && npm run build && npm test -- --run
TEST_DATABASE_URL=... npm test -- --run
npm audit --audit-level=high
cd ../web && npm run build && npm test -- --run && npm audit --audit-level=high
bash -n ops/scripts/*.sh ops/ci/*.sh 2>/dev/null || true
shellcheck -x ops/scripts/*.sh ops/ci/*.sh 2>/dev/null || true
# caddy validate tunnel file
git diff --check
```

- [ ] **Step 2:** Update MVP Slice 12 acceptance checkboxes only for items verified in-repo (docs/templates/tests). Mark operator-only pilot live checks as pending in text—not falsely checked.
- [ ] **Step 3:** Push branch; open PR only if user asks.
- [ ] **Step 4:** Report summary format from slice brief.

---

## Task dependency graph

```text
Task 1 roadmap
  → Task 2 tunnel Caddy + tests
  → Task 3 cloudflared template
  → Task 4 launchd
  → Task 5 runbook (depends 2–4)
  → Task 6 user manual (parallel with 5 after routes audit)
  → Task 7 README (after 5–6)
  → Task 8 decisions/architecture
  → Task 9 IP tests polish
  → Task 10 CI
  → Task 11 closeout
```

## Execution stop

**Do not implement Tasks 1–11 until the user explicitly approves this plan and the design.**
