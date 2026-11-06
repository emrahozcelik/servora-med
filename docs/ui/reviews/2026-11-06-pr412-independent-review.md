# PR #412 independent review

Date: 2026-11-06. Initial head `17d44ad04a6caa9d9a6f45d08887a9f1ebd29a04`,
tree `a9c04fbb3da3991cc37b403eba851071efb1f726`, base/observed production
`3da00aeeb7863df7196a02f9290ab6cda11b8240` were independently verified.
Only new isolated worktrees were used; no subagents, canonical checkout changes,
reset/rebase/force-push, merge or production deployment were performed.

## Findings and corrections

| Severity | Finding | Correction |
| --- | --- | --- |
| P2 | Unsafe/fractional URL offsets reached request normalization. | Require safe nonnegative integers before aligning to a five-record page; RED/GREEN regression. |
| P2 | An old response could render after the search text changed but before debounce settled. | Retire the old effect on query change; fetch only the matching debounced query. Actual screen regression plus latest-page ordering. |
| P2 | Sales follow-up type chips overflowed a 320px page. | Wrap their own group; real-browser before geometry and final no-overflow checks. |
| P3 | Raw workflow enum names remained in individual Staff report copy. | Plain Turkish descriptions; domain enums and date computations untouched. |

The original meeting-date wording is now plain Turkish and still states that
current outcomes may change and cannot establish the exact historical state.
IANA timezone values remain in data/calculations but are absent from the target
business screens. No API/DTO/schema or numerical report policy was changed.

## Verification

See [the evidence bundle](../../evidence/pr412-independent-review-20261106/README.md).

- Initial focus: 5 files / 64 PASS before changes.
- Final focus: 5 files / 67 PASS; final web suite: 217 files / 2751 PASS.
- Web build, fixture typecheck, bundle budget, responsive package and targeted
  detector passed. Relevant server/CRM regressions: 22 files / 226 PASS on a new
  isolated PostgreSQL 17 UTF-8/SCRAM test environment; server build passed.
- Chromium: 33 captures at 320/390/1440 with actual App/AppShell/provider/CSS.
  Paging controls are clicked. Search/filter reset, direct and invalid offsets,
  single last-page deletion recovery, empty/single/full pages and response races
  are checked. Zero document overflow, unexpected requests or page errors.
- The original head's hosted server CI failed an unchanged deployment-lock race
  test. One isolated run passed; this review does not claim to fix that test.
  The new head's hosted result must be verified independently in PR checks.

Manual screen-reader/contrast acceptance, actual 400% browser zoom, physical
devices and production UI acceptance were not run. Synthetic role views do not
replace backend authorization tests.

## Separate production P1

The deployed staff-report service error was confirmed in a READ ONLY transaction:
active weekly obligations were included in operational counters but omitted from
the buckets used by a strict equality invariant. The source correction and
five-state PostgreSQL RED/GREEN are only in [Draft PR #413](https://github.com/emrahozcelik/servora-med/pull/413).
The [incident record](../../operations/incidents/staff-performance-500-20261106.md)
states the access limits and leaves production OPEN until a separately authorized
deployment and authenticated HTTP acceptance. PR #412 stays Draft and does not
contain the backend hotfix.
