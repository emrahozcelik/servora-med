# BR5 OT — Persistent heartbeat high-water and positive-health veto

Status: **implementation candidate, not accepted or deployed**. Parent PR #410
head: `af5a3c3c76f27bdeda79a43ff00fee59eed5a6ca`.

## Mechanism

A verified Chrony sample is written with a UTC wall instant to worker and
scheduler heartbeat columns. Before this patch, a later write from a rolled
back wall clock could overwrite a newer durable heartbeat, erasing the very
evidence of a backward step.

The repository now updates a heartbeat timestamp **and its JSON evidence as
one pair** only when the incoming UTC instant is strictly later. This check
is performed atomically in SQL, under PostgreSQL concurrency, for:

- independent worker heartbeat;
- independent scheduler heartbeat;
- joint worker + scheduler polling;
- scheduler evaluations that consume or block an existing slot;
- successful new-slot enqueue (its scheduler tick must not rewind).

The last scheduled slot identity is unchanged by this work.

The BR5 health reader additionally rejects a **positive candidate** when
its sampled wall instant precedes either durable heartbeat. Missing or
malformed current instant also fails this guard. `workerEnabled=false`
cannot bypass the BR5 liveness check: the reader now requires the worker to
be enabled before a candidate could reach positive admission.

The older `failed` / definitely `stale` classifications remain ahead of
these positive-only checks. Public result vocabulary remains unchanged:
`healthy`, `stale`, `failed`, `unavailable`. No raw clock diagnostics are
published.

## Guarantees and limitations

- This covers an **observed timestamp regression against a persisted high-water
  heartbeat**. It does not detect interior step-and-reverse-step, a step entirely
  before the first sample, a bogus sample with an inflated future time, or
  silent common-clocksource/hypervisor faults.
- High-water marks are only liveness reference points; they are **not** a new
  generation time or a substitute for the immutable dump `before` evidence.
- A forward clock jump may make the heartbeat high-water future relative to a
  corrected wall clock. Positive health stays unavailable until time catches
  up or until a separately authorized, audited recovery procedure is designed.
  Do not reset the heartbeat, scheduled slot or proof as an automatic repair.
- An API worker-enabled flag on one process is **not** an all-node maintenance
  switch. Before a planned step/snapshot operation, the operator must still
  ensure positive BR5 health is suppressed on every serving node; a durable
  all-node maintenance/admission control remains outside this patch.
- The source-owned `evaluateBr5PositiveHealthAdmission()` remains exactly
  `BLOCKED`. No operation here changes it to `QUALIFIED`, and no operator
  may treat the new guard as qualification of OT3-C/OT3-D or as physical
  26-hour proof.
- Existing 26h limit, scheduled-only policy, R2 integrity, lease fencing,
  TT-A/TT-B, format-2 evidence, migration 061 and production configuration
  are not changed.
- Worker heartbeat SQL uses strict `>`: an equal-time sample does not replace
  evidence. If the wall time has not advanced, this conservatively retains the
  existing heartbeat; a later instant can advance it.

## Test matrix for Codex

1. On exact parent (test file only applied temporarily), the new PG17
   heartbeat regression must go RED: rollback overwrites durable timestamp
   and JSON, or the missing SQL guards are otherwise detected.
2. On exact new head, verify individual worker, individual scheduler, joint
   poll and successful enqueue paths all preserve the timestamp + JSON pair
   under rollback, then accept a later timestamp.
3. New unit test checks rollback against either heartbeat, equal/forward
   instant, malformed time and absent reference.
4. Run the full worker PG17, scheduler, scheduled failure-ordering, trusted
   health, health-readiness, TT-A/TT-B, backup/restore and web regression.
5. Independently verify workerDisabled cannot authorize positive BR5 health,
   `evaluateBr5PositiveHealthAdmission() === 'BLOCKED'`, and never modify
   failure priority or public sensitive-field rules.

This is a narrow OT acceptance slice, **not OT-01–OT-32 PASS**, not a
collector replacement, not all-node maintenance, and not permission to merge,
migrate, deploy, use real R2 credentials or activate BR5. Completion of
060→060 continuity and full Linux CI remain separate prerequisites.
