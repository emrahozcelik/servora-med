import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const path = fileURLToPath(new URL('../src/db/migrations/004_crm_contacts.sql', import.meta.url));
let sql = '';
beforeAll(async () => { sql = await readFile(path, 'utf8'); });

describe('004 CRM migration contract', () => {
  it('versions Customers and removes ambiguous notes', () => {
    expect(sql).toMatch(/ALTER TABLE customers[\s\S]*DROP COLUMN notes/i);
    expect(sql).toMatch(/ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK \(version > 0\)/i);
    expect(sql).toMatch(/UNIQUE[\s\S]*organization_id[\s\S]*tax_number|CREATE UNIQUE INDEX[\s\S]*tax_number/i);
  });

  it('protects Contact and JobCard ownership', () => {
    expect(sql).toContain('CREATE TABLE contacts');
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, customer_id\)[\s\S]*REFERENCES customers \(organization_id, id\)/i);
    expect(sql).toMatch(/ADD COLUMN contact_id UUID/i);
    expect(sql).toMatch(/FOREIGN KEY \(organization_id, contact_id\)[\s\S]*REFERENCES contacts \(organization_id, id\)/i);
    expect(sql).toMatch(/WHERE is_primary = TRUE AND is_active = TRUE/i);
  });

  it('expands audit checks without credential fields', () => {
    expect(sql).toContain("'CUSTOMER'");
    expect(sql).toContain("'CONTACT'");
    expect(sql).toContain("'CUSTOMER_ASSIGNEE_CHANGED'");
    expect(sql).not.toMatch(/ADD COLUMN (password|token|cookie|session)/i);
  });
});
