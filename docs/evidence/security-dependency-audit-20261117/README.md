# SERVORA-MED security dependency maintenance — 17 November 2026

## Change boundary

This patch is separate from PR #441 and is based on `main` `821602407af39bb007979608eb6a74661d10b723`. No product/business logic, database schema, migration, or deployment changes.

| Package | Before | After | Why |
| --- | --- | --- | --- |
| web Vite | 8.1.6 | 8.1.7 | Same-line maintenance patch (released 2026-11-09). The originally cited GHSA-p4f5-76q4-ffq7 returns 404 on GitHub; on 18 November no GitHub-reviewed advisory affecting Vite 8.1.6 was found |
| web + server Vitest | 4.1.11 | 4.1.12 | Patch `@vitest/mocker` GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp |
| server Fastify | 5.12.5 | 5.12.8 | Patch header-name validation advisory GHSA-389g-gv7q-r4x8 |
| server fast-uri override | 4.1.5 | 4.2.3 | Patch URI parsing advisories including GHSA-w74x-v6f9-j3xg |
| server Vite override | 8.1.6 | 8.1.7 | Match secure dev-tool patch level |
| server ip-address (transitive, production via `@fastify/rate-limit` `^10.2.0`) | 10.7.2 | 10.7.6 | Patch moderate ReDoS advisory GHSA-rxp7-6hxx-x8q5 (fixed in 10.7.4); lockfile-only, no `package.json` change |

Lockfiles generated on an isolated read-only GitHub Actions runner with Node 24 / npm and the `--package-lock-only --ignore-scripts --no-audit` flags. Transitive semver-compatible changes are not all intentional upgrades; compare lockfile diffs and test on canonical Node 22 in GitHub CI.

The `ip-address` entry was updated on 18 November with `npm update ip-address --package-lock-only --ignore-scripts --no-audit` (npm 11.20.0); the only lockfile change is that package's version, `resolved` and `integrity`.

## Retired on 20 November 2026

GitHub withdrew `GHSA-fc5q-39xc-vjpf` at `2026-11-18T15:38:56Z`; `npm audit`
no longer reports it. Per `DECISIONS.md` SEC-2026-11-20 the exception below
was removed and both audits are strict again (no exceptions). The section is
kept as the historical record of SEC-2026-11-18.

## Owner-approved temporary picomatch security exception (18 November 2026)

Owner approved the exception on 18 November 2026. It is a **risk acceptance,
not a vulnerability fix**.

- Only GitHub advisory `GHSA-fc5q-39xc-vjpf` (picomatch ReDoS, HIGH) may be
  excepted, including HIGH npm entries whose `via` chain contains only that
  same advisory: `picomatch`, `fdir`, `tinyglobby`, `vite`, `vitest`,
  `@vitest/mocker`, and (web only) `@vitejs/plugin-react`.
- Each affected package must be explicitly `dev: true` in the committed npm
  lockfile. Any extra direct advisory, missing or malformed graph, missing
  lockfile, new HIGH/CRITICAL, or production marking fails closed.
- Both server and web additionally run an **unexcepted**
  `npm audit --omit=dev --json`, and enforce zero production HIGH/CRITICAL.
  This checks the deployed dependency graph separately; it does not replace the
  full audit. The server production dependency packaging smoke stays unchanged.
- Valid from 18 November through the **end of 2 December 2026, Istanbul time**.
  The exception automatically fails at `2026-12-03T00:00:00+03:00` using the
  CI runner clock. No environment override of expiry is allowed.
- All audit entries are still validated for structure, metadata and counts.
  A run passing this control must explicitly say
  `PASS WITH TEMPORARY SECURITY EXCEPTION` and must not be described as
  zero vulnerabilities.
- Reasoned risk: the affected picomatch glob pattern is selected by repository
  development/test tooling, not an untrusted application request. CI supply
  chain and malicious repository content risks remain; approval is temporary,
  restricted, and subject to CI reviewers and expiry.
- If an upstream patch is published, update lockfiles and remove this exception
  without waiting for expiry. If a package appears in production, a new advisory
  is reported, or the provenance cannot be proven, CI must return FAIL.
- This approval does not authorize PR merges, deployment, additional audit
  suppressions or future renewals.

Implementation: `web/scripts/audit-picomatch-exception.mjs`,
`web/scripts/audit-high-policy-lib.mjs`,
`web/scripts/audit-high-policy.mjs` and 18 targeted tests in
`web/tests/audit-high-policy.test.ts`.

## Required validation

1. `npm ci` in web and server using canonical Node 22.
2. Web `build`, `bundle:check`, `npm test -- --run`, production-dist/responsive smoke, and browser acceptance including both overdue pagination and people lifecycle on the integrated PR #441 in a later independent check.
3. Server build, database migrations/schema checks, unit/integration/ops tests, and production dependency smoke.
4. Web `npm run audit:high` and server `node ../web/scripts/audit-high-policy.mjs --workspace server`: unexcepted production audit plus the single explicit, expiring dev-only picomatch exception. Record every remaining HIGH/CRITICAL; no other suppressions.
5. Exact-head PR CI and independent reviewer, then explicit merge authorization. Following merge, verify resulting-main CI.

## Current status

Draft security PR under review. The approved exception does not count as a fully remediated advisory. The previous successful `main` CI run predates the fresh npm advisory surfaced later on 17 November; it is not proof of a clean current audit.
