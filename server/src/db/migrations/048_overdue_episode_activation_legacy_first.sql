-- OVR-2R B3: allow a durable activation for the first TRACKED submission
-- episode when legacy WAITING_APPROVAL data has no SUBMITTED fact.
--
-- Migration 047 used an episode_no >= 2 CHECK because modern episode 1 was
-- resolved from started_at. The remediation keeps that fallback for ordinary
-- modern episode 1, while allowing a REQUEST_REVISION or
-- WITHDRAW_FROM_APPROVAL command to persist exact requestTime evidence for a
-- legacy factless re-arm. This does not assert that a historical submission
-- occurred and requires no backfill or incident DML.
--
-- deadline_at terminology note: 047's "nominal business deadline" wording
-- was imprecise for LATE_SUBMISSION. Runtime/API semantics define deadline_at
-- as the first-late boundary (effective deadline + 1ms for submission).

ALTER TABLE job_card_submission_episode_activations
  DROP CONSTRAINT job_card_submission_episode_activations_episode_no_check,
  ADD CONSTRAINT job_card_submission_episode_activations_episode_no_check
    CHECK (episode_no >= 1);
