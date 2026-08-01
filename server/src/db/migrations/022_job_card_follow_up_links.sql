-- Add the linked follow-up JobCard columns and their database-enforced invariants.
--
-- A follow-up JobCard points at its direct source (parent) JobCard. The source
-- must exist in the same organization and can never be deleted while follow-ups
-- reference it (ON DELETE RESTRICT). The link and the mandatory management
-- instructions are written once at creation and are immutable afterwards
-- (design D15, R25).
--
-- Same-row invariants are enforced here; cross-row rules (completed-source
-- eligibility, chain depth <= 10, same-customer consistency) are enforced in
-- the service layer, not claimed for PostgreSQL alone (no trigger is planned).

ALTER TABLE job_cards
  ADD COLUMN source_job_card_id UUID NULL,
  ADD COLUMN follow_up_instructions TEXT NULL;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_source_fk
  FOREIGN KEY (organization_id, source_job_card_id)
  REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_self_link_check
  CHECK (source_job_card_id IS DISTINCT FROM id);

-- present-iff contract, enforced in BOTH directions:
-- root cards never carry instructions; follow-ups always do.
ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_instructions_check
  CHECK (
    (source_job_card_id IS NULL AND follow_up_instructions IS NULL)
    OR
    (source_job_card_id IS NOT NULL AND follow_up_instructions IS NOT NULL)
  );

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_instructions_length_check
  CHECK (
    follow_up_instructions IS NULL
    OR (
      char_length(follow_up_instructions) BETWEEN 1 AND 4000
      AND follow_up_instructions ~ '[^[:space:]]'
    )
  );

CREATE INDEX job_cards_follow_up_source_idx
  ON job_cards (organization_id, source_job_card_id, created_at DESC)
  WHERE source_job_card_id IS NOT NULL;
