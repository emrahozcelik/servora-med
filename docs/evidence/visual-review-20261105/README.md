# Visual review evidence — 2026-11-05

Historical synthetic layout captures from source
`197586fd6254a73ed362fa125f489da3ecb9be47`. Preserved during the second review;
not regenerated or upgraded to new acceptance evidence.

The approved A–E visual changes now have a
[separate implementation record](../../ui/reviews/2026-11-05-visual-improvements-implementation.md)
and [new before/after evidence](../visual-improvements-implementation-20261105/README.md).
The original artifacts and their hashes below remain historical.

- Current assessment: [revised visual review](../../ui/reviews/2026-11-05-visual-improvements.md).
- Method for future work: [rendered UI evidence workflow](../../ui/visual-review-workflow.md).
- [Original report](original-review.md) is superseded by the assessment above.
- [Original measurements](capture-results.json) record 14 views with no page errors,
  unexpected mocked API requests, alerts or document overflow. These are the
  recorded checks only, not complete UI or accessibility acceptance.
- [Original runner](original-capture.mjs.txt) is preserved verbatim as text. It
  used `node /tmp/servora-visual-review.mjs`, a local Vite middleware server and
  Playwright Chromium with real App/AppShell/React/CSS. It contains machine-local
  paths and imports the responsive staff fixture from the named source revision;
  it is historical provenance, not a portable approved runner. Browser version
  and a fixed clock were not recorded. Reproduction requires restoring that
  source/fixture and adapting the explicit checkout/output paths.
- [SHA-256 manifest](artifact-hashes.json) is the original capture-time record.
  It also lists the capture files below, which are retained locally only and are
  not tracked in Git, plus a pre-retention README revision. It does not assert
  correct sample data or capture freshness after edits, and it is not a live
  verifier of this directory.

## Scope

Screenshots are not part of the repository package. The product owner retains
the 14 capture files below locally, and the `.gitignore` rules for this directory
keep future captures untracked. Committed text artifacts, the runner snapshot
and measurements remain tracked.

Each view was captured at 1440×1000 and 390×1000 CSS px, full page, with reduced
motion. STAFF was used only for the own-profile view; the other six used ADMIN.
Fetch responses were synthetic, mutations refused, EventSource disabled, and
overview/calendar/messaging capabilities disabled. No production data was used.

| View | Desktop | Mobile |
| --- | --- | --- |
| Customer list | 1440: `customers-1440.png` | 390: `customers-390.png` |
| Customer detail | 1440: `customer-detail-1440.png` | 390: `customer-detail-390.png` |
| Customer create | 1440: `customer-create-1440.png` | 390: `customer-create-390.png` |
| Product list | 1440: `products-1440.png` | 390: `products-390.png` |
| Staff directory | 1440: `staff-directory-1440.png` | 390: `staff-directory-390.png` |
| Own staff profile | 1440: `staff-profile-1440.png` | 390: `staff-profile-390.png` |
| Job list | 1440: `jobs-1440.png` | 390: `jobs-390.png` |

## Known limitations discovered in the second review

1. Staff workload is 8 open + 3 waiting + 1 revision, but its type breakdown sums
   to 8. ReportsService expects the breakdown to sum to 12. Customer counters
   show 3 open and 12 completed while all-history has only 4; the same history
   list is returned for different customers. These are fixture inconsistencies,
   not demonstrated production defects.
2. July report data, November activity dates, a deliberately very long delivery
   unit and a huge quantity mix normal and stress scenarios. The sample does not
   establish typical page density or period reconciliation.
3. Job examples have empty `allowedCommands`. MANAGER, Staff customer/job views,
   normal command placement, other states and intermediate widths are unverified.
4. The runner catches and ignores its loading-wait timeout. A successful image
   write is not proof of readiness; future runners must wait for explicit settled
   identity/data and fail unexpected readiness timeouts.
5. Full-page captures show fixed navigation at its capture position. They do not
   by themselves demonstrate an obscured-control defect. Viewport and scrolled
   interaction checks are needed for that claim.
6. No keyboard, screen-reader, zoom, physical-device or backend acceptance is
   established by this bundle. Any earlier reports-specific checks belong to
   their own surface, source revision and acceptance record.
7. Follow-up inspection of the create forms found that the original runner mounted
   App without the outer ServoraAntProvider from `web/src/main.tsx`. Ant controls
   in this older bundle therefore do not prove production theme/locale geometry.
   The [create-form evidence](../job-create-review-20261105/README.md) includes the
   provider. Existing source-confirmed ordering findings remain observations;
   recapture affected Ant surfaces before implementation acceptance.

The source-confirmed layout/ordering observations remain useful. Fix these fixture
limitations before using the examples as a baseline for implementation acceptance.
