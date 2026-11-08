# BR5 operational scheduled-health identity selection

Scope: Draft PR #410; implementation candidate; **Codex validation pending**.

## Problem

The backup worker already persists the latest scheduled slot in
`backup_worker_state.last_scheduled_run_id` under a transactional lock. The
health reader previously selected the most recent successful scheduled backup
using `ORDER BY verified_at DESC, created_at DESC`. A later scheduled run can
have smaller timestamps following a legitimate clock rollback. In that case a
previous generation could be misidentified as the latest scheduled proof.

## Change

- The scheduled verified query ranks a verified run matching the **durable
  scheduled pointer** before comparing wall timestamps. Without a matching
  verified row, historical successes are retained in projection for diagnosis.
- Positive scheduled health requires the **same run ID** as the durable
  scheduled pointer and a `SUCCESS` pointer status; a previous successful run
  never authorizes current-slot positive health.
- `latestVerifiedAt` remains a cross-origin, wall-ordered diagnostic field;
  `latestScheduledVerifiedAt` follows the successful durable scheduled run
  when one exists. These two fields may differ after a rollback.
- A newer run with missing proof remains unavailable; it is never rescued by
  an older successful proof. Scheduled FAILED priority remains unchanged.
- The source-owned OT3 positive-health gate remains `BLOCKED`. This change
  does not claim physical 26-hour certainty or approve production activation.

## Non-goals and safety

No changes to jobcards, follow-up workers, delivery timestamps, clocks, R2
integrity, scheduled slot de-duplication, lease fencing, shared TT-A/TT-B,
`elapsedTime()`, `freshness-policy.ts`, format-2/3, migration 061, public
health schema, notification behavior, or production configuration.

## Test handoff

Run the two new `backup-scheduled-failure-ordering-postgres.test.ts` cases
on a disposable PostgreSQL 17 database. The first case must be **RED on
parent** due to `verified_at DESC`, **GREEN on new head** using durable
run ordering; the second must verify missing-proof fail-closed behavior.
Then run the entire scheduled failure ordering, trusted health, health
readiness, backup worker, TT-A/TT-B and relevant restore suites. If an
assertion fails, report rather than auto-modifying implementation.

The previous scheduled-slot rollback fix was independently validated at
`302081bae12923658b96414e27a9441a42ec1dee`. The 27-gate Linux
container CI, physical P1 proof, OT3-C/D qualification and 060→060
continuity remain separate gates.

No merge, production migration or BR5 activation is authorized.
