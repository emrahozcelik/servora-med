-- OVR-5b (writers): the OVR-4 reminder delivery identity moves from the
-- submission episode to the canonical open incident of that episode.
-- Accepted contract: DECISIONS.md OVR-5 and
-- docs/features/overdue-correction-deadline-and-extension.md (§4.9, §7, §8).
--
-- Migration 066 added
-- `job_card_overdue_notification_deliveries_incident_kind_key`
-- UNIQUE (organization_id, incident_id, kind) *alongside* the 053 per-episode
-- identity so the previous release kept working while OVR-5a was live. OVR-5b
-- writes the ending that starts a new reminder cycle, so the superseded
-- per-episode identity is dropped here; only the incident identity remains.
--
-- The 053 constraint was created inline, so its name is auto-generated. It is
-- located by its exact column list in pg_constraint and the migration fails
-- closed unless exactly one such UNIQUE constraint exists. No row is
-- rewritten: every existing row already satisfies the incident identity (an
-- incident belongs to exactly one episode, and the old key allowed one row per
-- episode and kind).

DO $$
DECLARE
  matched_names TEXT[];
  matched_count INTEGER;
BEGIN
  SELECT COUNT(*)::int,
         COALESCE(ARRAY_AGG(c.conname::text ORDER BY c.conname), ARRAY[]::text[])
    INTO matched_count, matched_names
    FROM pg_constraint c
   WHERE c.conrelid = 'job_card_overdue_notification_deliveries'::regclass
     AND c.contype = 'u'
     AND ARRAY(
       SELECT a.attname::text
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY k.ordinality
     ) = ARRAY['organization_id', 'job_card_id', 'delay_type', 'episode_no', 'kind']::text[];

  IF matched_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one per-episode delivery identity, found % (%)',
      matched_count, matched_names;
  END IF;

  EXECUTE format(
    'ALTER TABLE job_card_overdue_notification_deliveries DROP CONSTRAINT %I',
    matched_names[1]
  );
END
$$;

-- Fail closed: the per-episode identity is gone and the incident identity is
-- still present with its accepted definition.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'job_card_overdue_notification_deliveries'::regclass
       AND c.contype = 'u'
       AND ARRAY(
         SELECT a.attname::text
           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.ordinality
       ) = ARRAY['organization_id', 'job_card_id', 'delay_type', 'episode_no', 'kind']::text[]
  ) THEN
    RAISE EXCEPTION
      'the superseded per-episode delivery identity must be dropped';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'job_card_overdue_notification_deliveries'::regclass
       AND conname = 'job_card_overdue_notification_deliveries_incident_kind_key'
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%(organization_id, incident_id, kind)%'
  ) THEN
    RAISE EXCEPTION
      'job_card_overdue_notification_deliveries must keep the incident delivery key';
  END IF;
END
$$;
