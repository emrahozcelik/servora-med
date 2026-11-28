# RESCUE-003 rendered acceptance

Passed on November 28, 2026, at application commit
`d2bc099d4bd3131228f951d54e425ac24e75d9be`. The capture used Chromium
140.0.7339.186, the Turkish locale, the Europe/Istanbul timezone and a fixed
clock of 2026-11-26T11:00:00Z. The real AppShell and job detail route used
synthetic manager, job, staff and API responses. The capture covers Chromium
emulation.

| Setting | CSS viewport | Transfer form |
| --- | --- | --- |
| Small mobile | 320 × 800 | [Capture](screenshots/small-mobile-transfer.png) |
| Standard phone | 390 × 844 | [Capture](screenshots/phone-transfer.png) |
| Tablet | 768 × 1024 | [Capture](screenshots/tablet-transfer.png) |
| Desktop | 1440 × 900 | [Capture](screenshots/desktop-transfer.png) |
| 200% text | 390 × 844 with twice the root font size | [Primary action](screenshots/text-200-transfer-actions.png) |
| 400% reflow equivalent | 320 × 225 at DPR 4 | [Primary action](screenshots/reflow-400-equivalent-transfer-actions.png) |
| Reduced motion | 390 × 844 with reduced motion enabled | [Capture](screenshots/reduced-motion-transfer.png) |

[Declined assignment on phone](screenshots/declined-assignment-phone-transfer.png)
and [desktop](screenshots/declined-assignment-desktop-transfer.png) covered the
second entry point. [Recovery actions](screenshots/phone-actions.png) and
[navigation checks](measurements.json) used the same AppShell.

The compound action passed with the shared [open wheel picker](screenshots/transfer-wheel-picker.png),
[invalid input](screenshots/transfer-validation.png),
[calendar rejection](screenshots/transfer-calendar-conflict.png),
[pending request](screenshots/transfer-pending.png),
[committed result](screenshots/transfer-success.png) and
[lost response](screenshots/transfer-outcome-unknown.png). Escape returns focus
to the date field. After a lost response, a fresh read restores the other
decisions and the compound write is not retried.
The existing request form was also checked with a [conditional field](screenshots/form-linked-job.png),
[validation](screenshots/form-validation.png), [pending](screenshots/form-pending.png)
and [success](screenshots/form-success.png).

The smallest measured interaction target was 44 × 44 CSS px. The primary
action label scaled from 14 to 28 CSS px and stayed reachable at the text and
reflow settings. No final sample had horizontal page or form overflow. Job
detail lifecycle order and Jobs navigation were preserved against the
`a622916` transfer baseline. The previous regrouping was compared with
`7c8f66d` on main.

- [Final measurements](measurements.json)
- [Transfer baseline comparison](transfer-comparison.json)
- [Main baseline measurements](main-baseline-measurements.json)
- [Main baseline at 200% text](screenshots/main-baseline-text-200-actions.png)
- [Final recovery actions at 200% text](screenshots/text-200-actions.png)
- [Evidence file hashes](artifact-hashes.json)

Run the [capture runner](../../../web/scripts/connected-workflows-recovery-acceptance.mjs)
from `web/` on the application commit.

```sh
FLEET_EVIDENCE_DIR=/absolute/path/to/evidence \
CONNECTED_VISUAL_SOURCE=d2bc099d4bd3131228f951d54e425ac24e75d9be \
node scripts/connected-workflows-recovery-acceptance.mjs
```
