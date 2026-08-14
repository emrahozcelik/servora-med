-- Persist the mandatory follow-up proposal on the parent (source) JobCard.
--
-- A proposal is written once when the JobCard is submitted for Manager
-- approval (SUBMIT_FOR_APPROVAL) and survives revision loops. It is
-- authoritative for the new mandatory follow-up flow; the legacy
-- job_card_meeting_details.next_follow_up_at remains API/DB compatible but
-- is no longer a competing source of truth.
--
-- present-iff contract: either every proposal column is NULL (no proposal)
-- or a complete, valid proposal exists. Historical WAITING_APPROVAL rows
-- created before this feature legitimately carry NULL and must remain valid
-- (no WAITING_APPROVAL => proposal NOT NULL check is added here; the
-- mandatory rule is enforced in the service transition for new submissions).

ALTER TABLE job_cards
  ADD COLUMN follow_up_proposed_at TIMESTAMPTZ NULL,
  ADD COLUMN follow_up_proposed_type VARCHAR(40) NULL,
  ADD COLUMN follow_up_proposed_assignee UUID NULL,
  ADD COLUMN follow_up_proposal_instructions TEXT NULL,
  ADD COLUMN follow_up_proposal_origin VARCHAR(20) NULL,
  ADD COLUMN follow_up_proposed_by UUID NULL;

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_proposal_present_check
  CHECK (
    (
      follow_up_proposed_at IS NULL
      AND follow_up_proposed_type IS NULL
      AND follow_up_proposed_assignee IS NULL
      AND follow_up_proposal_instructions IS NULL
      AND follow_up_proposal_origin IS NULL
      AND follow_up_proposed_by IS NULL
    )
    OR
    (
      follow_up_proposed_at IS NOT NULL
      AND follow_up_proposed_type IN ('PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING')
      AND follow_up_proposed_assignee IS NOT NULL
      AND follow_up_proposal_instructions IS NOT NULL
      AND char_length(follow_up_proposal_instructions) BETWEEN 1 AND 4000
      AND follow_up_proposal_instructions ~ '[^[:space:]]'
      AND follow_up_proposal_origin IN ('SYSTEM', 'STAFF_ADJUSTED')
    )
  );

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_proposal_assignee_fk
  FOREIGN KEY (organization_id, follow_up_proposed_assignee)
  REFERENCES users (organization_id, id);

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_follow_up_proposal_actor_fk
  FOREIGN KEY (organization_id, follow_up_proposed_by)
  REFERENCES users (organization_id, id);

-- Customer scheduling intelligence lookups:
-- same-Customer ON_SITE conflict windows and recent visit history.
CREATE INDEX job_cards_customer_scheduled_idx
  ON job_cards (organization_id, customer_id, scheduled_at)
  WHERE customer_id IS NOT NULL;

CREATE INDEX job_cards_customer_completed_idx
  ON job_cards (organization_id, customer_id, staff_completed_at)
  WHERE customer_id IS NOT NULL;
