# PR #443 pagination review closeout — 2026-11-17

Status: implemented and locally verified; merge and deployment require owner approval.
This record is evidence, not a new product/domain policy.

## Changes

- Resolve a pending keyboard focus request against the last valid page when a
  smaller server total clamps the requested page. Both overdue lists retain
  focus on their visible pagination region after the 13-to-7 recovery.
- Generate incident history in the backend's newest-breach-first order before
  applying the synthetic page window. Accountability, timestamps and measured
  durations keep their existing meanings.
- Cover both lists with deferred-response unit regressions and 120 ms Chromium
  shrink cases at 390 and 1440 px. The explicit shrink fixture is a presentation
  stress response; it performs no history mutation or backend write.
- Assert the fixture's complete history order and count screenshots separately
  from font-measurement entries.

## Local verification

- [passed] `cd server && npm run build`.
- [passed] `cd web && npm run build`.
- [passed] `cd web && npm run bundle:check` — 84 chunks within budget.
- [passed] Node 22.23.3: `node node_modules/vitest/vitest.mjs run` — 218 files,
  2783 tests, no skipped tests.
- [passed] Focused overdue/pagination tests — 21 tests. The two new shrinking-
  total cases first failed with BODY focus before the adapter change.
- [passed] `OVERDUE_CAPTURE_DIR=<owned directory> node scripts/overdue-pagination-smoke.mjs`
  — 46 screenshots; no browser errors, unexpected API requests or horizontal
  overflow. The history-order assertion first failed against the old fixture.
- [passed] `git diff --check`; Impeccable source detector returned no findings.
- [failed, environment comparison] Node 26.11.0 full web run — 2782 passed,
  duplicate-review-ui F17 failed. The same F17 failure reproduces on unchanged
  parent `3dbc2f2fa958113f77b544ae6001744d8feb7cb4`; its isolated Node 22 run
  passes 26/26. No duplicate-review code or test was changed.
- [not run locally] PostgreSQL server suite. Exact-head GitHub CI is the
  authoritative server/web/security acceptance and must be checked separately.

## Rendered evidence identity

The local capture used Chromium 140.0.7339.186, tr-TR, Europe/Istanbul,
fixed time 2026-11-17T09:00:00.000Z and reduced motion. It renders real React
components, production CSS and the owned Ant provider. Auth/backend are
synthetic and EventSource is disabled.

Captures were generated from parent `3dbc2f2fa958113f77b544ae6001744d8feb7cb4`
plus the changes in this commit, not from the unmodified parent. These source
hashes bind the render to the modified files:

| Source | SHA256 |
| --- | --- |
| `web/src/ui/antd/ServoraPagination.tsx` | `687375e24919c96408c2ec46e5ba240fed69261b32424679410575c41107308d` |
| `web/tests/open-submission-late-section.test.tsx` | `e9268fe46aec3d926281d69779353a8ed5f01977a6a39fd0bda510d8e8a7c80d` |
| `web/scripts/overdue-pagination-fixture.tsx` | `dc45d9a770c771dfe48644e951beb7637911c5efd6f08a9242bf006077762f41` |
| `web/scripts/overdue-pagination-smoke.mjs` | `7796413b693ce487b5358ed244d46786bda5b5dbf98f69629910938b2f4b0887` |

`checks.json` retains measurements and scenario results. PNGs were inspected
locally in `/tmp/servora-pr443-fix-evidence/visual-green/`; they are local-only,
not repository artifacts and not part of the Git package. The existing CI
upload step publishes the new run's full screenshot artifact for 14 days.

Inspected local captures: both clamped keyboard cases at 390/1440 px, history
first/last page at 390 px, and both 200% record-text cases. Record titles,
metadata and history text measure 16 to 32 px in the scoped text simulation.
App/AppShell, role-specific full pages, real browser zoom, Safari/WebKit,
physical devices and manual screen-reader acceptance remain NOT_RUN. Synthetic
UI checks do not establish backend authorization.
