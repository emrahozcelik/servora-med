# Ant Design Foundation Implementation Plan

> **For Codex:** Execute this plan inline with `superpowers:executing-plans`, preserving the task order and the red-green-refactor checkpoints.

**Goal:** Add the approved, exact-pinned Ant Design provider foundation without changing Servora-Med screens, navigation, domain behavior, or API contracts.

**Architecture:** `DESIGN.md` remains the visual source of truth. A single `ServoraAntProvider` at the React root owns `ConfigProvider`, Turkish locale, `prefixCls`, popup placement, motion preference, and Ant Design `App`. Only modules under `web/src/ui/antd/` may import Ant Design; feature code consumes the owned boundary and `useAppFeedback`.

**Tech Stack:** React 19.2.7, Vite 8.1.4, TypeScript 5.9.3, Vitest 4.1.10, jsdom 28.1.0, Ant Design 6.5.1.

**Approved scope:** PR A from `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`. PR B shell and screen work is explicitly excluded.

**Version evidence (18 July 2026):** The npm `latest` dist-tag and package version both resolve to `6.5.1`; peer dependencies accept React and React DOM `>=18.0.0`. The official 6.5.1 changelog dated 13 July 2026 contains responsive and reduced-motion fixes relevant to the selected future primitives. The dependency must be saved without a range.

---

### Task 1: Pin the reviewed dependency

**Files:**

- Modify: `web/package.json`
- Modify: `web/package-lock.json`

- [ ] **Step 1: Install the exact stable release**

Run: `cd web && npm install --save-exact antd@6.5.1`

Expected: `dependencies.antd` is exactly `6.5.1`, the lockfile root entry is exactly `6.5.1`, and npm audit reports no vulnerabilities.

- [ ] **Step 2: Verify the resolved package contract**

Run: `cd web && npm ls antd react react-dom`

Expected: `antd@6.5.1` resolves once and accepts the existing React 19.2.7 pair without peer dependency errors.

- [ ] **Step 3: Keep the change dependency-only**

Run: `git diff -- web/package.json web/package-lock.json`

Expected: only the exact dependency and npm-resolved lock graph change; no unrelated script or package version moves.

### Task 2: Specify the provider, token, locale, motion, and feedback contracts first

**Files:**

- Create: `web/tests/antd-foundation.test.tsx`

- [ ] **Step 1: Write the failing provider contract tests**

Add jsdom tests that import the not-yet-created owned boundary and prove:

- `ServoraAntProvider` renders a real signed-out `App` route without changing its login heading.
- a probe beneath the provider observes `servora-ant` through `ConfigProvider.ConfigContext.getPrefixCls()`.
- the configured locale is the Turkish locale (`tr`).
- a probe calling `useAppFeedback()` receives context-bound `message`, `notification`, and `modal` APIs.
- the popup-container policy resolves to `document.body`.

- [ ] **Step 2: Write token and contrast contract tests**

Use Ant Design's public `theme.getDesignToken(servoraAntTheme)` API and local test-only WCAG luminance helpers. Assert the resolved contract:

```text
colorPrimary       #00628E
colorText          #1E252B
colorTextSecondary #535C65
colorBgBase        #F8FBFC
colorBgContainer   #F8FBFC
colorBorder        #CAD2D8
colorError         #902822
colorWarning       #603C07
colorSuccess       #1D4E2B
colorInfo          #00507C
controlOutline     #0084C3
borderRadius       10
controlHeight      44
fontSize           16
```

Assert at least 4.5:1 for normal text pairs and at least 3:1 for the focus indicator pair listed in `docs/ui/SERVORA-UI-ARCHITECTURE.md`. Assert the reduced-motion theme variant sets `motion` to `false` while leaving the canonical base theme immutable.

- [ ] **Step 3: Run the focused test and observe RED**

Run: `cd web && npm test -- --run tests/antd-foundation.test.tsx`

Expected: FAIL because `src/ui/antd` does not exist. The failure must be an import/contract absence, not a test syntax error.

### Task 3: Implement the smallest owned Ant Design boundary

**Files:**

- Create: `web/src/ui/antd/servora-ant-theme.ts`
- Create: `web/src/ui/antd/ServoraAntProvider.tsx`
- Create: `web/src/ui/antd/useAppFeedback.ts`
- Create: `web/src/ui/antd/index.ts`

- [ ] **Step 1: Implement the canonical theme adapter**

Export a typed `servoraAntTheme: ThemeConfig` containing the approved sRGB bridge and sizing/type tokens. Keep semantic supporting backgrounds exported as owned constants for future adapters, but do not create unused component adapters or CSS overrides. Use a restrained raised-layer shadow only; do not introduce Layout, Menu, Card, charts, dark mode, or compact algorithm configuration.

- [ ] **Step 2: Implement reduced-motion derivation without mutating the base theme**

Export `getServoraAntTheme(reducedMotion: boolean)`. Return the stable base object when false; when true, return a copy whose token includes `motion: false`. `ServoraAntProvider` must initialize safely for SSR and subscribe to `window.matchMedia('(prefers-reduced-motion: reduce)')` after mount when available.

- [ ] **Step 3: Implement the single provider boundary**

Compose in this order:

```tsx
<ConfigProvider
  prefixCls="servora-ant"
  locale={trTR}
  theme={resolvedTheme}
  getPopupContainer={getServoraPopupContainer}
>
  <AntApp>{children}</AntApp>
</ConfigProvider>
```

Import Turkish locale directly from `antd/es/locale/tr_TR` as recommended by the official Vite locale guidance. Keep `document` access inside the popup callback and return `document.body`; this records the viewport-level portal policy without changing current shell behavior.

- [ ] **Step 4: Implement context-bound feedback**

`useAppFeedback()` must call `AntApp.useApp()` and return its `message`, `notification`, and `modal` APIs. Do not expose or use Ant Design static feedback methods.

- [ ] **Step 5: Export only the reviewed foundation surface**

`index.ts` exports the provider, prefix/popup constants needed by tests, theme adapter, semantic background constants, and feedback hook. It must not re-export raw Ant Design primitives.

- [ ] **Step 6: Run the focused test and observe GREEN**

Run: `cd web && npm test -- --run tests/antd-foundation.test.tsx`

Expected: PASS with all provider, locale, feedback, token, contrast, popup, and motion assertions green.

### Task 4: Wire the provider into the production root

**Files:**

- Modify: `web/src/main.tsx`
- Modify: `web/tests/antd-foundation.test.tsx`

- [ ] **Step 1: Add the failing root-wiring assertion**

Add a source-contract assertion that `src/main.tsx` imports `ServoraAntProvider` from `./ui/antd` and wraps the existing `BrowserRouter`/`App` tree. The test must not require a browser bootstrap or duplicate app-root component.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `cd web && npm test -- --run tests/antd-foundation.test.tsx`

Expected: FAIL only on missing root wiring.

- [ ] **Step 3: Wrap the existing application tree**

Add `ServoraAntProvider` inside `StrictMode` and outside `BrowserRouter`. Preserve the existing router, `App`, stylesheet import, root-element guard, and render behavior exactly.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run: `cd web && npm test -- --run tests/antd-foundation.test.tsx`

Expected: PASS.

### Task 5: Enforce the import and static-feedback boundary

**Files:**

- Create: `web/tests/antd-boundary.test.ts`

- [ ] **Step 1: Write the architecture test**

Recursively inspect production `.ts` and `.tsx` files under `web/src`. Fail when a file outside `src/ui/antd/`:

- imports from `antd` or an `antd/` subpath;
- calls Ant Design static `message`, `notification`, or `Modal` APIs.

Also assert the owned boundary does not re-export raw primitives. Tests may import Ant Design directly to probe provider behavior; production feature code may not.

- [ ] **Step 2: Run the boundary test**

Run: `cd web && npm test -- --run tests/antd-boundary.test.ts`

Expected: PASS; only owned boundary files contain production Ant Design imports.

- [ ] **Step 3: Run both foundation tests**

Run: `cd web && npm test -- --run tests/antd-foundation.test.tsx tests/antd-boundary.test.ts`

Expected: PASS.

### Task 6: Make the approved design and implementation records current

**Files:**

- Modify: `DESIGN.md`
- Modify: `docs/ui/SERVORA-UI-ARCHITECTURE.md`
- Modify: `docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`

- [ ] **Step 1: Amend the design-system component policy**

Replace the obsolete lifecycle statement that no new dependency exists. Record that Ant Design 6.5.1 is exact-pinned, `DESIGN.md` remains canonical, feature imports go through `web/src/ui/antd`, ConfigProvider/App are paired, and Layout/Menu/Card/form migration is not part of the foundation. Record Turkish locale, `servora-ant`, context-bound feedback, body-level popup policy, and reduced-motion behavior.

- [ ] **Step 2: Mark the architecture decision approved and implemented at foundation level**

Update proposal/future-tense wording only where it is now false. Record 6.5.1 selection and its official changelog review. Do not mark future adapters or PR B-F work implemented.

- [ ] **Step 3: Update PR A checklist and verification record**

Add explicit PR A completion checkboxes and final commands/results after they are actually run. Keep PR B-F pending.

- [ ] **Step 4: Verify documentation claims against the diff**

Run: `git diff --check && git diff -- DESIGN.md docs/ui/SERVORA-UI-ARCHITECTURE.md docs/ui/SERVORA-IMPLEMENTATION-PLAN.md`

Expected: no whitespace errors and no claim that future screen adapters or redesigns exist.

### Task 7: Full verification, bundle measurement, and commit

**Files:**

- Verify all changed files

- [ ] **Step 1: Run the complete web suite**

Run: `cd web && npm test -- --run`

Expected: all existing 508 tests plus the new foundation/boundary tests pass.

- [ ] **Step 2: Build and record the dependency cost**

Run: `cd web && npm run build`

Expected: TypeScript and Vite production build pass. Compare generated JS raw/gzip size with the clean baseline (`496.93 kB` raw, `135.04 kB` gzip) and record the measured delta; do not hide a Vite chunk warning.

- [ ] **Step 3: Re-run server safety checks required by the repository contract**

Run: `cd server && npm run build`

Expected: PASS.

Run: `cd server && npm test -- --run`

Expected: 911 passed and the existing 29 environment-dependent tests skipped; no new failure.

- [ ] **Step 4: Review scope and repository state**

Run: `git status --short && git diff --stat && git diff --check`

Expected: only the dependency, owned boundary, root provider wiring, focused tests, and the three approved documentation records changed. No PR B screen, shell, navigation, domain, server, or API source changes.

- [ ] **Step 5: Commit the verified slice**

Run: `git add DESIGN.md docs/ui/SERVORA-UI-ARCHITECTURE.md docs/ui/SERVORA-IMPLEMENTATION-PLAN.md docs/superpowers/plans/2026-07-18-ant-design-foundation.md web/package.json web/package-lock.json web/src/main.tsx web/src/ui/antd web/tests/antd-foundation.test.tsx web/tests/antd-boundary.test.ts && git commit -m "feat(web): add Ant Design foundation"`

Expected: one surgical English commit on `feature/antd-foundation` with the working tree clean.

- [ ] **Step 6: Follow the branch-finishing workflow**

Use `superpowers:finishing-a-development-branch` to inspect the final diff, publish a draft PR for PR A, and wait for CI. Do not merge and do not begin PR B without user approval.
