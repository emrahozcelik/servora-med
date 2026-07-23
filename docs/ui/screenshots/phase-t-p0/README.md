# Phase T P0 — RecordDescriptions container reflow

## Before

| Field | Value |
| --- | --- |
| Path | `docs/ui/screenshots/phase-t-baseline/job-detail-1024.png` |
| Viewport | 1024 CSS px |
| Surface | Job detail (sales meeting / visit) |
| Defect | Facts grid crushed / glyph-stacked when viewport is “desktop” but content host is narrow |

## After

| Field | Value |
| --- | --- |
| Path | `docs/ui/screenshots/phase-t-p0/job-detail-1024-after.png` |
| Viewport | 1024 × 900 |
| Simulated host width | ≈576 px (content column under sidebar shell) |
| Selected column count | `1` (`data-column-count="1"`) |
| Synthetic data | Yes — fictional meeting title, clinic, staff labels only |
| Overflow | No horizontal page scroll in capture |

This after image documents the **intended layout contract** (horizontal words, single column under a sub-640 px host at a 1024 viewport). Automated proof of the adapter lives in:

- `web/tests/record-descriptions.test.tsx` (R1–R8, ResizeObserver resize paths)
- `web/tests/job-detail.test.tsx` (delivery / general task / meeting facts order)

## Root cause (fixed)

Viewport `matchMedia('(min-width: 64rem)')` forced Ant `Descriptions` `column=2` even when the real host (sidebar + padding + nested grid) was under ~640 px.

## Fix summary

- Column decision from **host width** via `ResizeObserver`
- Threshold: `RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX = 640`
- Safe default: one column before measure / without ResizeObserver
- `wide` span only when `columns === 2`
