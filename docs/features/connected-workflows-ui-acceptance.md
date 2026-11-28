# Connected Workflows UI/UX acceptance gate

Status: required for all new Connected Workflows slices.

## Implementation

- Follow [DESIGN.md](../../DESIGN.md), UI-001, UI-003, UI-005 and subsequent applicable accepted UI decisions in [DECISIONS.md](../../DECISIONS.md). Preserve the current job detail lifecycle order and mobile layout.
- Use `WheelDateTimeField` for every date and time input. Reuse shared time shortcuts and available-slot components.
- Build decision forms with the existing `ReasonDialog`, form controls, status labels and feedback mechanisms. Use one primary action per form. Show conditional fields only for the selected decision.
- Use existing spacing and surface rules. Avoid redundant nested containers and repeated headings. Give each interactive target at least 44 × 44 CSS px.
- Communicate every action outcome through text, a status icon and a semantic status color.

## Rendered evidence required in each UI PR

| Case | Required setting |
| --- | --- |
| Small phone | 320 CSS px viewport |
| Standard phone | 390 × 844 CSS px |
| Tablet | 768 × 1024 CSS px |
| Desktop | 1440 × 900 CSS px |
| Text enlargement | 200% text |
| Reflow | 400% zoom equivalent, using a calibrated CSS viewport |
| Reduced motion | `prefers-reduced-motion: reduce` |

Follow the [UI-003 rendered evidence workflow](../ui/visual-review-workflow.md). Run the actual app entry, AppShell and navigation with production styles. A component fixture provides supplementary evidence. Exercise the open wheel picker, conditional fields, validation errors, pending submission and a successful result in the applicable workflows. Use deterministic synthetic data at the API boundary and identify mocked services.

Link measurements and screenshots in the PR. Record the exact source, viewport, text and zoom methods, motion preference, roles and scenarios. Measure target sizes and horizontal overflow, and verify lifecycle order, keyboard interaction, visible focus and the settled outcome. Compare against the baseline where the PR changes an existing surface. List any missing case before acceptance.

The [RESCUE-003 capture runner](../../web/scripts/connected-workflows-recovery-acceptance.mjs)
runs the real job detail route. From `web/`, set `FLEET_EVIDENCE_DIR` to the
output path and `CONNECTED_VISUAL_SOURCE` to the tested SHA, then run
`node scripts/connected-workflows-recovery-acceptance.mjs`. It captures the
combined transfer form at each required setting and exercises an open wheel,
validation, a calendar rejection, pending submission and the committed receipt
through the real AppShell on a standard phone. For comparison,
run the same script from the baseline checkout's `web/` directory with
`CONNECTED_VISUAL_BASELINE=1`, a separate evidence directory and the baseline SHA.
