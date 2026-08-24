import type { Pool } from 'pg';

import type {
  DemoDatasetBlocker,
  DemoDatasetImpactCounts,
  DemoDatasetPreviewData,
  DemoDatasetRecord,
  DemoDatasetRepository,
} from './types.js';

type DemoDatasetRow = {
  id: string;
  organization_id: string;
  dataset_key: string;
  seed_version: string;
  status: 'ACTIVE' | 'PURGED';
  created_at: Date;
  created_by: string;
  purged_at: Date | null;
  organization_name: string;
};

type ImpactCountRow = {
  users: number;
  staff_profiles: number;
  customers: number;
  contacts: number;
  products: number;
  job_cards: number;
  delivery_items: number;
  notes: number;
  confidential_notes: number;
  activities: number;
  follow_ups: number;
  calendar_events: number;
  conversations: number;
  messages: number;
  notifications: number;
  reminders: number;
  realtime_events: number;
};

type BlockerRow = {
  code: string;
  message: string;
  source_type: string;
  source_id: string;
  related_type: string | null;
  related_id: string | null;
};

type PlanKeyRow = {
  plan_key: string;
};

function mapDataset(row: DemoDatasetRow): DemoDatasetRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    datasetKey: row.dataset_key,
    seedVersion: row.seed_version,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    purgedAt: row.purged_at,
  };
}

const DATASET_COLUMNS = `d.id, d.organization_id, d.dataset_key, d.seed_version,
  d.status, d.created_at, d.created_by, d.purged_at, o.name AS organization_name`;

const DATASET_FROM = `
  FROM demo_datasets d
  JOIN organizations o ON o.id = d.organization_id`;

const IMPACT_COUNTS_SQL = `
WITH demo_users AS (
  SELECT id FROM users
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_customers AS (
  SELECT id FROM customers
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_products AS (
  SELECT id FROM products
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_jobs AS (
  SELECT id, source_job_card_id FROM job_cards
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_conversations AS (
  SELECT id FROM conversations
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_calendar_events AS (
  SELECT id FROM calendar_events
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_realtime_events AS (
  SELECT re.id
  FROM realtime_events re
  WHERE re.organization_id = $1
    AND (
      EXISTS (
        SELECT 1
        FROM job_card_activity_logs a
        JOIN demo_jobs j
          ON j.id = a.job_card_id
        WHERE a.organization_id = re.organization_id
          AND a.id = re.source_activity_id
      )
      OR EXISTS (
        SELECT 1
        FROM calendar_event_activity_logs a
        JOIN demo_calendar_events e
          ON e.id = a.calendar_event_id
        WHERE a.organization_id = re.organization_id
          AND a.id = re.calendar_activity_id
      )
      OR EXISTS (
        SELECT 1
        FROM calendar_reminders r
        WHERE r.organization_id = re.organization_id
          AND r.id = re.calendar_reminder_id
          AND (
            r.job_card_id IN (SELECT id FROM demo_jobs)
            OR r.calendar_event_id IN (SELECT id FROM demo_calendar_events)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM messaging_activity_logs a
        JOIN demo_conversations c
          ON c.id = a.conversation_id
        WHERE a.organization_id = re.organization_id
          AND a.id = re.messaging_activity_id
      )
      OR EXISTS (
        SELECT 1
        FROM staff_confidential_notes n
        JOIN demo_users u
          ON u.id = n.staff_user_id
        WHERE n.organization_id = re.organization_id
          AND n.id = re.staff_note_id
      )
    )
)
SELECT
  (SELECT COUNT(*)::int FROM demo_users) AS users,
  (SELECT COUNT(*)::int
     FROM staff_profiles sp
     JOIN demo_users u ON u.id = sp.user_id) AS staff_profiles,
  (SELECT COUNT(*)::int FROM demo_customers) AS customers,
  (SELECT COUNT(*)::int
     FROM contacts c
     JOIN demo_customers customer ON customer.id = c.customer_id
     WHERE c.organization_id = $1) AS contacts,
  (SELECT COUNT(*)::int FROM demo_products) AS products,
  (SELECT COUNT(*)::int FROM demo_jobs) AS job_cards,
  (SELECT COUNT(*)::int
     FROM job_card_delivery_items di
     JOIN demo_jobs j ON j.id = di.job_card_id
     WHERE di.organization_id = $1) AS delivery_items,
  (SELECT COUNT(*)::int
     FROM job_card_notes n
     JOIN demo_jobs j ON j.id = n.job_card_id
     WHERE n.organization_id = $1) AS notes,
  (SELECT COUNT(*)::int
     FROM staff_confidential_notes n
     JOIN demo_users u ON u.id = n.staff_user_id
     WHERE n.organization_id = $1) AS confidential_notes,
  (
    (SELECT COUNT(*)::int
       FROM job_card_activity_logs a
       JOIN demo_jobs j ON j.id = a.job_card_id
       WHERE a.organization_id = $1)
    + (SELECT COUNT(*)::int
         FROM calendar_event_activity_logs a
         JOIN demo_calendar_events e ON e.id = a.calendar_event_id
         WHERE a.organization_id = $1)
    + (SELECT COUNT(*)::int
         FROM messaging_activity_logs a
         JOIN demo_conversations c ON c.id = a.conversation_id
         WHERE a.organization_id = $1)
  ) AS activities,
  (SELECT COUNT(*)::int
     FROM demo_jobs
     WHERE source_job_card_id IS NOT NULL) AS follow_ups,
  (SELECT COUNT(*)::int FROM demo_calendar_events) AS calendar_events,
  (SELECT COUNT(*)::int FROM demo_conversations) AS conversations,
  (SELECT COUNT(*)::int
     FROM messages m
     JOIN demo_conversations c ON c.id = m.conversation_id
     WHERE m.organization_id = $1) AS messages,
  (SELECT COUNT(*)::int
     FROM in_app_notifications n
     JOIN demo_realtime_events re ON re.id = n.source_realtime_event_id
     WHERE n.organization_id = $1) AS notifications,
  (SELECT COUNT(*)::int
     FROM calendar_reminders r
     WHERE r.organization_id = $1
       AND (
         r.job_card_id IN (SELECT id FROM demo_jobs)
         OR r.calendar_event_id IN (SELECT id FROM demo_calendar_events)
       )) AS reminders,
  (SELECT COUNT(*)::int FROM demo_realtime_events) AS realtime_events`;

const BLOCKERS_SQL = `
WITH demo_users AS (
  SELECT id FROM users
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_customers AS (
  SELECT id FROM customers
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_products AS (
  SELECT id FROM products
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_jobs AS (
  SELECT id,
         assigned_to,
         created_by,
         staff_completed_by,
         manager_approved_by,
         revision_requested_by,
         cancelled_by,
         source_job_card_id,
         customer_id
  FROM job_cards
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_conversations AS (
  SELECT id, organization_id, job_id, customer_id
  FROM conversations
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_calendar_events AS (
  SELECT id,
         assigned_user_id,
         created_by,
         updated_by,
         cancelled_by
  FROM calendar_events
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
)
SELECT * FROM (
  SELECT 'DEMO_USER_TO_BUSINESS_CUSTOMER' AS code,
         'Demo personel gerçek müşteriye atanmış.' AS message,
         'USER' AS source_type, u.id AS source_id,
         'CUSTOMER' AS related_type, c.id AS related_id
    FROM demo_users u
    JOIN customers c
      ON c.organization_id = $1
     AND c.assigned_staff_user_id = u.id
     AND c.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_USER_TO_BUSINESS_STAFF_PROFILE',
         'Demo personel gerçek personel profilinin yöneticisi olarak atanmış.',
         'USER', u.id, 'STAFF_PROFILE', sp.id
    FROM demo_users u
    JOIN staff_profiles sp
      ON sp.organization_id = $1
     AND sp.manager_user_id = u.id
    JOIN users staff_user
      ON staff_user.organization_id = sp.organization_id
     AND staff_user.id = sp.user_id
     AND staff_user.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'BUSINESS_STAFF_PROFILE_TO_DEMO_USER',
         'Gerçek personel profilinin yöneticisi demo personel.',
         'STAFF_PROFILE', sp.id, 'USER', u.id
    FROM staff_profiles sp
    JOIN users staff_user
      ON staff_user.organization_id = sp.organization_id
     AND staff_user.id = sp.user_id
     AND staff_user.data_class = 'DEMO'
    JOIN users u
      ON u.organization_id = sp.organization_id
     AND u.id = sp.manager_user_id
     AND u.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'BUSINESS_USER_TO_DEMO_CUSTOMER',
         'Gerçek personel demo müşteriye atanmış.',
         'CUSTOMER', c.id, 'USER', u.id
    FROM demo_customers c
    JOIN customers customer
      ON customer.organization_id = $1
     AND customer.id = c.id
    JOIN users u
      ON u.organization_id = $1
     AND u.id = customer.assigned_staff_user_id
     AND u.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_USER_TO_BUSINESS_JOB',
         'Demo personel gerçek JobCard''a atanmış.',
         'USER', u.id, 'JOB_CARD', j.id
    FROM demo_users u
    JOIN job_cards j
      ON j.organization_id = $1
     AND u.id IN (
       j.assigned_to, j.created_by, j.staff_completed_by,
       j.manager_approved_by, j.revision_requested_by, j.cancelled_by
     )
     AND j.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'BUSINESS_USER_TO_DEMO_JOB',
         'Gerçek personel demo JobCard''a atanmış.',
         'JOB_CARD', j.id, 'USER', u.id
    FROM demo_jobs j
    JOIN users u
      ON u.organization_id = $1
     AND u.id IN (
       j.assigned_to, j.created_by, j.staff_completed_by,
       j.manager_approved_by, j.revision_requested_by, j.cancelled_by
     )
     AND u.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_USER_TO_BUSINESS_CALENDAR_EVENT',
         'Demo personel gerçek takvim kaydına bağlı.',
         'USER', u.id, 'CALENDAR_EVENT', e.id
    FROM demo_users u
    JOIN calendar_events e
      ON e.organization_id = $1
     AND u.id IN (e.assigned_user_id, e.created_by, e.updated_by, e.cancelled_by)
     AND e.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'BUSINESS_CALENDAR_EVENT_TO_DEMO_USER',
         'Demo takvim kaydı gerçek personele bağlı.',
         'CALENDAR_EVENT', e.id, 'USER', u.id
    FROM demo_calendar_events e
    JOIN users u
      ON u.organization_id = $1
     AND u.id IN (e.assigned_user_id, e.created_by, e.updated_by, e.cancelled_by)
     AND u.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_CUSTOMER_TO_BUSINESS_JOB',
         'Demo müşteri gerçek JobCard''a bağlı.',
         'CUSTOMER', c.id, 'JOB_CARD', j.id
    FROM demo_customers c
    JOIN job_cards j
      ON j.organization_id = $1
     AND j.customer_id = c.id
     AND j.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'BUSINESS_CUSTOMER_TO_DEMO_JOB',
         'Demo JobCard gerçek müşteriye bağlı.',
         'JOB_CARD', j.id, 'CUSTOMER', c.id
    FROM demo_jobs j
    JOIN customers c
      ON c.organization_id = $1
     AND c.id = j.customer_id
     AND c.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_PRODUCT_TO_BUSINESS_JOB',
         'Demo ürün gerçek JobCard teslimatında kullanılmış.',
         'PRODUCT', p.id, 'JOB_CARD', j.id
    FROM demo_products p
    JOIN job_card_delivery_items di
      ON di.organization_id = $1
     AND di.product_id = p.id
    JOIN job_cards j
      ON j.organization_id = di.organization_id
     AND j.id = di.job_card_id
     AND j.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'BUSINESS_PRODUCT_TO_DEMO_JOB',
         'Demo JobCard gerçek ürün teslimatında kullanılmış.',
         'JOB_CARD', j.id, 'PRODUCT', p.id
    FROM demo_jobs j
    JOIN job_card_delivery_items di
      ON di.organization_id = $1
     AND di.job_card_id = j.id
    JOIN products p
      ON p.organization_id = di.organization_id
     AND p.id = di.product_id
     AND p.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_JOB_TO_BUSINESS_FOLLOW_UP',
         'Demo JobCard gerçek JobCard''a follow-up ilişkisiyle bağlı.',
         'JOB_CARD', child.id, 'JOB_CARD', source.id
    FROM demo_jobs child
    JOIN job_cards source
      ON source.organization_id = $1
     AND source.id = child.source_job_card_id
     AND source.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_JOB_TO_BUSINESS_FOLLOW_UP',
         'Gerçek JobCard demo JobCard''a follow-up ilişkisiyle bağlı.',
         'JOB_CARD', source.id, 'JOB_CARD', child.id
    FROM demo_jobs source
    JOIN job_cards child
      ON child.organization_id = $1
     AND child.source_job_card_id = source.id
     AND child.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_JOB_TO_BUSINESS_CONVERSATION',
         'Demo JobCard gerçek konuşmaya bağlı.',
         'JOB_CARD', j.id, 'CONVERSATION', c.id
    FROM demo_jobs j
    JOIN conversations c
      ON c.organization_id = $1
     AND c.job_id = j.id
     AND c.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_CONVERSATION_TO_BUSINESS_JOB',
         'Demo konuşma gerçek JobCard''a bağlı.',
         'CONVERSATION', c.id, 'JOB_CARD', j.id
    FROM demo_conversations c
    JOIN job_cards j
      ON j.organization_id = $1
     AND j.id = c.job_id
     AND j.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_USER_TO_BUSINESS_CONVERSATION',
         'Demo personel gerçek konuşmaya katılmış.',
         'USER', u.id, 'CONVERSATION', c.id
    FROM demo_users u
    JOIN conversations c
      ON c.organization_id = $1
     AND c.data_class = 'BUSINESS'
     AND (
       EXISTS (
         SELECT 1 FROM conversation_participants cp
         WHERE cp.organization_id = c.organization_id
           AND cp.conversation_id = c.id
           AND cp.user_id = u.id
       )
       OR EXISTS (
         SELECT 1 FROM messages m
         WHERE m.organization_id = c.organization_id
           AND m.conversation_id = c.id
           AND m.sender_user_id = u.id
       )
       OR EXISTS (
         SELECT 1 FROM messaging_activity_logs a
         WHERE a.organization_id = c.organization_id
           AND a.conversation_id = c.id
           AND a.actor_user_id = u.id
       )
     )
  UNION ALL
  SELECT 'BUSINESS_CONVERSATION_TO_DEMO_USER',
         'Gerçek konuşmaya demo personel katılmış.',
         'CONVERSATION', c.id, 'USER', u.id
    FROM demo_conversations c
    JOIN users u
      ON u.organization_id = $1
     AND u.data_class = 'BUSINESS'
     AND (
       EXISTS (
         SELECT 1 FROM conversation_participants cp
         WHERE cp.organization_id = c.organization_id
           AND cp.conversation_id = c.id
           AND cp.user_id = u.id
       )
       OR EXISTS (
         SELECT 1 FROM messages m
         WHERE m.organization_id = c.organization_id
           AND m.conversation_id = c.id
           AND m.sender_user_id = u.id
       )
       OR EXISTS (
         SELECT 1 FROM messaging_activity_logs a
         WHERE a.organization_id = c.organization_id
           AND a.conversation_id = c.id
           AND a.actor_user_id = u.id
       )
     )
  UNION ALL
  SELECT 'DEMO_CUSTOMER_TO_BUSINESS_CONVERSATION',
         'Demo müşteri gerçek konuşmaya bağlı.',
         'CUSTOMER', customer.id, 'CONVERSATION', c.id
    FROM demo_customers customer
    JOIN conversations c
      ON c.organization_id = $1
     AND c.customer_id = customer.id
     AND c.data_class = 'BUSINESS'
  UNION ALL
  SELECT 'DEMO_CONVERSATION_TO_BUSINESS_CUSTOMER',
         'Demo konuşma gerçek müşteriye bağlı.',
         'CONVERSATION', c.id, 'CUSTOMER', customer.id
    FROM demo_conversations c
    JOIN customers customer
      ON customer.organization_id = $1
     AND customer.id = c.customer_id
     AND customer.data_class = 'BUSINESS'
) blockers
ORDER BY code, source_type, source_id, related_type NULLS FIRST, related_id NULLS FIRST`;

const PLAN_KEYS_SQL = `
WITH demo_users AS (
  SELECT id FROM users
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_customers AS (
  SELECT id FROM customers
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_products AS (
  SELECT id FROM products
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_jobs AS (
  SELECT id FROM job_cards
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_conversations AS (
  SELECT id FROM conversations
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_calendar_events AS (
  SELECT id FROM calendar_events
  WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2
),
demo_realtime_events AS (
  SELECT re.id, re.source_activity_id, re.calendar_activity_id,
         re.calendar_reminder_id, re.messaging_activity_id, re.staff_note_id
  FROM realtime_events re
  WHERE re.organization_id = $1
    AND (
      EXISTS (
        SELECT 1
        FROM job_card_activity_logs a
        JOIN demo_jobs j ON j.id = a.job_card_id
        WHERE a.organization_id = re.organization_id
          AND a.id = re.source_activity_id
      )
      OR EXISTS (
        SELECT 1
        FROM calendar_event_activity_logs a
        JOIN demo_calendar_events e ON e.id = a.calendar_event_id
        WHERE a.organization_id = re.organization_id
          AND a.id = re.calendar_activity_id
      )
      OR EXISTS (
        SELECT 1
        FROM calendar_reminders r
        WHERE r.organization_id = re.organization_id
          AND r.id = re.calendar_reminder_id
          AND (
            r.job_card_id IN (SELECT id FROM demo_jobs)
            OR r.calendar_event_id IN (SELECT id FROM demo_calendar_events)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM messaging_activity_logs a
        JOIN demo_conversations c ON c.id = a.conversation_id
        WHERE a.organization_id = re.organization_id
          AND a.id = re.messaging_activity_id
      )
      OR EXISTS (
        SELECT 1
        FROM staff_confidential_notes n
        JOIN demo_users u ON u.id = n.staff_user_id
        WHERE n.organization_id = re.organization_id
          AND n.id = re.staff_note_id
      )
    )
)
SELECT plan_key
FROM (
  SELECT 'USER:' || u.id::text AS plan_key FROM demo_users u
  UNION
  SELECT 'STAFF_PROFILE:' || sp.id::text
    FROM staff_profiles sp
    JOIN demo_users u ON u.id = sp.user_id
  UNION
  SELECT 'CUSTOMER:' || c.id::text FROM demo_customers c
  UNION
  SELECT 'CONTACT:' || c.id::text
    FROM contacts c
    JOIN demo_customers customer ON customer.id = c.customer_id
    WHERE c.organization_id = $1
  UNION
  SELECT 'PRODUCT:' || p.id::text FROM demo_products p
  UNION
  SELECT 'JOB_CARD:' || j.id::text FROM demo_jobs j
  UNION
  SELECT 'DELIVERY_ITEM:' || di.id::text
    FROM job_card_delivery_items di
    JOIN demo_jobs j ON j.id = di.job_card_id
    WHERE di.organization_id = $1
  UNION
  SELECT 'JOB_NOTE:' || n.id::text
    FROM job_card_notes n
    JOIN demo_jobs j ON j.id = n.job_card_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'STAFF_CONFIDENTIAL_NOTE:' || n.id::text
    FROM staff_confidential_notes n
    JOIN demo_users u ON u.id = n.staff_user_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'JOB_ACTIVITY:' || a.id::text
    FROM job_card_activity_logs a
    JOIN demo_jobs j ON j.id = a.job_card_id
    WHERE a.organization_id = $1
  UNION
  SELECT 'CALENDAR_EVENT_ACTIVITY:' || a.id::text
    FROM calendar_event_activity_logs a
    JOIN demo_calendar_events e ON e.id = a.calendar_event_id
    WHERE a.organization_id = $1
  UNION
  SELECT 'MESSAGING_ACTIVITY:' || a.id::text
    FROM messaging_activity_logs a
    JOIN demo_conversations c ON c.id = a.conversation_id
    WHERE a.organization_id = $1
  UNION
  SELECT 'CALENDAR_EVENT:' || e.id::text FROM demo_calendar_events e
  UNION
  SELECT 'CONVERSATION:' || c.id::text FROM demo_conversations c
  UNION
  SELECT 'MESSAGE:' || m.id::text
    FROM messages m
    JOIN demo_conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = $1
  UNION
  SELECT 'CONVERSATION_PARTICIPANT:' || cp.conversation_id::text || ':' || cp.user_id::text
    FROM conversation_participants cp
    JOIN demo_conversations c ON c.id = cp.conversation_id
    WHERE cp.organization_id = $1
  UNION
  SELECT 'IN_APP_NOTIFICATION:' || n.id::text
    FROM in_app_notifications n
    JOIN demo_realtime_events re ON re.id = n.source_realtime_event_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'CALENDAR_REMINDER:' || r.id::text
    FROM calendar_reminders r
    WHERE r.organization_id = $1
      AND (
        r.job_card_id IN (SELECT id FROM demo_jobs)
        OR r.calendar_event_id IN (SELECT id FROM demo_calendar_events)
      )
  UNION
  SELECT 'REALTIME_EVENT:' || re.id::text FROM demo_realtime_events re
  UNION
  SELECT 'STAFF_PROFILE_USER_EDGE:' || sp.id::text || ':' || sp.user_id::text
    FROM staff_profiles sp
    JOIN demo_users u ON u.id = sp.user_id
  UNION
  SELECT 'STAFF_PROFILE_MANAGER_EDGE:' || sp.id::text || ':' || sp.manager_user_id::text
    FROM staff_profiles sp
    JOIN demo_users u ON u.id = sp.user_id
    WHERE sp.manager_user_id IS NOT NULL
  UNION
  SELECT 'CUSTOMER_ASSIGNED_USER_EDGE:' || c.id::text || ':' || c.assigned_staff_user_id::text
    FROM customers c
    JOIN demo_customers demo_customer ON demo_customer.id = c.id
    WHERE c.assigned_staff_user_id IS NOT NULL
  UNION
  SELECT 'JOB_CUSTOMER_EDGE:' || j.id::text || ':' || j.customer_id::text
    FROM job_cards j
    JOIN demo_jobs demo_job ON demo_job.id = j.id
    WHERE j.customer_id IS NOT NULL
  UNION
  SELECT 'JOB_CONTACT_EDGE:' || j.id::text || ':' || j.contact_id::text
    FROM job_cards j
    JOIN demo_jobs demo_job ON demo_job.id = j.id
    WHERE j.contact_id IS NOT NULL
  UNION
  SELECT 'JOB_USER_EDGE:' || j.id::text || ':' || refs.role || ':' || refs.user_id::text
    FROM job_cards j
    JOIN demo_jobs demo_job ON demo_job.id = j.id
    CROSS JOIN LATERAL (VALUES
      ('assigned_to'::text, j.assigned_to),
      ('created_by'::text, j.created_by),
      ('staff_completed_by'::text, j.staff_completed_by),
      ('manager_approved_by'::text, j.manager_approved_by),
      ('revision_requested_by'::text, j.revision_requested_by),
      ('cancelled_by'::text, j.cancelled_by)
    ) refs(role, user_id)
    WHERE refs.user_id IS NOT NULL
  UNION
  SELECT 'JOB_PRODUCT_EDGE:' || di.job_card_id::text || ':' || di.product_id::text
    FROM job_card_delivery_items di
    JOIN demo_jobs j ON j.id = di.job_card_id
    WHERE di.organization_id = $1
  UNION
  SELECT 'JOB_SOURCE_EDGE:' || child.id::text || ':' || child.source_job_card_id::text
    FROM job_cards child
    JOIN demo_jobs demo_job ON demo_job.id = child.id
    WHERE child.source_job_card_id IS NOT NULL
  UNION
  SELECT 'JOB_ACTIVITY_ACTOR_EDGE:' || a.id::text || ':' || a.actor_id::text
    FROM job_card_activity_logs a
    JOIN demo_jobs j ON j.id = a.job_card_id
    WHERE a.organization_id = $1 AND a.actor_id IS NOT NULL
  UNION
  SELECT 'JOB_NOTE_AUTHOR_EDGE:' || n.id::text || ':' || n.author_id::text
    FROM job_card_notes n
    JOIN demo_jobs j ON j.id = n.job_card_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'STAFF_NOTE_STAFF_EDGE:' || n.id::text || ':' || n.staff_user_id::text
    FROM staff_confidential_notes n
    JOIN demo_users u ON u.id = n.staff_user_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'STAFF_NOTE_AUTHOR_EDGE:' || n.id::text || ':' || n.author_user_id::text
    FROM staff_confidential_notes n
    JOIN demo_users u ON u.id = n.staff_user_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'CALENDAR_EVENT_USER_EDGE:' || e.id::text || ':' || refs.role || ':' || refs.user_id::text
    FROM calendar_events e
    JOIN demo_calendar_events demo_event ON demo_event.id = e.id
    CROSS JOIN LATERAL (VALUES
      ('assigned_user_id'::text, e.assigned_user_id),
      ('created_by'::text, e.created_by),
      ('updated_by'::text, e.updated_by),
      ('cancelled_by'::text, e.cancelled_by)
    ) refs(role, user_id)
    WHERE refs.user_id IS NOT NULL
  UNION
  SELECT 'CALENDAR_ACTIVITY_ACTOR_EDGE:' || a.id::text || ':' || a.actor_user_id::text
    FROM calendar_event_activity_logs a
    JOIN demo_calendar_events e ON e.id = a.calendar_event_id
    WHERE a.organization_id = $1
  UNION
  SELECT 'CONVERSATION_JOB_EDGE:' || c.id::text || ':' || c.job_id::text
    FROM conversations c
    JOIN demo_conversations demo_conversation ON demo_conversation.id = c.id
    WHERE c.job_id IS NOT NULL
  UNION
  SELECT 'MESSAGE_SENDER_EDGE:' || m.id::text || ':' || m.sender_user_id::text
    FROM messages m
    JOIN demo_conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = $1
  UNION
  SELECT 'MESSAGING_ACTIVITY_ACTOR_EDGE:' || a.id::text || ':' || a.actor_user_id::text
    FROM messaging_activity_logs a
    JOIN demo_conversations c ON c.id = a.conversation_id
    WHERE a.organization_id = $1
  UNION
  SELECT 'NOTIFICATION_RECIPIENT_EDGE:' || n.id::text || ':' || n.recipient_user_id::text
    FROM in_app_notifications n
    JOIN demo_realtime_events re ON re.id = n.source_realtime_event_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'NOTIFICATION_EVENT_EDGE:' || n.id::text || ':' || n.source_realtime_event_id::text
    FROM in_app_notifications n
    JOIN demo_realtime_events re ON re.id = n.source_realtime_event_id
    WHERE n.organization_id = $1
  UNION
  SELECT 'REMINDER_JOB_EDGE:' || r.id::text || ':' || r.job_card_id::text
    FROM calendar_reminders r
    JOIN demo_jobs j ON j.id = r.job_card_id
    WHERE r.organization_id = $1
  UNION
  SELECT 'REMINDER_EVENT_EDGE:' || r.id::text || ':' || r.calendar_event_id::text
    FROM calendar_reminders r
    JOIN demo_calendar_events e ON e.id = r.calendar_event_id
    WHERE r.organization_id = $1
  UNION
  SELECT 'REMINDER_RECIPIENT_EDGE:' || r.id::text || ':' || r.recipient_user_id::text
    FROM calendar_reminders r
    WHERE r.organization_id = $1
      AND (
        r.job_card_id IN (SELECT id FROM demo_jobs)
        OR r.calendar_event_id IN (SELECT id FROM demo_calendar_events)
      )
  UNION
  SELECT 'REALTIME_JOB_ACTIVITY_EDGE:' || re.id::text || ':' || re.source_activity_id::text
    FROM demo_realtime_events re
    WHERE re.source_activity_id IS NOT NULL
  UNION
  SELECT 'REALTIME_CALENDAR_ACTIVITY_EDGE:' || re.id::text || ':' || re.calendar_activity_id::text
    FROM demo_realtime_events re
    WHERE re.calendar_activity_id IS NOT NULL
  UNION
  SELECT 'REALTIME_REMINDER_EDGE:' || re.id::text || ':' || re.calendar_reminder_id::text
    FROM demo_realtime_events re
    WHERE re.calendar_reminder_id IS NOT NULL
  UNION
  SELECT 'REALTIME_MESSAGING_ACTIVITY_EDGE:' || re.id::text || ':' || re.messaging_activity_id::text
    FROM demo_realtime_events re
    WHERE re.messaging_activity_id IS NOT NULL
  UNION
  SELECT 'REALTIME_STAFF_NOTE_EDGE:' || re.id::text || ':' || re.staff_note_id::text
    FROM demo_realtime_events re
    WHERE re.staff_note_id IS NOT NULL
) plan_keys
ORDER BY plan_key`;

function mapCounts(row: ImpactCountRow): DemoDatasetImpactCounts {
  return {
    users: row.users,
    staffProfiles: row.staff_profiles,
    customers: row.customers,
    contacts: row.contacts,
    products: row.products,
    jobCards: row.job_cards,
    deliveryItems: row.delivery_items,
    notes: row.notes,
    confidentialNotes: row.confidential_notes,
    activities: row.activities,
    followUps: row.follow_ups,
    calendarEvents: row.calendar_events,
    conversations: row.conversations,
    messages: row.messages,
    notifications: row.notifications,
    reminders: row.reminders,
    realtimeEvents: row.realtime_events,
  };
}

function mapBlocker(row: BlockerRow): DemoDatasetBlocker {
  return {
    code: row.code,
    message: row.message,
    sourceType: row.source_type,
    sourceId: row.source_id,
    relatedType: row.related_type,
    relatedId: row.related_id,
  };
}

export class PostgresDemoDatasetRepository implements DemoDatasetRepository {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async listDatasets(organizationId: string): Promise<readonly DemoDatasetRecord[]> {
    const result = await this.pool.query<DemoDatasetRow>(
      `SELECT ${DATASET_COLUMNS}
       ${DATASET_FROM}
       WHERE d.organization_id = $1
       ORDER BY d.created_at ASC, d.id ASC`,
      [organizationId],
    );
    return result.rows.map(mapDataset);
  }

  async findDataset(organizationId: string, datasetId: string): Promise<DemoDatasetRecord | null> {
    const result = await this.pool.query<DemoDatasetRow>(
      `SELECT ${DATASET_COLUMNS}
       ${DATASET_FROM}
       WHERE d.organization_id = $1 AND d.id = $2`,
      [organizationId, datasetId],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : null;
  }

  async getPreviewData(organizationId: string, datasetId: string): Promise<DemoDatasetPreviewData | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const datasetResult = await client.query<DemoDatasetRow>(
        `SELECT ${DATASET_COLUMNS}
         ${DATASET_FROM}
         WHERE d.organization_id = $1 AND d.id = $2`,
        [organizationId, datasetId],
      );
      const dataset = datasetResult.rows[0];
      if (!dataset) {
        await client.query('COMMIT');
        return null;
      }

      const counts = await client.query<ImpactCountRow>(IMPACT_COUNTS_SQL, [organizationId, datasetId]);
      const blockers = await client.query<BlockerRow>(BLOCKERS_SQL, [organizationId, datasetId]);
      const planKeys = await client.query<PlanKeyRow>(PLAN_KEYS_SQL, [organizationId, datasetId]);
      await client.query('COMMIT');
      return {
        dataset: mapDataset(dataset),
        organizationName: dataset.organization_name,
        affectedCounts: mapCounts(counts.rows[0]!),
        blockers: blockers.rows.map(mapBlocker),
        planKeys: planKeys.rows.map((row) => row.plan_key),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
