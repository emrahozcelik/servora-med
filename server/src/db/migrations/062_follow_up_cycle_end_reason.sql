-- JOB-009: a cancelled follow-up visit either schedules a replacement or
-- records why the customer's visit cycle ends. Only the CANCEL command sets
-- this column, and only on a cancelled SALES_MEETING / FOLLOW_UP JobCard.
ALTER TABLE job_cards
  ADD COLUMN follow_up_cycle_end_reason VARCHAR(40),
  ADD CONSTRAINT job_cards_follow_up_cycle_end_reason_check CHECK (
    follow_up_cycle_end_reason IS NULL
    OR (
      follow_up_cycle_end_reason IN (
        'NOT_INTERESTED',
        'WORKS_WITH_COMPETITOR',
        'CUSTOMER_INACTIVE',
        'DUPLICATE_RECORD',
        'OTHER'
      )
      AND type = 'SALES_MEETING'
      AND engagement_kind = 'FOLLOW_UP'
      AND cancelled_at IS NOT NULL
    )
  );
