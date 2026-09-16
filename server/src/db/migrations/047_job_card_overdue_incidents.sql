-- OVR-2: immutable overdue breach / accountability facts.
--
-- A row records that a defined operational deadline was deterministically
-- breached: which delay, which episode, under which governing schedule
-- revision, at which deadline instant, and who was accountable at that
-- instant. Rows are append-only history: deadline/accountability identity
-- fields never change; only the recovery pair may transition NULL -> set,
-- once, by the lifecycle action that actually resolved the breach.
--
-- No backfill: pre-OVR-2 history is UNKNOWN and must not be fabricated, so
-- this migration creates schema only and the table starts empty. Future
-- overdue slices must introduce their own producer contract explicitly.
--
-- Deadline semantics (see modules/job-cards/overdue-incidents.ts):
--   deadline_at = nominal business deadline of the delay episode.
--   breached_at = first instant the episode is BOTH eligible under
--                 lifecycle/revision state AND late under its boundary rule
--                 (max of nominal first-late, eligibility start and revision
--                 activation). Normal cases collapse to equality, but an
--                 episode activated after its nominal deadline (late
--                 acceptance, retroactive schedule revision, re-armed
--                 submission episode) must never backdate before it existed.
--   recorded_at = when the system persisted the fact (DB default metadata).
--   recovered_at = lifecycle action time that resolved the breach
--                  (injected request clock, never an independent clock).

CREATE TABLE job_card_overdue_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  job_card_id UUID NOT NULL,
  delay_type VARCHAR(20) NOT NULL
    CHECK (delay_type IN ('LATE_START', 'LATE_SUBMISSION', 'APPROVAL_WAIT')),
  episode_no INTEGER NOT NULL CHECK (episode_no >= 1),
  schedule_revision_no INTEGER NOT NULL CHECK (schedule_revision_no >= 1),
  deadline_at TIMESTAMPTZ NOT NULL,
  breached_at TIMESTAMPTZ NOT NULL,
  accountable_user_id UUID,
  accountable_role VARCHAR(20) NOT NULL
    CHECK (accountable_role IN ('STAFF', 'MANAGEMENT')),
  accountable_source VARCHAR(30) NOT NULL
    CHECK (accountable_source IN ('ASSIGNMENT_AT_BREACH', 'ROLE_POLICY', 'UNKNOWN')),
  source VARCHAR(20) NOT NULL
    CHECK (source IN ('TRANSITION', 'MUTATION')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recovered_at TIMESTAMPTZ,
  recovery_actor_user_id UUID,
  -- Semantic breach identity: one row per (job, delay, governing revision,
  -- episode). Request replays and competing request paths converge here
  -- instead of duplicating history.
  UNIQUE (organization_id, job_card_id, delay_type, schedule_revision_no, episode_no),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT,
  -- The governing revision must belong to the same org/job: an old breach is
  -- never rebound to a later revision merely because that revision is current.
  FOREIGN KEY (organization_id, job_card_id, schedule_revision_no)
    REFERENCES job_card_schedule_revisions (organization_id, job_card_id, revision_no)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, accountable_user_id)
    REFERENCES users (organization_id, id),
  FOREIGN KEY (organization_id, recovery_actor_user_id)
    REFERENCES users (organization_id, id),
  -- Breach time is never before the nominal deadline (no retroactive
  -- fabrication), but may be later when the episode only became eligible
  -- after it (late acceptance, retroactive revision, re-armed episode).
  CONSTRAINT job_card_overdue_incidents_breach_instant_check
    CHECK (breached_at >= deadline_at),
  -- Recovery is a one-way pair transition: both NULL (open) or both set
  -- (recovered). Never half-populated, never reopened by repository API.
  CONSTRAINT job_card_overdue_incidents_recovery_pair_check
    CHECK (
      (recovered_at IS NULL AND recovery_actor_user_id IS NULL)
      OR (recovered_at IS NOT NULL AND recovery_actor_user_id IS NOT NULL)
    )
);

-- Per-job history reads (breached_at DESC, id DESC).
CREATE INDEX job_card_overdue_incidents_job_time_idx
  ON job_card_overdue_incidents (organization_id, job_card_id, breached_at DESC, id DESC);

-- OVR-2 (reconciliation): durable submission-episode activation.
--
-- Episode 1 is armed by START (job_cards.started_at, first-wins). A later
-- episode is armed only by the transition that re-opened the submission
-- obligation — REQUEST_REVISION or WITHDRAW_FROM_APPROVAL — at its exact
-- requestTime. LATE_SUBMISSION breach derivation reads this row; without
-- it the episode is not attributable (never reconstructed from the
-- previous SUBMITTED fact, mutable updated_at, or DB-clock activity
-- logs). One row per (job, episode): replays and competing request paths
-- converge via UNIQUE, exactly like incidents. Episode 1 is never stored
-- here (started_at already proves it); the CHECK enforces that boundary
-- so an off-by-one arming fails loudly instead of fabricating history.
CREATE TABLE job_card_submission_episode_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  job_card_id UUID NOT NULL,
  episode_no INTEGER NOT NULL CHECK (episode_no >= 2),
  activated_at TIMESTAMPTZ NOT NULL,
  activated_by_command VARCHAR(30) NOT NULL
    CHECK (activated_by_command IN ('REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL')),
  UNIQUE (organization_id, job_card_id, episode_no),
  FOREIGN KEY (organization_id, job_card_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX job_card_submission_episode_activations_job_idx
  ON job_card_submission_episode_activations (organization_id, job_card_id);

-- Fail closed: incident and activation history start empty; history is
-- never backfilled.
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM job_card_overdue_incidents) <> 0 THEN
    RAISE EXCEPTION 'job_card_overdue_incidents must start empty (no historical backfill)';
  END IF;
  IF (SELECT COUNT(*) FROM job_card_submission_episode_activations) <> 0 THEN
    RAISE EXCEPTION 'job_card_submission_episode_activations must start empty (no historical backfill)';
  END IF;
END
$$;
