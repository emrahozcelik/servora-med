-- Add a structured, nullable reason for unsuccessful customer visits.
-- Existing meeting details remain valid; new submissions enforce requiredness
-- in the server domain policy rather than in the database.

ALTER TABLE job_card_meeting_details
  ADD COLUMN unsuccessful_reason_code TEXT;

ALTER TABLE job_card_meeting_details
  ADD CONSTRAINT job_card_meeting_details_unsuccessful_reason_check
    CHECK (unsuccessful_reason_code IS NULL OR unsuccessful_reason_code IN (
      'CONTACT_NOT_AVAILABLE',
      'CONTACT_BUSY',
      'CUSTOMER_UNREACHABLE',
      'REQUESTED_LATER',
      'OTHER'
    ));
