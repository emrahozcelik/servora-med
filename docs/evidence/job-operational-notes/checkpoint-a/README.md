# Operational Notes Checkpoint A evidence

## Provenance

- Exact base: `fc0f93b3f5ca4157161552fef3a30e00d34baa4c`
- Docs commit: `a66c85b3d740e185e805ff79d86ec3145951f80c`
- Main source commit: `19e9d1b8456a43f5ad4ab21ea8acbe4def88bcad`
- Responsive source repair: `d6b5f628161a0876cfba325195e3dd0718790e62`
- Evidence source SHA: `d6b5f628161a0876cfba325195e3dd0718790e62`
- Migration: `019_job_card_operational_note_context.sql`
- Capture date: 2026-07-29

The evidence uses only synthetic organization, user, JobCard, and note data.

## Runtime

- PostgreSQL: disposable local database with migrations 001–019
- API: real Fastify server on loopback
- Web: real Vite server on loopback
- Browser: Playwright MCP
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

## Automated validation

- Focused server: 6 files, 168 tests passed.
- Focused web: 4 files, 69 tests passed.
- Full web: 96 files, 1129 tests passed.
- Full server on local trust-auth PostgreSQL: 116 files and 1381 tests passed; the sole failure is the pre-existing password-auth contract because local PostgreSQL accepts an intentionally wrong password under trust authentication.
- Server build: passed.
- Web build: passed.
- Bundle budget: passed, 55 chunks, each below 500000 bytes.
- Local responsive smoke script: browser launch produced no output and was stopped; the required responsive cases were then exercised against the real application through Playwright MCP.
- Local network audits: not run because the execution policy rejected sending dependency metadata to npm. Exact-head GitHub CI is the authoritative audit and responsive-smoke gate.

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
