-- 025_messaging_context_ready.sql
-- M2: context-centric Messaging domain model foundation.
--
-- Adds CUSTOMER context, thread titles, the canonical JOB thread invariant,
-- and fixes the latent JOB FK defect (ON DELETE SET NULL conflicted with the
-- JOB-requires-job scope CHECK; JobCards are never physically deleted and the
-- repo convention for job_cards references is ON DELETE RESTRICT).

-- 1. Widen context_type to include CUSTOMER.
ALTER TABLE conversations
  DROP CONSTRAINT conversations_context_type_check,
  ADD CONSTRAINT conversations_context_type_check
    CHECK (context_type IN ('GENERAL', 'JOB', 'CUSTOMER'));

-- 2. Context reference and topic columns.
ALTER TABLE conversations
  ADD COLUMN customer_id UUID,
  ADD COLUMN title VARCHAR(255);

-- 3. Three-way context scope invariant.
--    GENERAL  : neither job nor customer
--    JOB      : job required, customer absent
--    CUSTOMER : customer required, job absent
ALTER TABLE conversations
  DROP CONSTRAINT conversations_job_id_scope_check,
  ADD CONSTRAINT conversations_context_scope_check
    CHECK (
      (context_type = 'GENERAL' AND job_id IS NULL AND customer_id IS NULL)
      OR (context_type = 'JOB' AND job_id IS NOT NULL AND customer_id IS NULL)
      OR (context_type = 'CUSTOMER' AND customer_id IS NOT NULL AND job_id IS NULL)
    );

-- 4. Organization-scoped customer reference. A conversation in organization A
--    can never context-link to a Customer from organization B, and a customer
--    with an operational conversation cannot be silently removed.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_customer_fk
    FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers (organization_id, id) ON DELETE RESTRICT;

-- 5. Fix latent JOB FK defect: SET NULL conflicted with the JOB scope CHECK.
--    JobCards are lifecycle-managed (no physical delete path) and the dominant
--    repo convention for job_cards references is ON DELETE RESTRICT.
ALTER TABLE conversations
  DROP CONSTRAINT conversations_job_fk,
  ADD CONSTRAINT conversations_job_fk
    FOREIGN KEY (organization_id, job_id)
    REFERENCES job_cards (organization_id, id) ON DELETE RESTRICT;

-- 6. CUSTOMER threads are topics: they must carry a meaningful title.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_customer_title_check
    CHECK (
      context_type <> 'CUSTOMER'
      OR (title IS NOT NULL AND length(trim(title)) > 0)
    );

-- 7. A title, when present on any conversation, must not be blank.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_title_blank_check
    CHECK (title IS NULL OR length(trim(title)) > 0);

-- 8. Canonical JOB thread invariant: at most one Messaging conversation per
--    JobCard per organization. Legacy data may hold duplicate JOB rows (one per
--    participant pair before reassignments); fail clearly instead of guessing.
DO $$
DECLARE duplicate_jobs INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_jobs
    FROM (
      SELECT organization_id, job_id
        FROM conversations
       WHERE context_type = 'JOB'
       GROUP BY organization_id, job_id
      HAVING COUNT(*) > 1
    ) duplicates;
  IF duplicate_jobs > 0 THEN
    RAISE EXCEPTION
      '025_messaging_context_ready: % JobCard(s) have multiple JOB conversations; resolve before applying canonical uniqueness',
      duplicate_jobs;
  END IF;
END $$;

CREATE UNIQUE INDEX conversations_job_context_unique
  ON conversations (organization_id, job_id)
  WHERE context_type = 'JOB';
