-- Engagement sub-kind for SALES_MEETING JobCards (sales meeting, visit, demo, etc.).
-- Non-meeting job types must keep engagement_kind NULL.

ALTER TABLE job_cards
  ADD COLUMN engagement_kind VARCHAR(40);

UPDATE job_cards
SET engagement_kind = 'SALES_MEETING'
WHERE type = 'SALES_MEETING';

ALTER TABLE job_cards
  ADD CONSTRAINT job_cards_engagement_kind_check CHECK (
    (
      type = 'SALES_MEETING'
      AND engagement_kind IS NOT NULL
      AND engagement_kind IN (
        'SALES_MEETING',
        'CUSTOMER_VISIT',
        'PRODUCT_DEMO',
        'TRAINING',
        'FOLLOW_UP',
        'OTHER'
      )
    )
    OR
    (
      type <> 'SALES_MEETING'
      AND engagement_kind IS NULL
    )
  );
