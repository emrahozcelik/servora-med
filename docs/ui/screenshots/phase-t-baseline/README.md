# Phase T visual baseline

Synthetic operational captures for **Phase T — Visual Consistency and Screen Polish**.

## Safety rules

All captures must use:

- synthetic user
- synthetic customer
- synthetic JobCard
- synthetic notes

Must **not** contain:

- browser tokens
- API keys
- full geographic coordinates
- real customer or staff identities
- localhost query tokens
- notification push endpoints

When adding captures, re-scan PNG strings for accidental secrets before commit.

## Capture inventory

| File name | Route / surface | Viewport | Role | State | Synthetic data | Defect / acceptance note |
| --- | --- | --- | --- | --- | --- | --- |
| `jobs-1024.png` | Jobs workspace (`/jobs`) | 1024×900 | STAFF | Active list; filters expanded mid layout | Yes — synthetic job titles (e.g. Phase R acceptance synthetic job) | Mid-width filter stack density; pre-T3 baseline |
| `jobs-1440.png` | Jobs workspace (`/jobs`) | 1440×1000 | STAFF | Active list; wide desktop | Yes — synthetic jobs and “Meeting Test Klinik” style labels | Desktop list hierarchy baseline |
| `job-detail-1024.png` | Job detail (sales meeting / visit) | 1024×2961 | STAFF | ACCEPTED / Atandı; workflow + facts + notes | Yes — “Spot-check …”, “Meeting Test Klinik”, “Sezer Dener” pilot personas | **P0 OPEN:** `RecordDescriptions` container reflow / glyph-stack at mid width |
| `job-detail-390.png` | Job detail | 390×3373 | STAFF | Detail after edit; long scroll | Yes — synthetic meeting detail | Compact baseline; action/notes stacking reference |
| `meeting-create-390.png` | Meeting create form | 390×1607 | STAFF | Empty/new create form | Yes — form chrome only | Create-form + mobile chrome baseline |

## Minimum coverage (T0)

| Requirement | Status |
| --- | --- |
| Jobs desktop | Met (`jobs-1024.png`, `jobs-1440.png`) |
| Job detail 1024 with P0 visible | Met (`job-detail-1024.png`) |
| Create/edit form | Met (`meeting-create-390.png`) |
| Compact / mobile | Met (`job-detail-390.png`, `meeting-create-390.png`) |
| `jobs-390.png` | Optional; not a T0 blocker |

## File sizes (approx.)

PNG files in this directory are intentionally modest (roughly 68–184 KB each at T0 seed). Prefer re-export over committing multi‑MB duplicates.

## How to use in later slices

- Treat these as **before** references for T2–T5 and for P0.
- After a geometry-changing fix, add dated or `*-after.png` evidence (P0 uses `docs/ui/screenshots/phase-t-p0/`).
- T5 owns the full 390–1440 + 200% text + 400% reflow review matrix.

Source of first import: 2026-07-23 synthetic pilot spot captures (same fictional content family as historical UI prototypes).
