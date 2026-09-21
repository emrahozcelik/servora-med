# Servora-Med UX Shell Design Decision Package

Status: **APPROVED WITH REVISIONS** (product-owner decisions Q1–Q3 resolved; architecture revisions R1–R12 reconciled; ready as specification for Slice 3A / 3B / 4).
Base verified: `origin/main` = `c0f6141` (Slice 1 + Slice 2 merged). No code changed in this task.

Scope: shell, route identity, PageHeader, breadcrumb/ReturnLink, MobileTopBar, branding.
Slices 1–2 (VIS-01/02/04, VIS-03/A11Y-02/VIS-06) are CLOSED and stay closed.

Revision history: v1 PROPOSED (12 decisions + home addendum) → v2 reconciles Q1–Q3 (all Option A) and R1–R12. Terminology change: the mobile control formerly called "parent line" is now **ReturnLink** throughout. → v2.1 hardening: H1 RouteId granularity (no umbrella ids), H2 desktop conditional context-return control, H3 single resolved-identity owner.

---

## 1. Evidence reviewed

### Audit sources

- `test-results/ux-audit-2026-09-21.md` (23 routes × 2 viewports, findings A1–A6, B1–B3, C1–C5)
- `test-results/ux-deep-audit-2026-09-21.md` (findings RESP-01–06, BRAND-01–03, HDR-01–04, S1–S7 systemic causes, token-drift table, 18-route header matrix)
- Real-world small-mobile screenshot (task brief): unreadable wordmark + `Genel Bakış` clipped to `Ge…`, bell and `Menü` clear/usable. Resolved per Q1 by removing brand/title competition, not by resizing the wordmark.

### Source files / components inspected (at `c0f6141`)

- `web/src/shell/navigation-model.ts` — nav SSOT (`buildNavigationModel`), `resolveShellTitle`, `resolveShellBackTo`, `isJobsListPath`
- `web/src/AppShell.tsx` — shell composition, `desktopQuery = '(min-width: 64rem)'`, drawer focus trap/restore, `setDocumentTitle(title)`
- `web/src/shell/MobileTopBar.tsx` — brand + `Geri` + title + bell + `Menü` composition
- `web/src/shell/MobileBottomNav.tsx`, `web/src/shell/DunyaDentalBrand.tsx` (variants `login | sidebar | topbar`, always `<span>`, never a link)
- `web/src/paths.ts` — full route table (incl. `/settings/data-management/*`, `/reports/*`, `/staff/:id/reports`, dynamic detail routes)
- `web/src/AppRouter.tsx` — role-aware landing (`overviewEnabled ? overview : jobs`), `ForbiddenView`/`UnknownRoute` fallbacks
- `web/src/document-title.ts` — `CANONICAL_DOCUMENT_TITLE`, standalone-only route titles
- `web/src/styles.css` — `.mobile-top-bar*` (755–819), `.route-identity-heading` + desktop sr-only rule (~3292–3320), `.dunya-dental-brand--*` (58–75), topbar brand (3373)
- Bespoke back inventory: `JobDetail.tsx:633` (`Listeye dön`), `UserManagement.tsx:169/223` (`İşlere dön`), `StaffProfiles.tsx:78/99` (`İşlere dön`), `CustomerDetail.tsx:190` (`Müşterilere dön`), `ContactManagement.tsx:105` (`{name} kaydına dön`), `StaffOperationalReport.tsx:254` (`backLabel`), `AppRouter.tsx:257` (staff-report backLabel), report pagination (`Önceki sayfaya dön`), `MessagingPage.tsx:856/1153` (flow-local back), `FollowUpBreadcrumb` (only real breadcrumb, tracking-chain only)
- `location.state` usage today: only `notice`/`customerNotice` strings — **no `from`/return-context mechanism exists**

### Routes inspected

`/overview`, `/jobs`, `/jobs/:id`, `/jobs/new-*`, `/customers`, `/customers/:id`, `/customers/:id/contacts/:id`, `/products`, `/products/:id`, `/reports` + 5 sub-reports, `/calendar`, `/messages`, `/users`, `/users/:id`, `/staff`, `/staff/:id`, `/staff/:id/reports`, `/settings` + 6 sub-settings, `/docs`, `/help`, login/forbidden/unknown.

### Assets inspected (`web/public/branding/`, via `sips`)

- `dunya-dental-sidebar.png` — 4538×3210, landscape full wordmark (used by `login` + `sidebar` variants)
- `dunya-dental.png` — 5673×4012, landscape full wordmark (used by `topbar` variant incl. mobile)
- **No compact mark, monogram, or icon-only asset exists — and none is required** (Q1 Option A). A compact asset is FUTURE / NOT REQUIRED FOR SLICE 4.

### Current breakpoints

- Shell switch: `64rem` (1024px) JS media query + matching CSS. 768–1023 gets full mobile chrome (bottom nav + mobile topbar); per Q2 this is retained unchanged — no tablet shell, no breakpoint change in this workstream.
- Content reflow: `@media (max-width: 720px)` family. DESIGN.md `mobile-max: 40rem`, `filter-collapse-max: 56rem`.

### Current behavior verified (code, not re-measured)

- Desktop topbar: title + second brand + notifications. No back, no breadcrumb.
- Mobile topbar: brand (≤7rem/32%) + `Geri`-or-spacer + ellipsis title + bell + `Menü`.
- `route-identity-heading` (h1): sr-only ≥64rem, visible <64rem → desktop has no visible content H1; mobile shows topbar title + content H1 with the same text (×3 on Messages with the column heading).
- Sub-routes share the parent shell title (`/reports/*` → `Raporlar`, `/settings/*` → `Ayarlar` except data-management/demo/backup); no distinct sub-route identity.
- Settings 2nd-level (profile/security/notifications/application) and report subpages have no shell back target (`resolveShellBackTo` → null).
- All hierarchy back is static; entry context (e.g. Calendar → job) is always lost.

---

## 2. Current architecture map

- **Route/nav source:** `paths.ts` (URL builders) + `navigation-model.ts` (destinations, role filtering, shell title resolver, shell back resolver, bottom/overflow split). One SSOT for destinations; title/back are two independent ordered `if`-chains over pathname prefixes — no shared record, no parent metadata, no breadcrumb data.
- **Shell:** `AppShell` owns viewport switch, drawer, title/back resolution calls, document-title effect, topbar/bottom-nav composition. Mobile title/back rendering owned by `MobileTopBar`.
- **Title ownership:** three independent producers — `resolveShellTitle` (topbar + mobile title), per-page `route-identity-heading`/eyebrow markup (content H1), `resolveDocumentTitle` (browser/PWA). DESIGN.md 302–304 already mandates single-source title + no duplicate, but no mechanism enforces it.
- **Back ownership:** `resolveShellBackTo` (mobile shell only) + ~15 bespoke page-level buttons/links with five different vocabularies + flow-local back (messaging, follow-up create). No hierarchy/context distinction.
- **Brand ownership:** `DunyaDentalBrand({variant})` maps variant → file; pages/shell pick variant + CSS size independently. No size/link/variant contract, no canonical home target.

---

## 3. Confirmed problems

| Finding | Verdict | Evidence (current code) | Systemic? |
|---|---|---|---|
| RESP-01 title clipped (`Ge…`) | Confirmed, P1 | `MobileTopBar` one-line composition; brand ≤7rem + fixed `Geri` + bell + `Menü` starve `.mobile-shell-title` (flex:1, nowrap ellipsis) at ≤360px | Yes — space allocation, not font size |
| BRAND-01 logo not linked | Confirmed | `DunyaDentalBrand` renders `<span>` in all 4 shell placements | Yes |
| BRAND-02 three scales, two files | Confirmed | sidebar 235×128 / topbar 74×52 / mobile 51×36; `dunya-dental-sidebar.png` vs `dunya-dental.png` | Yes |
| BRAND-03 mobile unreadable | Confirmed | 51×36 full wordmark; resolved by Q1 (brand removed from <1024px topbar) | Yes |
| HDR-01 no PageHeader contract | Confirmed, root | 18-route matrix: eyebrow/subtitle/H1/actions/tabs/filters assembled per page | Yes |
| HDR-02 duplicate title | Confirmed | sr-only ≥64rem + visible <64rem + topbar title (×3 on Messages) | Yes |
| HDR-03 static document.title | Confirmed | `resolveDocumentTitle`: route title only when standalone | Yes |
| A1 (=BRAND-01) | Confirmed | same as BRAND-01 | Yes |
| A2 desktop breadcrumb/back absent | Confirmed | `AppShell` desktop header has neither; only `FollowUpBreadcrumb` exists (tracking-chain) | Yes |
| A3 mobile back gaps | Confirmed | `resolveShellBackTo` null for settings L2 + report subpages | Yes |
| A4 stale `İşlere dön` | Confirmed | `UserManagement:169/223`, `StaffProfiles:78/99`, `AppRouter` fallbacks | Route-local, pattern-level fix |
| A5 duplicate/inconsistent back | Confirmed | job detail: shell `Geri` + content `Listeye dön`; 5+ label shapes; product detail has none | Yes (vocabulary) |
| A6 static parent loses context | Confirmed | no `state.from` anywhere; Calendar → job → `Geri` always lands `/jobs` | Yes |
| S1/S2/S7 systemic causes | Confirmed | no PageHeader, no brand contract, 3 title producers, 2 resolver chains | Yes |

---

## 4. Proposed decisions

Twelve normative decisions. Resolved product-owner outcomes (Q1–Q3, all Option A) and architecture revisions (R1–R12) are already reconciled below — they are not open questions.

### Decision D1 — Single route-identity registry with param-aware hierarchy

Status: APPROVED (revised per R1, R3, R5, R6, R7)
Decision: Introduce one canonical route-identity registry keyed by route id. Each entry owns exactly: `id`, `title` (generic fallback title — e.g. `İş detayı`, `Müşteri detayı`, `Personel profili`), `parentId` (static hierarchy parent id, null only at roots), and an optional `parentLocation(params)` builder that derives the concrete parent URL from current matched route params by calling the canonical builders in `paths.ts` (R1). Identity construction never duplicates URL templates. `section` is OPTIONAL and only present on authenticated-shell routes (R5); login/forbidden/not-found carry no fake section. There is NO `homeEligible` (R3 — home policy lives in the navigation model), NO `mobileTitle` (R6 — validate canonical titles in the fixed layout first), and NO domain fetching or entity types in the registry (R7). The existing `resolveShellTitle`/`resolveShellBackTo` if-chains are re-expressed as lookups over this registry.
Rationale: S1+S7 — one record replaces three producers and two resolver chains; breadcrumb, ReturnLink fallback, title, and document.title derive from the same parent links. Param-awareness (R1) makes `/customers/:customerId/contacts/:contactId` → parent customer URL and `/staff/:staffId/reports` → profile URL derivable without hand-wired strings.
Alternatives rejected: (a) `parentId` alone — cannot build parameterized parent URLs; (b) duplicating URL templates in metadata — drift with `paths.ts`; (c) extending the two resolver functions — preserves the dual-source drift; (d) actions/tabs/filters in metadata — page-framework creep (see D2); (e) umbrella ids for statically distinct routes — violates the granularity rule below.
Granularity rule (normative): **every distinct static route identity that has a different canonical title, hierarchy position, or document-title identity receives its own identity key** (full key list in §5, derived from `paths.ts`). Dynamic path instances sharing one semantic pattern share one id (`/jobs/:id` → one `jobDetail`; individual names are runtime overlays, H3).
Implementation impact: new `route-identity.ts` beside `navigation-model.ts`; shell + PageHeader consume it; pages stop hand-writing eyebrows for hierarchy purposes. Slice 3A.
Regression protection needed: metadata tests (every route has title; parent chains terminate at roots; no orphans; sub-route titles distinct from parents where required; `parentLocation` output equals the canonical `paths.ts` builder output for representative params).

### Decision D2 — Shared PageHeader with bounded slots

Status: APPROVED (revised per H2 — return-context region added)
Decision: Introduce `ui/PageHeader` owning exactly: eyebrow/section line, title (the single H1, rendering the resolved identity's effective title — H3), description, breadcrumb region (desktop, hierarchy-only, D5), one generic **return-context region** (mobile: ReturnLink, always rendered on nested routes per D6 fallback contract; desktop: compact context-return control rendered ONLY when a valid context return exists AND differs meaningfully from the hierarchy parent, H2/D6), and an `actions` passthrough slot for page-owned controls. One region, not two implementations: the region reads the same resolved return target; viewport rules decide visibility. Tabs and filters stay page-owned composition placed in documented regions *below* the header — they are not header props. `primaryAction`/`secondaryAction` as data are REJECTED (actions carry business authorization and pending states; serializing them into metadata duplicates page logic).
Rationale: HDR-01 without creating a god component; pages keep business ownership, header owns identity chrome.
Alternatives rejected: (a) audit-suggested `primaryAction?/tabs?` in metadata — page-framework creep; (b) pure-CSS convention — unenforceable, drift returns.
Implementation impact: new adapter + migration of ~18 bespoke headings in Slice 3A (foundation); old `workspace-heading`/`route-identity-heading` patterns retired per migration map (§12).
Regression protection needed: contract tests (one H1 per page, slot presence per route class).

### Decision D3 — One semantic H1, one visible identity per viewport

Status: APPROVED (revised per R10 — desktop ambiguity removed; H3 ownership clarified)
Decision: The visible route identity is rendered exactly once per viewport. Desktop: PageHeader owns the visible route identity — it renders the semantic/visible H1 (from the single resolved identity, H3) with the breadcrumb above it on nested routes; the desktop topbar does NOT repeat the route title and does NOT show a second brand — it remains global shell chrome/actions (notifications, menu). Mobile: the MobileTopBar title carries the visible identity and the PageHeader content H1 is sr-only (semantics/anchors preserved) — exactly one visible identity surface either way, with the desktop topbar carrying none. No surface reconstructs the title independently: AppShell/MobileTopBar, PageHeader, and the document-title effect all read the same resolved identity value (H3). Messages-style triple rendering becomes impossible by construction.
Rationale: HDR-02 + DESIGN.md 304 (already mandates this; now with mechanism) + Q3/R10.
Alternatives rejected: (a) topbar breadcrumb-tail context label on desktop — still a second identity surface; rejected per R10; (b) H1 only in topbar — breaks content anchor/heading order; (c) keeping both — current bug.
Implementation impact: shell + PageHeader + retirement of the ≥64rem sr-only hack in favor of the single-source rule (3A foundation, 4 cleanup).
Regression protection needed: per-route visible-identity-count test (desktop 1 via PageHeader, topbar title absent; mobile 1 visible title + content H1 semantics).

### Decision D4 — Document title from route identity + runtime overlay

Status: APPROVED (revised per R7)
Decision: `document.title` = `{resolved route title} · Dünya Dental` in BOTH browser and standalone PWA modes. The title is the effective title of the single resolved identity (§5/H3: static generic fallback from the registry, entity overlay when the page supplies one — e.g. `İş detayı · Dünya Dental` while loading, `<record name> · Dünya Dental` after load). The document-title effect reads the resolved value; it never computes a fallback itself. `CANONICAL_DOCUMENT_TITLE` remains the boot/fallback value. The standalone-vs-browser fork is deleted.
Rationale: HDR-03 + WEB-04 (one title system); WCAG 2.4.2 spirit for multi-tab managers.
Alternatives rejected: keeping the fork — preserves the reported inconsistency for no product benefit.
Implementation impact: `document-title.ts` rewrite (small) + resolved-title plumbing; no per-page title code. Slice 3A.
Regression protection needed: title tests per route class incl. loading/direct-URL states.

### Decision D5 — Desktop breadcrumb is hierarchy-derived and param-aware

Status: APPROVED (revised per R1, R2)
Decision: Desktop shows a hierarchy breadcrumb (never history) on every route with depth ≥ 2, rendered by PageHeader from `parentId` links with concrete URLs from `parentLocation(params)` (R1): e.g. `Raporlar / Personel`; entity crumbs show the runtime overlay label when loaded, the generic kind label otherwise (`İş detayı`). Root/list routes show none. Settings L2 and report subpages gain real crumbs via their new parent links (A3 closed on desktop). The breadcrumb NEVER reflects entry context — Calendar → job still crumbs `İşler / <job>` (R2).
Rationale: A2 + HDR-01; hierarchy answers "where am I", history never does reliably.
Alternatives rejected: breadcrumb on every page including roots — noise without information.
Implementation impact: PageHeader breadcrumb region + registry parent links + `paths.ts` builder reuse; `FollowUpBreadcrumb` stays as the tracking-chain exception (renamed/documented as such). Slice 3B.
Regression protection needed: crumb-chain tests per nested route incl. direct-URL load and parameterized parents.

### Decision D6 — ReturnLink on mobile; conditional context control on desktop

Status: APPROVED (revised per R2 — terminology and model corrected; H2 — desktop rule added)
Decision: PageHeader's return-context region renders per viewport. **Mobile:** a single **ReturnLink** `‹ {label}` directly under the topbar (or as the PageHeader's first row) on every nested route — never on roots. **Desktop:** breadcrumb stays hierarchy-only AND a compact context-return control (e.g. `Takvime dön`) appears ONLY when a valid context return exists AND is meaningfully different from the deterministic hierarchy parent; when context collapses to the hierarchy destination (Jobs → job), no redundant control is shown — the breadcrumb already covers it; on direct URL there is no context control at all. Three explicit concepts: (1) **hierarchy parent** — deterministic, registry-derived, drives breadcrumbs, always available for nested routes; (2) **context return** — optional, entry-context-derived (e.g. Calendar → job); (3) **return target** — what the control actually navigates to: the valid context return if available, otherwise the hierarchy-parent fallback. The control label reflects the return target (`‹ Takvim` for a Calendar return, `‹ İşler` for the fallback) and must NEVER be described as the page's hierarchy parent when it isn't. Vocabulary fixed: mobile `‹ {label}`, desktop `{context label}'e dön` (e.g. `Takvime dön`); the bare `Geri` label and all page-level `…dön` buttons on migrated routes disappear (migration map §12). Accessible labels carry return semantics via `aria-label`.
Rationale: A3/A5 + R2; one vocabulary ends the five-label mixture; the model no longer mislabels a Calendar return as Job Detail's parent.
Alternatives rejected: keeping shell-owned `Geri` — preserves the coverage-gap mechanism (shell can't know entity parents); calling the control a "parent line" — factually wrong for context returns (R2).
Implementation impact: `MobileTopBar` loses `backTo`; PageHeader gains ReturnLink region; bespoke buttons deleted per map. Slice 3B.
Regression protection needed: ReturnLink presence/absence + label/target tests per route (context vs fallback cases); no-duplicate-back test (shell + content).

### Decision D7 — Context return: ephemeral, validated, fail-closed

Status: APPROVED (revised per R7, R11)
Decision: Entry links to detail routes may attach `location.state.from` as an **internal router-location structure** (`{pathname, search, hash?}`), never a raw string. Context-return state is treated as ephemeral, non-portable, optional, untrusted input — no guarantee is stated about refresh survival; therefore a deterministic hierarchy fallback is ALWAYS required. A valid return context must: resolve to a known internal route id, contain no external scheme/host, satisfy the current user's route-access policy, and preserve safe internal `search` (plus `hash` where useful); anything else fails closed to the hierarchy parent. `history.back()` is never used. No open-redirect shape.
Rationale: A6 + Calendar→job requirement (R11); determinism for direct-URL/failed-validation is non-negotiable.
Alternatives rejected: (a) `history.back()` — non-deterministic; (b) raw-string `from` — open-redirect shape; (c) asserting state always survives refresh — overstates the mechanism.
Implementation impact: small `return-context.ts` helper (validate + resolve) + entry-link updates on calendar/overview/lists; no router replacement. Slice 3B.
Regression protection needed: unit tests (valid from / foreign path / unknown route / missing state / access-denied target / query+hash preservation) + one flow test (Calendar → job → return Calendar).

### Decision D8 — Brand is presentational; shell supplies the target

Status: APPROVED (revised per R3, R4, Q1, Q3)
Decision: `DunyaDentalBrand({variant, to})` where variant ∈ `full | login-hero` for the current implementation (`compact` is FUTURE / NOT REQUIRED — Q1). Allowed placements: sidebar → `full` (sole desktop shell brand, Q3), drawer → brand (sole <1024px shell brand context, Q1), login → `login-hero`. No brand in any topbar. The component owns: canonical variant→asset mapping, intrinsic/rendered sizing contract, accessible branding semantics (`Dünya Dental`; linked instance exposes home purpose, e.g. link `aria-label`), and linked-vs-non-linked rendering based on the supplied `to`. It must NOT inspect roles, resolve home policy, or import navigation authorization logic (R4). Concrete rendered sizes are set at implementation from measurement against the layout — no invented pixel norms are stated here (R8).
Rationale: BRAND-01/02/03 + S2; component owns file+size+link so pages can't re-invent; policy stays out.
Alternatives rejected: (a) single-file rule — what matters is canonical mapping, not file count; (b) CSS-only sizing — leaves link/file selection adrift; (c) brand resolving home itself — leaks authorization into presentation (R4); (d) `compact` variant now — Q1 says no new asset.
Implementation impact: component revision (small) + DESIGN.md logo table; placements change in Slice 4. Regression protection needed: variant/placement/link tests; no-`span`-without-link test in shell placements; single-brand-per-context test (D10).

### Decision D9 — Mobile topbar composition: no brand, flexible title, usable actions

Status: APPROVED (revised per Q1, Q2, R8 — matrix simplified, arbitrary rules removed)
Decision: For `<1024px` the topbar carries NO brand (Q1); brand lives in the drawer. Composition priority: ReturnLink context (D6, below-bar line) → readable route title (flexible identity region) → bell + `Menü` at usable target sizes. Matrix:

| Width | Brand in topbar | Route title | Bell | Menü | Return |
|---|---|---|---|---|---|
| ≤360 | none (drawer-only) | flexible identity region, single line, ellipsis only for genuinely long dynamic names | keep usable target | keep usable target | ReturnLink `‹ {label}` line below bar; absent on roots |
| 361–767 | none (drawer-only) | same | keep | keep | same ReturnLink line |
| 768–1023 | none (drawer-only); mobile chrome retained per Q2 (no tablet shell, no breakpoint change) | same | keep | overflow drawer as today | same ReturnLink line |
| ≥1024 (desktop) | none in topbar; sidebar `full` is the sole desktop brand (Q3) | no route title in topbar (R10); PageHeader H1 in content | desktop notification center | n/a | breadcrumb (D5) |

Acceptance rule (R8, no character counts): at supported widths, common static route titles must be readable — at 320px `Genel Bakış` must not degrade to the historical `Ge…` state; no horizontal overflow; actions retain target size; long dynamic entity names may ellipsize. Regression uses actual rendered pixel geometry and representative real titles, never character counts.
Rationale: RESP-01 evidence (brand/title competition was the failure; Q1 removes the competitor); PRODUCT.md one-hand rule.
Alternatives rejected: (a) enlarging the wordmark in-row — proven wrong direction; (b) compact mark in-row now — Q1 defers it; (c) character-count floors — unmeasurable typography (R8).
Implementation impact: `MobileTopBar` recomposition + CSS priority rules; no breakpoint change, no new asset. Slice 4.
Regression protection needed: 320px geometry tests on representative static titles (`Genel Bakış` readable, no overflow), dynamic-name ellipsis test, action target-size tests.

### Decision D10 — At most one prominent shell brand per context

Status: APPROVED (revised per Q1, Q3, R9)
Decision: Desktop ≥1024 → sidebar `full` only, no topbar brand. Mobile/tablet <1024 → drawer brand only, no topbar brand. Login → hero only. `compact` is not part of the current implementation; any future mention is marked FUTURE / NOT REQUIRED FOR SLICE 4.
Rationale: BRAND-02 same-screen duplication; frees topbar space for identity (Q1/Q3).
Alternatives rejected: keeping any topbar brand for "balance" — decoration at identity's expense.
Implementation impact: remove topbar `DunyaDentalBrand` usages (desktop + mobile); drawer heading carries the <1024px brand. Slice 4.
Regression protection needed: single-brand-per-context test.

### Decision D11 — Page-level back cleanup (executed in 3B)

Status: APPROVED
Decision: Classify and migrate per §12: hierarchy cases → breadcrumb/ReturnLink (delete bespoke); genuine context cases → D7 return target; flow-local cases (messaging compose close, follow-up cancel, calendar "today") stay. `İşlere dön` on top-level Users/Staff lists and `AppRouter` fallbacks → deleted (they were never hierarchy). Product detail gains the standard ReturnLink (currently none). No bulk delete before the 3A replacement exists (slice order §13).
Rationale: A4/A5.
Alternatives rejected: deleting all bespoke backs in one pass — orphans routes whose parent metadata isn't migrated yet.

### Decision D12 — Coordinated but separate registries; boundaries (normative)

Status: APPROVED (revised per R3, R4, R12)
Decision: Use COORDINATED BUT SEPARATE registries. The **navigation model** owns: destinations, role/capability filtering, bottom/overflow placement, and landing/home policy (it reuses/extracts the existing canonical landing resolver — overview when eligible/enabled, otherwise jobs — and the shell passes the resolved `to` into the Brand). The **route identity registry** owns: static route identity, deterministic param-aware hierarchy, generic fallback titles, breadcrumb semantics. Navigation entries may reference route-identity ids/titles, but identity must not reimplement authorization, and navigation must not reimplement identity facts. Shared route references are pinned by drift tests (§14). PageHeader owns identity rendering (H1/breadcrumb/ReturnLink/actions slot); Brand is presentational (D8); pages own business content, actions, tabs, filters, entity loading, runtime label supply (D7-mechanism), and flow-local back. Metadata must not import page/business logic; pages must not hand-roll eyebrows, hierarchy back buttons, or document titles.
Rationale: prevents S1/S2/S7 recurrence structurally (R12); home/authorization stay in exactly one place (R3/R4).
Alternatives rejected: merged registry (authorization leaks into identity or vice versa); documenting without tests.
Implementation impact: reviewer checklist + contract/drift tests (§14); no runtime framework.

---

## 5. Route identity contract

Proposed shape (pseudocode, NOT implemented):

```ts
// RouteId cardinality is derived from paths.ts (H1): one id per static route
// with a distinct canonical title/position; one id per dynamic pattern
// (instances share the pattern id; entity names are runtime overlays, H3).
type RouteId =
  // Top-level static routes
  | 'overview' | 'calendar' | 'messages' | 'jobs'
  | 'customers' | 'products' | 'reports' | 'staff' | 'users'
  | 'settings' | 'docs' | 'help'
  // Job creation variants (distinct static paths/titles in paths.ts)
  | 'jobCreateDelivery' | 'jobCreateTask' | 'jobCreateMeeting' | 'followUpCreate'
  // List-creation statics
  | 'customerCreate' | 'productCreate' | 'userCreate'
  // Report sub-routes: distinct static titles → distinct ids (no umbrella)
  | 'reportStaff' | 'reportCustomers' | 'reportDeliveries'
  | 'reportApprovals' | 'reportSalesFollowUp'
  // Settings sections: distinct static titles → distinct ids (no umbrella)
  | 'settingsProfile' | 'settingsSecurity' | 'settingsNotifications'
  | 'settingsApplication' | 'settingsDataManagement'
  | 'settingsDemoData' | 'settingsBackupRecovery'
  // Dynamic patterns: one id per pattern
  | 'jobDetail' | 'customerDetail' | 'contactDetail'
  | 'productDetail' | 'userDetail' | 'staffProfile' | 'staffReport'
  // Shell-external / fallback (no section, R5)
  | 'login' | 'forbidden' | 'notFound';

type RouteParams = Record<string, string>;

type RouteIdentity = {
  id: RouteId;
  /** Generic fallback title: shell label, H1 fallback, breadcrumb fallback, document-title fallback. */
  title: string;
  /** Static deterministic hierarchy parent; null only at roots. */
  parentId: RouteId | null;
  /** Authenticated-shell section vocabulary; OMITTED on shell-external/fallback routes (R5). */
  section?: 'Operasyon' | 'Analiz' | 'Ekip' | 'Destek' | 'Hesap';
  /**
   * Param-aware parent URL builder (R1). Calls canonical builders from
   * paths.ts with current matched params; never duplicates URL templates.
   * Omitted when the parent URL needs no params. Returns null when params
   * are insufficient (caller falls back up the chain).
   */
  parentLocation?: (params: RouteParams) => string | null;
};

/**
 * Runtime resolved-title overlay (R7, ownership H3). The registry never
 * fetches and never imports domain types. A loaded page supplies a plain
 * entity label; ONE identity-resolution layer combines static definition +
 * runtime label + current route params into a single resolved value.
 * All consumers (PageHeader H1, MobileTopBar title, breadcrumb current
 * item, document-title effect) read this same value and MUST NOT
 * independently compute `runtimeLabel ?? staticTitle` per surface.
 * Slice 3A chooses the single mechanism (context, outlet context,
 * provider, or another router-native pattern) after inspecting composition.
 */
type ResolvedRouteIdentity = {
  identity: RouteIdentity;
  /** Entity label supplied by the loaded page; undefined while loading/on error. */
  runtimeLabel?: string;
  /** Effective title: owned by the resolution layer, read by all consumers. */
  effectiveTitle: string;
  /**
   * Return target for the return-context region (H2/D6): the validated
   * context return when present and meaningfully different from the
   * hierarchy parent, otherwise the hierarchy-parent location.
   * `showContextControl` is true only for the desktop conditional control;
   * mobile ReturnLink always renders on nested routes (fallback included).
   */
  returnTarget: { to: string; label: string; showContextControl: boolean };
};
```

Field notes: `id/title/parentId` are the required minimum; `section` only on authenticated-shell routes; `parentLocation` only where the parent URL needs params. Deliberately absent: `homeEligible` (R3), `mobileTitle` (R6), actions, tabs, filters, authorization, fetching, domain types. `titleResolver`-as-domain-model is replaced by the generic `runtimeLabel` overlay: the page passes a string, never a fetcher or entity type, so the shell package stays domain-free. Ownership (H3): the page supplies `runtimeLabel` only; the resolution layer owns combination into `ResolvedRouteIdentity`; every consumer reads — none recomputes.

Implementation verification: the current registry contains **38** identities. Settings data-management children use the hierarchy `settings → settingsDataManagement → settingsDemoData/settingsBackupRecovery`; shell-external login/forbidden/not-found remain outside this authenticated identity registry. Identity matching follows the exact AppRouter pathname shapes and returns null for unknown descendants.

---

## 6. PageHeader contract

```tsx
// Pseudocode — proposed API, not implemented.
<PageHeader
  resolved={resolvedIdentity}     // H3: single resolved value (static + runtime label + params)
  breadcrumb={crumbs}             // D5, desktop only, hierarchy-derived (param-aware URLs)
  description={string}            // optional subtitle/context line
  actions={<>…page-owned…</>}     // passthrough slot; PageHeader never defines actions
/>
// The return-context region reads resolved.returnTarget: mobile renders
// ReturnLink (D6 fallback contract); desktop renders the compact control
// only when showContextControl is true (H2). No separate mobile/desktop props.
```

Ownership: PageHeader renders eyebrow/section (when `section` present), H1 (from `resolved.effectiveTitle` — never recomputed), description, breadcrumb region, return-context region. Pages render tabs/filters/actions below it in documented regions. Pages render `<PageHeader>` (they own composition order), but identity props come from the single resolution layer, so uniformity holds without shell coupling — and without four title sources.

Examples:

- **List** (`/jobs`): eyebrow `Çalışma alanı`, H1 `İşler`, actions = `Yeni iş` menu (page-owned), filters below header (page-owned).
- **Detail** (`/jobs/:id`): breadcrumb `İşler / <label>` (desktop), ReturnLink `‹ İşler` or `‹ Takvim` (mobile, D6/D7), H1 = resolved title, no page actions in header (commands stay in rail).
- **Report** (`/reports/staff`): breadcrumb `Raporlar / Personel`, H1 report name, description = range line, report-nav tabs below (page-owned).
- **Settings** (`/settings/security`): breadcrumb `Ayarlar / Güvenlik`, H1 section name, settings-tabs below (page-owned, existing `SettingsTabs` retained).

---

## 7. Breadcrumb + ReturnLink model

Conventions: `breadcrumb` = hierarchy chain (always); `context return` = validated `from` (sometimes); `return target` = context return ?? hierarchy parent (what ReturnLink uses). Breadcrumb is NEVER context.

- **Jobs → Job Detail** (`/jobs` → `/jobs/:id`): breadcrumb `İşler / <label>`; mobile ReturnLink: referrer list/filter if entered with valid `from` (query preserved), else `‹ İşler`; desktop: NO redundant context control (context collapses to the hierarchy destination — breadcrumb covers it).
- **Calendar → Job Detail → return Calendar**: entry link attaches `from={/calendar?...}`; mobile ReturnLink reads `‹ Takvim`, navigates back with month/query intact; desktop shows breadcrumb `İşler / <label>` PLUS compact context control `Takvime dön` (valid context, meaningfully different from hierarchy); direct-URL load shows the breadcrumb with no context control. The Calendar target is the return target, never "the hierarchy parent"; the Calendar context is never represented as breadcrumb hierarchy.
- **Direct `/jobs/:id`**: breadcrumb `İşler / <label>` (generic `İş detayı` while loading); ReturnLink `‹ İşler`.
- **Reports → report detail** (`/reports` → `/reports/staff`): breadcrumb `Raporlar / Personel`; mobile ReturnLink `‹ Raporlar`; desktop: no context control unless a valid differing context exists.
- **Settings → second-level** (`/settings` → `/settings/security`): breadcrumb `Ayarlar / Güvenlik`; mobile ReturnLink `‹ Ayarlar`. (Closes A3 on both desktop and mobile.)
- **Customer → contact** (`/customers/:id` → `…/contacts/:cid`): breadcrumb `Müşteriler / <müşteri> / <ilgili kişi>` (parent URL via `parentLocation` + `paths.ts` builder); mobile ReturnLink targets the parent customer (or valid context).
- **Staff report** (`/staff/:id/reports`): breadcrumb `Personel / <ad> / Personel raporu` (parent URL via `parentLocation`); mobile ReturnLink targets the profile (or valid context).

---

## 8. Mobile topbar contract

See D9 matrix (§4). Restated minimum behaviors (no brand in any <1024px topbar; no character-count rules):

| Width | Brand | Route title | Bell | Menu | Return |
|---|---|---|---|---|---|
| ≤360 | none (drawer-only) | flexible identity region, single line; static titles readable, no `Ge…` regression | keep usable target | keep usable target | ReturnLink line below bar; absent on roots |
| 361–767 | none (drawer-only) | same | keep | keep | same ReturnLink line |
| 768–1023 | none (drawer-only); mobile chrome retained, no breakpoint change (Q2) | same | keep | overflow drawer | same ReturnLink line |
| ≥1024 | none in topbar; sidebar `full` is the sole desktop brand | no title in topbar; PageHeader H1 in content | desktop center | n/a | breadcrumb |

Title behavior contract (R8): single line; long dynamic entity names may ellipsize; static section titles must render readably at supported widths per actual pixel geometry. The exact historical failure (`Genel Bakış` → `Ge…` at 320px) is the named regression case.

---

## 9. Branding contract

Inventory classification:

- `dunya-dental-sidebar.png` (4538×3210): **canonical full** — sidebar + login hero source (already shared by both variants; keep).
- `dunya-dental.png` (5673×4012): **legacy** — no longer rendered in any topbar after Slice 4; retained only as file-source history unless implementation removes the reference.
- Compact/monogram: **does not exist and is NOT required.** Future branding enhancement may consider one; it must not block Slices 3A/3B/4.

`DunyaDentalBrand` variants (current implementation): `full` (sidebar), `login-hero` (login). Each maps to exactly one canonical file + measured sizing contract + linked-vs-span rendering from the supplied `to` (shell/navigation policy resolves the role-aware home via the extracted landing resolver and passes it in). `aria-label="Dünya Dental"` retained; linked instance exposes home purpose. No invented pixel norms in this package; concrete sizes are set at implementation from measurement.

---

## 10. Title/document-title contract

Single resolved title (static fallback + runtime overlay, §5) feeds all four surfaces — no independent sources.

| Route | Desktop visible | Mobile visible | Semantic H1 | document.title |
|---|---|---|---|---|
| `/jobs` | PageHeader H1 `İşler` (+ no breadcrumb — root; no topbar title) | topbar `İşler`; content H1 semantics | one H1 | `İşler · Dünya Dental` |
| `/jobs/:id` | breadcrumb `İşler / <label>` + H1 (no topbar title) | topbar resolved title (generic `İş detayı` while loading); ReturnLink `‹ İşler`/`‹ Takvim` | one H1 | `<label> · Dünya Dental` |
| `/reports/staff` | breadcrumb `Raporlar / Personel` + H1 (no topbar title) | topbar `Personel` (distinct sub-route identity — new vs today's shared `Raporlar`) | one H1 | `Personel · Dünya Dental` |
| `/settings/security` | breadcrumb `Ayarlar / Güvenlik` + H1 (no topbar title) | topbar `Güvenlik` + ReturnLink `‹ Ayarlar` | one H1 | `Güvenlik · Dünya Dental` |
| `/messages` | H1 `Mesajlar` (column heading renamed to non-H1 to end ×3; no topbar title) | topbar `Mesajlar`; content H1 semantics | one H1 | `Mesajlar · Dünya Dental` |
| direct URL / loading | generic kind title | same | one H1 | generic kind title |

---

## 11. Responsibility matrix

| Layer | Owns | Does NOT own |
|---|---|---|
| Route identity registry (D1) | static identity facts: id/title/parentId/parentLocation; generic fallback titles; breadcrumb semantics; one key per statically distinct route (H1) | actions, tabs, filters, authorization, home/landing policy, fetching, domain types, runtime combination |
| Identity-resolution layer (H3, new) | combining static identity + runtime label + params into the single `ResolvedRouteIdentity`; breadcrumb-current and return-target derivation inputs | fetching, domain types, rendering, authorization |
| Navigation model | destinations, role/capability filtering, bottom/overflow placement, landing/home policy (extracted canonical resolver); may reference identity ids/titles | identity facts, hierarchy derivation, title strings |
| AppShell | viewport switch, drawer + focus trap/restore, composing topbar/bottom-nav/content, document-title effect wiring (reads resolved identity), resolving home target and passing `to` to Brand | title text decisions, return targets, brand sizing/variant mapping, title recomputation |
| PageHeader (D2) | H1 (reads `resolved.effectiveTitle`), eyebrow, description, breadcrumb region, return-context region (mobile ReturnLink + conditional desktop control), actions passthrough slot | business actions definition, tabs/filters ownership, authorization, title/context recomputation |
| DunyaDentalBrand (D8) | variant→file map, sizing contract, accessible semantics, linked-vs-span rendering from supplied `to` | placement decisions, home/role policy, navigation authorization |
| Page/route | business content, actions + pending states, tabs, filters, entity loading + plain-string runtime label supply only, flow-local back (compose-close, cancel) | hand-rolled eyebrows for hierarchy, bespoke hierarchy back buttons, own document.title strings, own brand sizing, per-surface title fallback logic |

---

## 12. Migration map

Slice assignment per §13 (3A foundation → 3B navigation migration → 4 shell cleanup):

- **3A — Replaced:** `resolveShellTitle`/`resolveShellBackTo` if-chains → registry lookups; `resolveDocumentTitle` fork → unified resolved-title pattern; `route-identity-heading` sr-only hack → single-source rule foundation.
- **3A — Retained:** `buildNavigationModel` destinations/role filtering/bottom/overflow/landing (landing resolver extracted for reuse, behavior unchanged).
- **3B — Replaced:** `MobileTopBar backTo` prop → PageHeader ReturnLink region; bespoke `back-link`/`Listeye dön`/`Müşterilere dön`/`{X} kaydına dön` hierarchy buttons → breadcrumb/ReturnLink; `İşlere dön` on Users/Staff lists + `AppRouter` fallbacks → deleted; staff-report `backLabel` props → D6/D7; desktop `desktop-shell-title` duplication → removed (PageHeader authoritative).
- **3B — Retained:** `FollowUpBreadcrumb` (tracking-chain, documented exception); messaging flow-local back; follow-up cancel/return buttons; calendar "today"; `SettingsTabs`; report tabs/filters composition.
- **3B — Adapted:** report subpages + settings L2 gain distinct titles/parents/crumbs (new identity, same pages); product detail gains standard ReturnLink; Calendar/overview/list entry links attach valid `from` where context return is desired.
- **4 — Deleted:** desktop topbar brand instance; mobile/tablet topbar brand instance; any remaining duplicate brand/title shell surfaces.
- **4 — Retained:** sidebar `full` brand; drawer brand; login hero; drawer focus trap + restore; `aria-current`; notification center behavior.

---

## 13. Implementation slices (three controlled PRs)

Dependency order: 3A → 3B → 4. 4 may proceed after 3A independently of 3B only if merge sequencing stays safe; preferred order is 3A → 3B → 4.

### Slice 3A — Route identity foundation

Scope: route identity registry (D1 incl. `parentLocation`, optional `section`, full H1 key cardinality); runtime resolved-title mechanism + the ONE identity-resolution layer and its mechanism choice (H3 — context, outlet context, provider, or router-native, decided after inspecting composition); PageHeader component/contract (D2 incl. return-context region); document-title unification reading the resolved value (D4); single-H1/title-source foundation (D3); core contract tests incl. anti-reconstruction tests (no per-surface `runtimeLabel ?? title`). Do NOT yet migrate every bespoke back button.
Goal: establish the SSOT and rendering foundation first.

### Slice 3B — Navigation hierarchy + contextual return migration

Scope: desktop breadcrumbs (D5, hierarchy-only); mobile ReturnLink (D6 fallback contract); desktop conditional context-return control (H2 — only when valid context differs from hierarchy); context-return validator/helper (D7); Calendar → Job return (both viewports); settings/report parent coverage (incl. param-aware parents); route-by-route bespoke hierarchy-back cleanup (D11); stale `İşlere dön` removal; product detail missing return; regression/flow tests.
Depends on 3A.

### Slice 4 — Shell identity + mobile composition

Scope: brand link using shell-supplied role-aware home target (D8/D12); sidebar as sole desktop shell brand; remove desktop topbar brand; remove mobile/tablet topbar brand (D10); mobile title/action recomposition (D9); ≤360 historical title-clipping regression; duplicate-brand/title shell cleanup. No new compact asset.
Depends on 3A (preferred: after 3B).

---

## 14. Regression test plan

- Metadata: every route has title; parent chains terminate at roots; no orphans; sub-routes distinct where required; `parentLocation` outputs equal canonical `paths.ts` builder outputs for representative params; shell-external routes carry no section.
- Granularity (H1): every static path in `paths.ts` with a distinct canonical title maps to its own RouteId (no umbrella id serves two different static titles — `reportStaff` ≠ `reportApprovals`, per-settings-section ids); dynamic instances share their pattern id and differ only by runtime overlay (no generated per-entity ids).
- Single resolved identity (H3): one resolution mechanism exists; PageHeader, MobileTopBar, document-title effect, and breadcrumb builder read the resolved value — tests assert no per-surface fallback reconstruction (e.g. exactly one `?? identity.title`-style combination point).
- Nav↔identity drift: every navigation destination references a known route id; every authenticated-shell route id is reachable or explicitly documented as non-nav (detail/sub-routes); title strings have exactly one source (identity registry) — tests fail on duplicated literals.
- Breadcrumb: chain tests per nested route incl. direct-URL + loading states and parameterized parents; roots render none; breadcrumb never reflects entry context (Calendar → job crumbs `İşler / <label>`).
- Context-return: `from` validation (valid / foreign path / unknown route / missing state / access-denied target / query+hash preservation, fail-closed each); one flow test (Calendar → job → return Calendar with month intact).
- ReturnLink + desktop control: label/target matrix per route (context vs fallback); Calendar case asserts mobile `‹ Takvim` with `İşler / <label>` breadcrumb on the same page; desktop asserts `Takvime dön` present for Calendar entry, absent for Jobs entry and direct URL (no redundant control).
- Direct-URL fallback: deterministic hierarchy parent per nested route.
- Logo → role-aware home per role (incl. STAFF without overview → jobs); shell passes `to`, Brand never resolves policy (import-boundary test: brand module does not import navigation authorization).
- Document title per route class incl. entity/loading states, both display modes.
- Single visible identity per viewport class per route; no shell+content back duplication.
- Geometry (R8): 320px rendered-geometry tests on representative static titles (`Genel Bakış` readable, no `Ge…` regression, no horizontal overflow, action targets intact); dynamic-name ellipsis case; no character-count assertions anywhere.

---

## 15. Open product-owner questions

**NONE for the current Slice 3A / 3B / 4 scope.** Q1–Q3 are resolved (all Option A).

Future note (non-blocking): a compact/monogram brand asset may be considered later as a separate branding enhancement. It is explicitly FUTURE / NOT REQUIRED FOR SLICE 4 and blocks nothing in this package.

---

## 16. Recommended DESIGN.md changes (after approval, not now)

1. **Mobile top bar** (§302–304): `<1024px` no-brand rule; title flexible identity region; bell/`Menü` usable targets; ReturnLink line; 320px `Genel Bakış` readability as the named acceptance case (geometry-based, no character counts).
2. **New `PageHeader` section:** slot contract (eyebrow/title/description/breadcrumb-region/ReturnLink-region/actions-passthrough) + what pages vs shell own.
3. **New `Route identity` section:** registry fields (`id/title/parentId/parentLocation?/section?`), param-aware derivation via `paths.ts`, resolved-title overlay, coordinated-but-separate registries (R12).
4. **New `Breadcrumb & ReturnLink` section:** desktop hierarchy policy (depth ≥ 2, never history); the three concepts (hierarchy parent / context return / return target); `‹ {label}` vocabulary; root behavior.
5. **New `Document title` section:** `{resolved title} · Dünya Dental` unified pattern, generic/loading fallbacks, fork deletion.
6. **New `Brand` section:** variant table (`full`/`login-hero`; `compact` marked FUTURE), placement map (sidebar / drawer / login; no topbar brand), home-link rule (shell-supplied `to`), single-brand-per-context rule. No invented size norms; concrete sizes from implementation measurement.
7. **Layout note:** record the retained 768–1023 mobile chrome + unchanged 64rem breakpoint explicitly (Q2 outcome).
8. **Token-source note (VIS-05 related, no values copied):** declare `servora-visual-tokens.ts` canonical; DESIGN.md palette values marked as descriptive baseline with pointer — resolves the documented drift without re-deciding the palette here.
