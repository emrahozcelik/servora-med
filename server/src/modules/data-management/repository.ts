import type { Pool } from 'pg';

import type { DataManagementSummary } from './types.js';

export interface DataManagementReadModel {
  getSummary(organizationId: string): Promise<DataManagementSummary>;
}

type SummaryRow = {
  customer_total: string | number;
  customer_prospect: string | number;
  customer_active: string | number;
  customer_inactive: string | number;
  contact_total: string | number;
  contact_active: string | number;
  contact_inactive: string | number;
  product_total: string | number;
  product_active: string | number;
  product_inactive: string | number;
  staff_total: string | number;
  staff_active: string | number;
  staff_inactive: string | number;
  demo_dataset_total: string | number;
  demo_dataset_active: string | number;
  demo_dataset_purged: string | number;
};

export const DATA_MANAGEMENT_SUMMARY_SQL = `
WITH customer_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE c.data_class = 'BUSINESS') AS customer_total,
    COUNT(*) FILTER (WHERE c.data_class = 'BUSINESS' AND c.status = 'prospect') AS customer_prospect,
    COUNT(*) FILTER (WHERE c.data_class = 'BUSINESS' AND c.status = 'active') AS customer_active,
    COUNT(*) FILTER (WHERE c.data_class = 'BUSINESS' AND c.status = 'inactive') AS customer_inactive
  FROM customers c
  WHERE c.organization_id = $1
), contact_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE customer.data_class = 'BUSINESS') AS contact_total,
    COUNT(*) FILTER (WHERE customer.data_class = 'BUSINESS' AND contact.is_active = TRUE) AS contact_active,
    COUNT(*) FILTER (WHERE customer.data_class = 'BUSINESS' AND contact.is_active = FALSE) AS contact_inactive
  FROM contacts contact
  JOIN customers customer
    ON customer.organization_id = contact.organization_id
   AND customer.id = contact.customer_id
  WHERE contact.organization_id = $1
), product_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE p.data_class = 'BUSINESS') AS product_total,
    COUNT(*) FILTER (WHERE p.data_class = 'BUSINESS' AND p.is_active = TRUE) AS product_active,
    COUNT(*) FILTER (WHERE p.data_class = 'BUSINESS' AND p.is_active = FALSE) AS product_inactive
  FROM products p
  WHERE p.organization_id = $1
), staff_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE u.data_class = 'BUSINESS' AND u.role = 'STAFF') AS staff_total,
    COUNT(*) FILTER (WHERE u.data_class = 'BUSINESS' AND u.role = 'STAFF' AND u.is_active = TRUE) AS staff_active,
    COUNT(*) FILTER (WHERE u.data_class = 'BUSINESS' AND u.role = 'STAFF' AND u.is_active = FALSE) AS staff_inactive
  FROM users u
  WHERE u.organization_id = $1
), demo_dataset_counts AS (
  SELECT
    COUNT(*) AS demo_dataset_total,
    COUNT(*) FILTER (WHERE d.status = 'ACTIVE') AS demo_dataset_active,
    COUNT(*) FILTER (WHERE d.status = 'PURGED') AS demo_dataset_purged
  FROM demo_datasets d
  WHERE d.organization_id = $1
)
SELECT
  customer_total, customer_prospect, customer_active, customer_inactive,
  contact_total, contact_active, contact_inactive,
  product_total, product_active, product_inactive,
  staff_total, staff_active, staff_inactive,
  demo_dataset_total, demo_dataset_active, demo_dataset_purged
FROM customer_counts
CROSS JOIN contact_counts
CROSS JOIN product_counts
CROSS JOIN staff_counts
CROSS JOIN demo_dataset_counts`;

function count(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid Data Management summary count: ${field}`);
  }
  return parsed;
}

export class PostgresDataManagementRepository implements DataManagementReadModel {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async getSummary(organizationId: string): Promise<DataManagementSummary> {
    const result = await this.pool.query<SummaryRow>(DATA_MANAGEMENT_SUMMARY_SQL, [organizationId]);
    const row = result.rows[0];
    if (!row) throw new Error('Data Management summary query returned no row.');
    return {
      customers: {
        total: count(row.customer_total, 'customer_total'),
        prospect: count(row.customer_prospect, 'customer_prospect'),
        active: count(row.customer_active, 'customer_active'),
        inactive: count(row.customer_inactive, 'customer_inactive'),
      },
      contacts: {
        total: count(row.contact_total, 'contact_total'),
        active: count(row.contact_active, 'contact_active'),
        inactive: count(row.contact_inactive, 'contact_inactive'),
      },
      products: {
        total: count(row.product_total, 'product_total'),
        active: count(row.product_active, 'product_active'),
        inactive: count(row.product_inactive, 'product_inactive'),
      },
      staff: {
        total: count(row.staff_total, 'staff_total'),
        active: count(row.staff_active, 'staff_active'),
        inactive: count(row.staff_inactive, 'staff_inactive'),
      },
      demoDataset: {
        total: count(row.demo_dataset_total, 'demo_dataset_total'),
        active: count(row.demo_dataset_active, 'demo_dataset_active'),
        purged: count(row.demo_dataset_purged, 'demo_dataset_purged'),
      },
    };
  }
}
