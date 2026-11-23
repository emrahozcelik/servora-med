-- SALE-002 (S2, R9 / accepted Q1): a SALE may be submitted from ACCEPTED.
--
-- 006's `job_cards_started_status_timestamp_check` states "a card in a
-- post-start status has started_at". That invariant described field work with a
-- start instant. A sale is an agreement, not a field interval: SALE-002 D3/Q1
-- allows `ACCEPTED -> WAITING_APPROVAL` (and the later
-- `WAITING_APPROVAL -> IN_PROGRESS` withdraw) without a START, so `started_at`
-- legitimately stays NULL for a SALE. Nothing is fabricated: the accountability
-- facts (STARTED/SUBMITTED), not `started_at`, remain the audit evidence, and a
-- SALE has no schedule/due date (057) that would use `started_at` as a lateness
-- boundary.
--
-- Additive and non-destructive: the relaxed predicate is weaker, so every
-- existing row still satisfies it. No DML, no backfill. 072 must be deployed
-- before the R9 code path is reachable (schema-first, exactly like 057/058/071).

ALTER TABLE job_cards
  DROP CONSTRAINT job_cards_started_status_timestamp_check,
  ADD CONSTRAINT job_cards_started_status_timestamp_check
    CHECK (status NOT IN ('IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED')
      OR started_at IS NOT NULL
      -- SALE-002 R9: a sale may reach a post-start status without START.
      OR type = 'SALE');

-- Fail clearly if the accepted shape is not in place (a partially applied or
-- hand-edited database must not pass silently).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_cards'::regclass
       AND conname = 'job_cards_started_status_timestamp_check'
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%SALE%'
  ) THEN
    RAISE EXCEPTION 'job_cards_started_status_timestamp_check must exempt SALE';
  END IF;
END
$$;
