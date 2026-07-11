import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../src/db/migrations/002_delivery_tracer.sql', import.meta.url),
);

let sql = '';

beforeAll(async () => {
  sql = await readFile(migrationPath, 'utf8');
});

describe('002_delivery_tracer migration contract', () => {
  it.each([
    'customers',
    'products',
    'job_cards',
    'job_card_delivery_items',
    'job_card_activity_logs',
    'processed_actions',
  ])('creates the %s table', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE ${table}\\b`, 'i'));
  });

  it('constrains the tracer vocabulary and optimistic version', () => {
    expect(sql).toContain("type IN ('PRODUCT_DELIVERY', 'GENERAL_TASK')");
    expect(sql).toContain("delivery_purpose IN ('SALE', 'SAMPLE', 'CONSIGNMENT', 'RETURN', 'OTHER')");
    expect(sql).toMatch(/version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/);
    expect(sql).toMatch(/quantity NUMERIC\(12,3\) NOT NULL CHECK \(quantity > 0\)/);
  });

  it('protects review-state persistence and idempotency ownership', () => {
    expect(sql).toMatch(/WAITING_APPROVAL[\s\S]*staff_completed_at IS NOT NULL/);
    expect(sql).toMatch(/COMPLETED[\s\S]*manager_approved_at IS NOT NULL/);
    expect(sql).toContain('UNIQUE (organization_id, user_id, client_action_id, operation_key)');
    expect(sql).toContain('UNIQUE (organization_id, id)');
  });

  it('does not introduce stock, accounting, or delivery price fields', () => {
    expect(sql).not.toMatch(/stock_(quantity|movement)|invoice|payment|unit_price|line_total|discount_amount/i);
  });
});
