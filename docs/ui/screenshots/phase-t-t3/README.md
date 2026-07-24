# Phase T — T3 visual evidence

Synthetic, PII-free fixtures captured from branch `feat/phase-t-job-detail-decisions-closeout` at head `57a43c7+` (T3E-3 closeout). No production user data, secrets, or real clinic PII.

Capture method: Playwright + local synthetic HTML fixtures using production `web/src/styles.css` and owned `responsive-job-detail-fixture.tsx` (ActivityTimeline). Local harness only; not committed.

| File | Viewport | Route / fixture | Role | Workflow state | T3 slice | Responsive checks | Console | Network |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `jobs-list-390.png` | 390×844 | synthetic Jobs list | STAFF | list / filters | T3A–T3B | single column, action reachability, no H-overflow | clean | clean |
| `jobs-list-1024.png` | 1024×768 | synthetic Jobs list | STAFF | list / filters | T3A–T3B | desktop row hierarchy, filters, no H-overflow | clean | clean |
| `jobs-list-1440.png` | 1440×900 | synthetic Jobs list | STAFF | list / filters | T3A–T3B | wide desktop list, no H-overflow | clean | clean |
| `jobs-board-1440.png` | 1440×900 | synthetic Job board | STAFF | board lanes | T3C | lane headings/cards, no page H-scroll | clean | clean |
| `job-detail-staff-390.png` | 390×844 | synthetic JobDetail staff | STAFF | IN_PROGRESS | T3D/T3E | heading→lifecycle→decision→notes→timeline; targets | clean | clean |
| `job-detail-staff-1024.png` | 1024×768 | synthetic JobDetail staff | STAFF | IN_PROGRESS | T3D/T3E | desktop detail + timeline full-width adapter | clean | clean |
| `job-detail-manager-review-1024.png` | 1024×768 | synthetic manager review + reason dialog open | MANAGER | WAITING_APPROVAL | T3E decision | management-review before actions; dialog focus region | clean | clean |
| `job-detail-revision-390.png` | 390×844 | synthetic revision panel | STAFF | REVISION_REQUESTED | T3E-2A | long unbroken reason wraps; expected-role/next-action | clean | clean |
| `job-detail-terminal-390.png` | 390×844 | synthetic cancelled terminal | STAFF | CANCELLED | T3E-2A | neutral terminal surface; single-column facts | clean | clean |
| `job-detail-notes-long-390.png` | 390×844 | synthetic notes long content | STAFF | notes | T3E-2B | long body/author wrap; composer; pagination chrome | clean | clean |
| `job-detail-timeline-long-1024.png` | 1024×768 | synthetic timeline long content | STAFF | timeline | T3E-2B | long detail/reason/actor; location without coordinates | clean | clean |

## Additional automated browser checks

| Check | Result |
| --- | --- |
| 390 + ~200% text zoom equivalent (`html { font-size: 32px }`) | no page-level horizontal overflow |
| `npm run smoke:responsive` (390/768/1024/1440 + 200% + 400% reflow) | `responsive smoke OK` |
| Coordinates in timeline location copy | none leaked |
| Console error/warning during capture | 0 |
| Network status ≥400 during capture | 0 (fixture-only; no API) |

## Synthetic content

- Users: Ayşe Personel, Emrah Yönetici, Mehmet Personel
- Customer: DentArt Ağız ve Diş Sağlığı, Smile Klinik
- Products: Xenofill Implant Set, ProSeal Membran
- No real phone, email, coordinates, secrets, or production IDs

## Branch proof

- Captured against worktree `phase-t-job-detail-decisions-closeout`
- Starting head for T3E-3: `57a43c7823b05ebab8efe33e0715a93826bb8768`
- Evidence commit lands after this README on the same branch
