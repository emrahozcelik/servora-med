# Rendered UI evidence workflow

Status: accepted default, 2026-11-05, under [DECISIONS.md UI-003](../../DECISIONS.md#ui-003-default-rendered-ui-evidence-workflow).
Applies to all agents and contributors performing UI design, visual reviews or
visual implementation. [AGENTS.md](../../AGENTS.md) owns engineering discipline;
UI-001, [DESIGN.md](../../DESIGN.md), [PRODUCT.md](../../PRODUCT.md) and the
applicable feature contract remain authoritative.

## 1. Default method

Use **Playwright + headless Chromium**, a local Vite server and deterministic
synthetic data to capture the **actual React components**. Prefer the existing
repository runners and installed dependencies. Computer Use is not the default.
An explicit user request takes precedence; otherwise document a concrete tool or
environment limitation before using another method. Existing fresh captures may
support a documentation review; identify their source and do not claim a new run.

Render production CSS, canonical tokens, fonts/assets and the owned Ant provider.
For page composition and responsive navigation, include the actual App/AppShell,
router and relevant providers. A focused component fixture is appropriate for
an isolated component question, but does not verify the shell or full page.
Inspect `web/src/main.tsx` as well as App: `ServoraAntProvider` is mounted outside
App there. Mounting App alone does not reproduce the production Ant theme/locale.
Do not recreate the screen as hand-written HTML or copied JSX and call it evidence
of the implementation. Concept sketches may supplement rendered evidence.

Discover relevant components through Codebase Memory when available, then verify
them against the checkout. Its graph is advisory; follow AGENTS.md's no-reset and
no-reindex rule. Reuse existing fixtures before creating a small surface-specific
entry point; this workflow does not require a new generic harness or dependency.

## 2. Fixture integrity

- Use fictional medical/dental business records and current DTO shapes, enum
  values, permissions and capability flags. Keep sample data outside production
  paths. Do not weaken authentication, parsers or backend checks to render a page.
- Prefer typed fixtures and existing parsers/builders. Check cross-response
  consistency: counts and breakdowns reconcile, pagination totals agree, related
  records belong to the same customer, and identities/roles/dates match the story.
  Reusing an old smoke fixture is not proof that its data is still representative.
- Separate a plausible everyday baseline from long names, huge values, missing
  fields, many rows and other stress cases. Label each case. A deliberate error
  scenario must not silently become the ordinary product example.
- Fix or record the clock, timezone, locale, viewport, motion preference and data
  seed. Keep historical periods explicit when testing them; relative dates must
  remain reproducible. Use the same data and environment for before/after captures.
- Mock at the API boundary or pass data through actual component props. Keep
  requests local and synthetic. Fail on unexpected API calls and unexpected
  mutations; explicitly mocked actions may exercise UI states without real writes.
- Mark auth, permission, realtime and other services that are mocked or disabled.
  A synthetic role proves presentation for that role, not authorization enforcement.

## 3. Capture matrix and readiness

Start with the target surface's mobile and desktop baseline. Choose additional
cases from the change; record omitted cases instead of claiming whole-app coverage.

| Dimension | Baseline or affected cases |
| --- | --- |
| Viewport | 390 px mobile and 1440 px desktop; record height, usually 844/960 px |
| Responsive transitions | 768/1024 px and the affected container breakpoint; account for sidebar width |
| Reflow and text | 320 px reflow probe and 200% text enlargement, plus UI-001's applicable zoom acceptance |
| Role | Every role/capability combination whose visible UI changes; Admin does not stand in for Manager or Staff |
| State | Populated baseline, empty/loading/error/retry; long content, disabled/pending and destructive confirmation when touched |
| Interaction | Relevant menu/disclosure/tab open state, keyboard focus/return and mobile touch targets |

Wait for a scenario-specific ready condition: expected data/identity, settled
loading state, fonts and relevant assets. Do not swallow a readiness timeout.
Capture an intentional loading state as a named case. Record page errors,
unexpected requests and unexpected alerts; an expected error-state alert is not
a failed baseline. Do not suppress a broken page merely to obtain a screenshot.

Capture **viewport screenshots** for first-screen hierarchy and sticky chrome;
add full-page captures for page flow. Scroll to relevant controls when checking
fixed headers/footers. A fixed bar appearing midway through a full-page PNG is
not, by itself, proof that the UI permanently obscures content.

## 4. Inspect the rendered result

Open and inspect the PNGs. A successfully written image or zero document overflow
does not establish visual quality. Check primary task visibility, hierarchy,
spacing, typography, labels, metadata, action priority and use of semantic color.

Use geometry where relevant to detect component clipping, broken header words,
button bounds and target sizes. Check which layout is actually visible at the
available content width. Do not force a desktop table solely from viewport width.
Shorter pages and more rows per screen are not success criteria if task access,
readability or the product's 44 px interaction-target guidance deteriorate.

Exercise affected controls with keyboard and appropriate touch emulation. A
320 px viewport is a reflow probe, and `html { font-size: 200%; }` is text-size
simulation; neither is proof of real 400% browser zoom. Report the exact method.
Chromium emulation is not physical-device or Safari/WebKit evidence. Screenshots
do not replace UI-001's keyboard, focus, contrast, zoom, motion and accessibility
completion requirements; explicitly record unexecuted acceptance checks.

For visual iteration, batch relevant cases into an initial inspection, address
confirmed findings together, and use one confirmation pass. Broaden or repeat only
for a new change, a failure or an unresolved concern. Follow the applicable skill's
bounded-pass requirements and user constraints, including delegation restrictions.

## 5. Evidence and handoff

For each evidence bundle record:

- source commit and any relevant uncommitted source diff; do not label a modified
  working tree as verified solely by its base SHA;
- runner/fixture paths, exact command, browser version when available, date,
  viewport dimensions, roles, scenario, locale/timezone/clock and mocked services;
- screenshots and checks with `passed`, `failed` or `not run`, plus known limitations;
- observations separately from recommendations and proposed acceptance criteria.

Use a task-owned temporary output directory while iterating. Retain the small
set of final evidence needed for the review in the repository's evidence area
or a durable linked artifact, with enough fixture/runner information to reproduce
it. A report should not depend only on an expiring `/tmp` path. Do not commit
browser caches, node_modules, unrelated evidence or sensitive data. Close only
the local server/browser processes created for the task.

Documentation-only reviews stay documentation-only. For implementation, run the
applicable checks from AGENTS.md and the feature contract. A visual fixture run
does not substitute for domain, backend or integration verification.

## Existing starting points

- [Application visual slices runner](../../web/scripts/visual-improvements-smoke.mjs)
  and [typed data](../../web/scripts/visual-improvements-fixture.ts): real
  profile, customer, product, form and job pages with reconciled data, role-specific
  actions, reflow probes and mocked interaction states. Its development WebSocket
  is bound to the fixture's own HTTP server so concurrent tools do not share a port.
- [Job creation runner](../../web/scripts/job-create-ui-smoke.mjs): the three
  primary create forms, customer side-flow, product quantity reflow and keyboard checks.
- [Reports runner](../../web/scripts/reports-ui-smoke.mjs) and
  [fixture](../../web/scripts/reports-ui-fixture.tsx): real reports components,
  synthetic data, responsive geometry and interactions. They are examples,
  not proof that every surface/state is covered.
- [Responsive smoke runner](../../web/scripts/responsive-smoke.mjs): existing
  responsive checks. Review each fixture's data before using it as a design baseline.
- [2026-11-05 preserved review evidence](../evidence/visual-review-20261105/README.md):
  real App/AppShell captures, with known data and readiness limitations. The
  archived runner is historical evidence, not the template to copy unchanged.

Example for the existing reports runner, from the repository root:

```bash
cd web
servora_capture_dir="$(mktemp -d /tmp/servora-reports-ui.XXXXXX)"
REPORTS_CAPTURE_DIR="$servora_capture_dir" node scripts/reports-ui-smoke.mjs
```

Select the runner for the surface under review; running this example does not
verify unrelated customer, product or staff-profile pages.
