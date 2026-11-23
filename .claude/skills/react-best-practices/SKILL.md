---
name: vercel-react-best-practices
description: React performance guidelines (Vercel Engineering, scoped for the Servora-Med Vite SPA in web/). Use only for a measured or reported performance problem in web/ (slow render, input lag, waterfall requests, bundle:check budget failure), for a review that explicitly asks for performance, or when a new web/ screen introduces data fetching or large lists. Do not use for ordinary React edits, styling, or server/ code.
license: MIT
metadata:
  author: vercel
  version: "1.0.0"
  upstream: https://github.com/vercel-labs/agent-skills/tree/5a37a6329fbad3666c3207392a6a7c0110e92efb/skills/react-best-practices
  vendored: "2026-11-23"
---

# Vercel React Best Practices (Servora-Med scope)

Performance optimization guide for React applications, maintained by Vercel. Contains 70 rules across 8 categories, prioritized by impact. Servora-Med applies only a subset; read the scope below before any rule.

## Servora-Med scope (binding; overrides the rules below)

Accepted in `DECISIONS.md` UI-006. Servora-Med `web/` is a React 19 + Vite client-side SPA with Ant Design, react-router and no SSR, RSC, Next.js, SWR or React Compiler. `AGENTS.md`, `DECISIONS.md` and the UI-001 skill precedence win over every rule here.

**Do not apply (not our stack):**
- All `server-*` rules, `async-api-routes`, `async-suspense-boundaries` (streaming SSR) and `rendering-hydration-*`.
- `bundle-dynamic-imports` as written (`next/dynamic`). The Vite equivalent is `React.lazy` + `Suspense`, which `web/src/AppRouter.tsx` already uses.
- Any `next.config.js` / `optimizePackageImports` advice.

**Do not add dependencies from these rules.** `better-all` (`async-dependencies`), SWR (`client-swr-dedup`), `lru-cache`, `@vercel/analytics` and similar are examples, not recommendations. Use the dependency-free alternatives. Any new dependency still needs AGENTS.md §10 justification and explicit approval.

**No drive-by performance refactors (AGENTS.md §1).**
- Do not sweep the codebase adding `memo`, `useMemo`, `useCallback`, direct imports or micro-optimizations.
- Apply a rule only to code already in scope for the current task, or when a performance problem is measured (React Profiler, Playwright timing, `npm run bundle:report` / `bundle:check`).
- State the evidence when you apply a rule.
- Do not rewrite Ant Design imports into deep paths. Vite production builds tree-shake antd's ESM entry. Treat barrel import cost as a dev-only concern unless `bundle:report` shows otherwise.

**Behavior and UX rules still win.**
- Optimizations must not change backend-owned truth, loading/success/error states, focus management, accessibility (UI-001: WCAG 2.2 AA, reduced motion) or optimistic-UI rollback safety (AGENTS.md §8).
- `rendering-activity` keeps hidden subtrees mounted. Do not use it where hidden content must reset, or where it would hold stale data or stale focus.
- `rendering-content-visibility` and `client-localstorage-schema` changes on visible screens require UI-003 rendered evidence.
- `client-localstorage-schema`: never store tokens, session IDs or PII in browser storage (AGENTS.md §5).

**Verification.** Every applied change still needs `cd web && npm run build`, relevant tests, and `npm run bundle:check` when bundle rules are involved.

## When to Apply

Reference these guidelines when (within the scope above):
- Investigating a measured performance problem in `web/`
- Reviewing code that explicitly asks for a performance review
- Adding data fetching or large lists to a new `web/` screen
- Investigating a `bundle:check` budget failure

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Eliminating Waterfalls | CRITICAL | `async-` |
| 2 | Bundle Size Optimization | CRITICAL | `bundle-` |
| 3 | Server-Side Performance | HIGH | `server-` |
| 4 | Client-Side Data Fetching | MEDIUM-HIGH | `client-` |
| 5 | Re-render Optimization | MEDIUM | `rerender-` |
| 6 | Rendering Performance | MEDIUM | `rendering-` |
| 7 | JavaScript Performance | LOW-MEDIUM | `js-` |
| 8 | Advanced Patterns | LOW | `advanced-` |

## Quick Reference

### 1. Eliminating Waterfalls (CRITICAL)

- `async-cheap-condition-before-await` - Check cheap sync conditions before awaiting flags or remote values
- `async-defer-await` - Move await into branches where actually used
- `async-parallel` - Use Promise.all() for independent operations
- `async-dependencies` - Use better-all for partial dependencies
- `async-api-routes` - Start promises early, await late in API routes
- `async-suspense-boundaries` - Use Suspense to stream content

### 2. Bundle Size Optimization (CRITICAL)

- `bundle-barrel-imports` - Import directly, avoid barrel files
- `bundle-analyzable-paths` - Prefer statically analyzable import and file-system paths to avoid broad bundles and traces
- `bundle-dynamic-imports` - Use next/dynamic for heavy components
- `bundle-defer-third-party` - Load analytics/logging after hydration
- `bundle-conditional` - Load modules only when feature is activated
- `bundle-preload` - Preload on hover/focus for perceived speed

### 3. Server-Side Performance (HIGH)

- `server-auth-actions` - Authenticate server actions like API routes
- `server-cache-react` - Use React.cache() for per-request deduplication
- `server-cache-lru` - Use LRU cache for cross-request caching
- `server-dedup-props` - Avoid duplicate serialization in RSC props
- `server-hoist-static-io` - Hoist static I/O (fonts, logos) to module level
- `server-no-shared-module-state` - Avoid module-level mutable request state in RSC/SSR
- `server-serialization` - Minimize data passed to client components
- `server-parallel-fetching` - Restructure components to parallelize fetches
- `server-parallel-nested-fetching` - Chain nested fetches per item in Promise.all
- `server-after-nonblocking` - Use after() for non-blocking operations

### 4. Client-Side Data Fetching (MEDIUM-HIGH)

- `client-swr-dedup` - Use SWR for automatic request deduplication
- `client-event-listeners` - Deduplicate global event listeners
- `client-passive-event-listeners` - Use passive listeners for scroll
- `client-localstorage-schema` - Version and minimize localStorage data

### 5. Re-render Optimization (MEDIUM)

- `rerender-defer-reads` - Don't subscribe to state only used in callbacks
- `rerender-memo` - Extract expensive work into memoized components
- `rerender-memo-with-default-value` - Hoist default non-primitive props
- `rerender-dependencies` - Use primitive dependencies in effects
- `rerender-derived-state` - Subscribe to derived booleans, not raw values
- `rerender-derived-state-no-effect` - Derive state during render, not effects
- `rerender-functional-setstate` - Use functional setState for stable callbacks
- `rerender-lazy-state-init` - Pass function to useState for expensive values
- `rerender-simple-expression-in-memo` - Avoid memo for simple primitives
- `rerender-split-combined-hooks` - Split hooks with independent dependencies
- `rerender-move-effect-to-event` - Put interaction logic in event handlers
- `rerender-transitions` - Use startTransition for non-urgent updates
- `rerender-use-deferred-value` - Defer expensive renders to keep input responsive
- `rerender-use-ref-transient-values` - Use refs for transient frequent values
- `rerender-no-inline-components` - Don't define components inside components

### 6. Rendering Performance (MEDIUM)

- `rendering-animate-svg-wrapper` - Animate div wrapper, not SVG element
- `rendering-content-visibility` - Use content-visibility for long lists
- `rendering-hoist-jsx` - Extract static JSX outside components
- `rendering-svg-precision` - Reduce SVG coordinate precision
- `rendering-hydration-no-flicker` - Use inline script for client-only data
- `rendering-hydration-suppress-warning` - Suppress expected mismatches
- `rendering-activity` - Use Activity component for show/hide
- `rendering-conditional-render` - Use ternary, not && for conditionals
- `rendering-usetransition-loading` - Prefer useTransition for loading state
- `rendering-resource-hints` - Use React DOM resource hints for preloading
- `rendering-script-defer-async` - Use defer or async on script tags

### 7. JavaScript Performance (LOW-MEDIUM)

- `js-batch-dom-css` - Group CSS changes via classes or cssText
- `js-index-maps` - Build Map for repeated lookups
- `js-cache-property-access` - Cache object properties in loops
- `js-cache-function-results` - Cache function results in module-level Map
- `js-cache-storage` - Cache localStorage/sessionStorage reads
- `js-combine-iterations` - Combine multiple filter/map into one loop
- `js-length-check-first` - Check array length before expensive comparison
- `js-early-exit` - Return early from functions
- `js-hoist-regexp` - Hoist RegExp creation outside loops
- `js-min-max-loop` - Use loop for min/max instead of sort
- `js-set-map-lookups` - Use Set/Map for O(1) lookups
- `js-tosorted-immutable` - Use toSorted() for immutability
- `js-flatmap-filter` - Use flatMap to map and filter in one pass
- `js-request-idle-callback` - Defer non-critical work to browser idle time

### 8. Advanced Patterns (LOW)

- `advanced-effect-event-deps` - Don't put `useEffectEvent` results in effect deps
- `advanced-event-handler-refs` - Store event handlers in refs
- `advanced-init-once` - Initialize app once per app load
- `advanced-use-latest` - useLatest for stable callback refs

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/async-parallel.md
rules/bundle-barrel-imports.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references

## Vendored contents

Only `SKILL.md`, `metadata.json` and `rules/` are vendored. The upstream compiled `AGENTS.md`, `README.md` and `rules/_template.md` are intentionally omitted. They duplicate the rules or are maintainer-only. A nested `AGENTS.md` would also be read as directory instructions by some agent hosts. Read the individual rule files instead.
