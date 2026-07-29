# Operational Notes Checkpoint A evidence

## Provenance

- Exact base: `fc0f93b3f5ca4157161552fef3a30e00d34baa4c`
- Docs commit: `a66c85b3d740e185e805ff79d86ec3145951f80c`
- Main source commit: `19e9d1b8456a43f5ad4ab21ea8acbe4def88bcad`
- Responsive source repair: `d6b5f628161a0876cfba325195e3dd0718790e62`
- Original visual capture SHA: `d6b5f628161a0876cfba325195e3dd0718790e62`
- Review repair source SHA: `f1f9727ef3732872e2730a2d23276fccf28b5852`
- Migration: `019_job_card_operational_note_context.sql`
- Capture date: 2026-07-29

The screenshots remain the original visual captures from `d6b5f628161a0876cfba325195e3dd0718790e62`;
they were not recaptured or relabelled as repair-source captures. Review-repair API assertions and
automated validation were regenerated on `f1f9727ef3732872e2730a2d23276fccf28b5852`.
All evidence uses only synthetic organization, user, JobCard, and note data.

## Runtime

- PostgreSQL: disposable local database with migrations 001–019
- Review-repair PostgreSQL: isolated PostgreSQL 16 SCRAM/password-auth cluster on loopback
- API: real Fastify server on loopback
- Web: real Vite server on loopback
- Browser: original screenshots via Playwright MCP; current responsive regression via the repository smoke runner
- Capability configuration: Overview enabled; Calendar, Messaging, Web Push, and action-scoped geolocation disabled

## Browser and API assertions

| Scenario | Result |
| --- | --- |
| Assigned Staff adds a GENERAL note to an IN_PROGRESS JobCard | `201`; v1 note records `STAFF`, `IN_PROGRESS`, `GENERAL`, and related activity |
| Manager reads frozen identity and stage | Note remains `Demo Staff / Personel / Uygulanıyor` |
| Profile renamed after creation | Current profile is `Demo Staff Renamed`; note snapshot remains `Demo Staff` |
| Disabled author history | Disabled author login returns `401`; historical snapshot remains visible to Manager |
| Unassigned Staff read/write | Both note list and add return `404 JOB_CARD_NOT_FOUND` |
| Assigned Staff adds standalone note in NEW | `409 JOB_NOT_EDITABLE` |
| Manager annotates COMPLETED JobCard | `201`; v1 note records `MANAGER`, `COMPLETED`, `GENERAL` |
| Latest page | 25 items, ascending from `Sayfalama notu 04` through `Sayfalama notu 28` |
| Older page prepend | 29 total items; existing latest anchor delta is `0 px`; no duplicate or gap |
| Overview privacy | Generic `Operasyon notu eklendi`; no note body, derived preview, or `preview` key |
| HTML-like body | `<b>örnek</b> — 1 < 2` is visible as text; rendered `<b>` element count is `0` |
| Responsive | 390 px, 200% text, and 320 px/400% reflow have no horizontal overflow after the bounded JobDetail repair |

## Review-repair assertions

| Scenario | Result on repair source |
| --- | --- |
| Complete v1 database context | Real PostgreSQL rejects `NULL` separately for author name, author role, workflow stage, context, and related activity |
| v1 value constraints | Real PostgreSQL rejects blank author name and invalid role, stage, or context |
| Compatibility and ownership | Complete v1 and legacy v0 inserts succeed; wrong-JobCard activity relation is rejected |
| Exact cursor format | Repository emits `YYYY-MM-DDTHH:mm:ss.ffffffZ` from PostgreSQL without JavaScript `Date` normalization |
| Microsecond dataset | `.123900Z`, `.123500Z`, and `.123100Z`, page size 1 |
| HTTP cursor round-trip | Real Fastify query parser preserves each six-digit cursor unchanged |
| Concurrent newer insert | `.000100Z` in the next second does not enter or shift older-page traversal |
| Traversal integrity | Latest page is chronological; older traversal returns each seeded note exactly once with no duplicate or gap |
| Staff authorization | An unassigned active Staff request reaches the real Fastify route and returns `404 JOB_CARD_NOT_FOUND` |
| Note creation and replay | Real Fastify API returns `201` twice with the same note and related activity identity |
| Overview bodyless privacy | Real Overview response includes only note id, JobCard id/title, author name, and timestamp; the synthetic note body is absent |
| Vite availability | Real Vite source server returns `200` on loopback |

## Automated validation

- Focused server on password-auth PostgreSQL: 3 files, 96 tests passed.
- Focused web: 2 files, 56 tests passed.
- Full web: 96 files, 1129 tests passed.
- Full server on password-auth PostgreSQL: 117 files, 1383 tests passed.
- Server build: passed.
- Web build: passed.
- Bundle budget: passed, 55 chunks, each below 500000 bytes.
- Local responsive smoke: passed.
- High-severity dependency audit: `PASS_WITH_WAIVER`; only the policy-approved RSC-only `GHSA-qwww-vcr4-c8h2` waiver applied.

## Screenshot index

- `manager-frozen-snapshot-desktop.png` — Manager sees frozen Staff identity, role, and IN_PROGRESS stage after the profile rename.
- `disabled-author-history-desktop.png` — a disabled author remains visible through stored snapshots.
- `manager-completed-annotation-desktop.png` — Manager post-closeout annotation on a COMPLETED JobCard.
- `manager-completed-annotation-mobile-390.png` — mobile composer and note presentation.
- `manager-completed-annotation-200pct.png` — real JobDetail at 200% text.
- `manager-completed-annotation-400pct-reflow.png` — 320 px WCAG-equivalent 400% reflow.
- `overview-bodyless-notes.png` — bodyless generic Overview note activity.

## Deferred gates

- Checkpoint B: NOT AUTHORIZED
- Checkpoint C: NOT AUTHORIZED
- PR Ready: NOT AUTHORIZED
- Merge: NOT AUTHORIZED
- Staging/production: NOT AUTHORIZED
