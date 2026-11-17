# SERVORA-MED security dependency maintenance — 17 November 2026

## Change boundary

This patch is separate from PR #441 and is based on `main` `821602407af39bb007979608eb6a74661d10b723`. No product/business logic, database schema, migration, or deployment changes.

| Package | Before | After | Why |
| --- | --- | --- | --- |
| web Vite | 8.1.6 | 8.1.7 | Patch Vite dev-server advisory GHSA-p4f5-76q4-ffq7 |
| web + server Vitest | 4.1.11 | 4.1.12 | Patch `@vitest/mocker` GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp |
| server Fastify | 5.12.5 | 5.12.8 | Patch header-name validation advisory GHSA-389g-gv7q-r4x8 |
| server fast-uri override | 4.1.5 | 4.2.3 | Patch URI parsing advisories including GHSA-w74x-v6f9-j3xg |
| server Vite override | 8.1.6 | 8.1.7 | Match secure dev-tool patch level |

Lockfiles generated on an isolated read-only GitHub Actions runner with Node 24 / npm and the `--package-lock-only --ignore-scripts --no-audit` flags. Transitive semver-compatible changes are not all intentional upgrades; compare lockfile diffs and test on canonical Node 22 in GitHub CI.

## Known unresolved security risk — not waived

- `picomatch` advisory GHSA-fc5q-39xc-vjpf (high severity ReDoS) affects <=4.0.7. As of 17 November 2026, an official fixed npm version is not published.
- The lockfile can still contain an affected `picomatch` release via Vite/Vitest. Do **not** mark the npm security gate PASS merely because the direct package versions were updated.
- Do not use `npm audit --omit=dev`, advisory ignore lists, false package metadata, or unconditional `continue-on-error` to bypass high-severity checks. If upstream has not shipped a verified fix, keep the PR blocked and request an explicit separately reviewed security decision.
- Security test gate remains unchanged.

## Required validation

1. `npm ci` in web and server using canonical Node 22.
2. Web `build`, `bundle:check`, `npm test -- --run`, production-dist/responsive smoke, and browser acceptance including both overdue pagination and people lifecycle on the integrated PR #441 in a later independent check.
3. Server build, database migrations/schema checks, unit/integration/ops tests, and production dependency smoke.
4. `npm run audit:high` (web) and `npm audit --audit-level=high` (server). Record every surviving high or critical advisory; zero suppressed findings.
5. Exact-head PR CI and independent reviewer, then explicit merge authorization. Following merge, verify resulting-main CI.

## Current status

Draft security PR under review. The previous successful `main` CI run predates the fresh npm advisory surfaced later on 17 November; it is not proof of a clean current audit.
