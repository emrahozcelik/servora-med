# PR #412 independent verification — 2026-11-06

Reviewed initial head: `17d44ad04a6caa9d9a6f45d08887a9f1ebd29a04`;
tree `a9c04fbb3da3991cc37b403eba851071efb1f726`;
remote main/observed production `3da00aeeb7863df7196a02f9290ab6cda11b8240`.
Only the new pr412-independent-20261106 worktree was used. Source hashes and Git history
bind the locally tested changes; the resulting commit/hosted CI is recorded in PR
checks and the handoff, not inferred from the initial commit's CI.

## Executed checks

Node 22.23.3 and lockfile installs (`npm ci --offline`).
- Initial five focused files: 64 PASS before any source changes.
- Final five focused files: 67 PASS.
- Final web suite: 217 files / 2751 PASS.
- Web TypeScript/build and bundle budget: PASS (79 chunks, each <= 500000 bytes).
- Existing responsive smoke suite: PASS.
- Server build and relevant reports/CRM regressions: 22 files / 226 PASS.
  These used a new SCRAM-authenticated PostgreSQL 17 cluster/database with UTF-8
  locale and the exact migration head. The first C-locale attempt failed three
  Turkish-search assertions; no product SQL was changed for that setup failure.
- git diff --check and targeted Impeccable detector: PASS.

## Confirmed UI defects and regression evidence

1. Fractional/unsafe URL offsets: RED then GREEN. Invalid offsets start at zero;
   valid integer offsets still align to a 5-record page. Every server request
   carries limit=5; records are not downloaded in full and hidden on the client.
2. Prior-query response during search debounce: RED then GREEN. A query change
   retires the old request immediately and waits for the matching debounced query
   before fetching. Latest-page response ordering is also exercised on the real
   screen, not just a request-gate helper.
3. Raw NEW/ACCEPTED/IN_PROGRESS copy remained in the individual report. The copy
   is now Turkish; source enums/API/date logic are untouched.
4. Sales follow-up type chips overflowed the 320px document (right edge 454px).
   Their own group now wraps. The real-browser overflow assertion is the
   regression; no global overflow clipping was added.

## Browser evidence

Command from web/: `CUSTOMER_PAGING_CAPTURE_DIR=<task-output> node scripts/customer-pagination-smoke.mjs`.
Real App/AppShell/router/Ant provider/production CSS; synthetic typed data only;
tr-TR / Europe/Istanbul; fixed 2026-11-06T10:00Z; reduced motion. API reads mocked,
realtime disabled; unexpected requests and mutations fail the runner.

33 captures cover 320/390/1440, Manager/Staff customer views, business trend, team
and individual Staff reports, and sales/follow-up copy. Previous/Next, search,
mobile/desktop filters and direct offsets are exercised through actual controls.
The matrix includes 0/1/5/6 records, a single last-page record disappearing (6→5),
a last page shrinking (12→10), zero-result recovery, invalid/negative/fractional/
unsafe/huge-safe offsets, and a delayed old search response. Recovery uses at most
two customer requests; the initial page uses one. Browser checks report zero page
errors, unexpected API requests, unexpected alerts and document overflow.

The final images remain local-only in /tmp/servora-pr412-browser-final; no existing
screenshots were touched or tracked. Measurements, logs, source hashes and the
versioned runner/fixture are retained here. Setup fixes to Vite routing, selectors
and response readiness are not product failures. The chip overflow was a real
rendered product defect and its before geometry is retained.

Retained stdout logs omit only extra blank lines at EOF. No result line is edited.
stdout-hashes.json records both original and retained bytes; original local logs
remain in the task's /tmp outputs. Source changes are preserved by Git rather
than a second whitespace-sensitive unified-patch archive.

Synthetic roles verify presentation, not authorization: existing server tests
supply the role/organization regression coverage. Actual 400% browser zoom,
manual screen-reader traversal, physical devices and production UI acceptance
were not run.

## Initial hosted CI and separate production incident

Initial run 42252642598 failed its server test job in the unchanged
local-evidence-deploy-gate test: two racers printed ACQUIRED where one was expected.
Web and Auth KDF passed. One isolated Node 22 run of that existing race test passed;
its cause was not changed or declared fixed by this UI work. The final head needs
its own completed hosted run.

The production staff-report cause was independently confirmed and fixed only in
separate Draft PR #413. See the incident record. The production incident remains
OPEN: source tests and CI do not activate a release or establish authenticated
post-deployment HTTP success.
