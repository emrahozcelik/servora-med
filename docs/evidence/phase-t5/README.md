# Phase T5 Evidence — Visual Acceptance

**T5A capture source SHA:** `1499b5cc44d5d4cba2cc676770024c257f51812f`
**T5B capture source SHA:** `2432358eef3b1db19e9248d31c6cfcb6fafcc56e`

## Safety

All captures use synthetic users, customers, and JobCards. No real PII, secrets, tokens, coordinates, or notification endpoints.

## T5A — State Adapter Evidence

| File | Scenario | Role | Viewport | State |
|------|----------|------|----------|-------|
| verification-scenario-a.png | JobDetail error (nonexistent job) | STAFF | 1024×768 | ResultState error + retry action |
| verification-scenario-b.png | CustomerList empty (filtered) | MANAGER | 1024×768 | EmptyState with filter-aware text |
| verification-scenario-c.png | ProductDetail not-found | STAFF | 1024×768 | ResultState 404 |

### T5A Results

- workspace-message count: 0 (all scenarios)
- All state adapters render correct semantic HTML
- Heading hierarchy preserved (h1 for full-page, h2 for list)
- role="alert" present on error/404 states
- No horizontal overflow
- Visual-verifier verdict: PASS

## T5B — Responsive Regression Evidence

All smoke:responsive viewport/scale combinations pass with `overflowX: false` (1440, 390, 390-200%, 320-400%, 720 in all push states).

| File | Scenario | Role | Viewport | Text Scale | Result |
|------|----------|------|----------|-----------|--------|
| scenario1-desktop-1440x900.png | Desktop shell (jobs list) | ADMIN | 1440×900 | 100% | scrollWidth=1440, clientWidth=1440, no overflow |
| scenario2-mobile-390x844.png | Mobile shell (bottom nav, top bar) | ADMIN | 390×844 | 100% | scrollWidth=375, clientWidth=375, no overflow |
| scenario-3-200-percent-text-resize.png | Mobile shell, 200% text | ADMIN | 390×844 | 200% | scrollWidth=375, clientWidth=375, no overflow, bottom nav labels intact |
| scenario-4-400-percent-reflow.png | Jobs list, 400% reflow | ADMIN | 320×844 | 200% | scrollWidth=305, clientWidth=305, single column |
| scenario-5-dense-detail.png | Job detail (product delivery) | ADMIN | 390×844 | 100% | scrollWidth=375, clientWidth=375, no overflow |

### T5B Results

- Zero regressions found
- All viewports: scrollWidth === clientWidth (no horizontal overflow)
- 200% text resize: bottom nav labels visible and intact
- 400% reflow: single-column layout, no page-level overflow
- Mobile shell: bottom nav 4 controls with short labels and aria-labels
- Dense detail at 390: all sections visible, action buttons reachable
- workspace-message count: 0 (all scenarios)
- Console errors: 0 (excluding benign favicon 404)
- Responsive smoke test PASS (all combinations)
- Visual-verifier verdict: PASS
