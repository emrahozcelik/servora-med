# JOB-010 release 2c activation — 2026-11-21

Bounded production activation of the JOB-010 assignment acceptance window
(`DECISIONS.md` JOB-010, release 2c), approved by the owner ("merge ve
aktivasyon onayı veriyorum", then root access approval the same day). No
deploy, no migration, no source change, no data rewrite. Exactly one
activation restart. The window was **left enabled**.

## State transition

```text
Before:
JOB_ASSIGNMENT_WINDOW_ENABLED = UNSET (code default false)
2026-11-21 bounded activation:
1 environment line appended: JOB_ASSIGNMENT_WINDOW_ENABLED=true
1 activation restart
0 service error log lines after the restart
0 rollback
After:
JOB-010 window = ENABLED in production
production release remains b0d3341 (PR #472 merge)
```

## Activation identity

- Release before and after: `b0d3341` (deployed by deploy-production run
  `44869720951`, migrations 062–065, smoke/backup/observation PASS).
- Channel: key-only root SSH (no password authentication).
- Environment file `/etc/servora-med/servora-med.env`: byte-exact backup to
  `/root/servora-med-env-backups/servora-med.env.JOB010-activation-20261121T053106Z.bak`;
  atomic replace with ownership `root:servora-med`, mode `0640`; keys 45 → 46;
  diff against the backup is exactly the one appended line.
- First restart attempt: the SSH session timed out before `systemctl restart`
  ran; a read-only re-check proved no restart had happened, then exactly one
  restart was executed.
- Restart: `2026-11-21T08:32:13+03`, `Result=success`, `NRestarts=0`.

## Verification

- The running process environment (`/proc/<MainPID>/environ`) contains
  `JOB_ASSIGNMENT_WINDOW_ENABLED=true`.
- Public `/api/health`: HTTP 200, `status: ok`, `releaseSha: b0d3341`.
- Service journal after the restart: 0 error lines.
- Functional evidence: not yet observed. `job_card_assignment_offers` had no
  rows at activation time because no management assignment had been made
  since; the first offer, deadline and reminder are follow-up observations.

## Effects and rollback

- Staff can no longer `CANCEL` any JobCard; they send a change/termination
  request, and management uses the decision list (D1).
- Rollback: remove the appended line from the environment file (the backup is
  byte-exact) and restart the service once. Offer rows written while enabled
  stay as history.

## Unrelated observation

Public health reported `backup.status` / `providerStatus` = `unavailable` from
about 05:25–05:31 UTC, **before** this restart, while the backups themselves
were `SUCCESS` (postdeploy 05:16 UTC, scheduled 02:30 UTC). The trusted-time
evidence collector exited with status 1 on some health requests. The cause is
not determined and is tracked separately; it is not attributed to this
activation.
