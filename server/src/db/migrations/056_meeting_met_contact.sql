-- CRM Slice 3: person actually met during a SALES_MEETING visit.
--
-- Additive nullable reference to contacts. job_cards.contact_id keeps its
-- historical "planned contact" meaning and is never rewritten; NULL here
-- means "not recorded yet", not "visit failed". The composite FK mirrors
-- the existing job_cards -> contacts reference pattern and prevents dangling
-- or cross-organization references at the database level. Deactivating a
-- referenced contact stays allowed so history is preserved; permanent
-- deletion remains blocked by this FK (23503).
ALTER TABLE job_card_meeting_details
  ADD COLUMN met_contact_id UUID,
  ADD CONSTRAINT job_card_meeting_details_organization_met_contact_fk
    FOREIGN KEY (organization_id, met_contact_id)
    REFERENCES contacts (organization_id, id);

CREATE INDEX job_card_meeting_details_organization_met_contact_idx
  ON job_card_meeting_details (organization_id, met_contact_id);
