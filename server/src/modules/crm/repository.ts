import type { Pool, PoolClient } from 'pg';

import type {
  AppendCrmAuditInput,
  Contact,
  ContactFilters,
  CreateContactRecord,
  CreateCustomerRecord,
  CrmActor,
  CrmUserRecord,
  Customer,
  CustomerDetail,
  CustomerFilters,
  CustomerJobSummary,
  CustomerSummary,
  Paginated,
  SetContactActiveRecord,
  SetCustomerStatusRecord,
  UpdateContactRecord,
  UpdateCustomerRecord,
} from './types.js';
import { normalizeTaxNumber } from './types.js';

type CustomerRow = {
  id: string; organization_id: string; name: string; customer_type: Customer['customerType'];
  tax_number: string | null; phone: string | null; email: string | null;
  city: string | null; district: string | null; address: string | null;
  assigned_staff_user_id: string | null; status: Customer['status']; version: number;
  created_at: Date; updated_at: Date; assigned_staff_name?: string | null;
  primary_contact_id?: string | null; primary_contact_name?: string | null;
  primary_contact_title?: string | null;
};

type ContactRow = {
  id: string; organization_id: string; customer_id: string; name: string;
  title: string | null; phone: string | null; email: string | null;
  is_primary: boolean; is_active: boolean; version: number;
  created_at: Date; updated_at: Date;
};

type JobSummaryRow = {
  id: string; title: string; status: CustomerJobSummary['status']; assigned_to: string;
  due_date: string | null; created_at: Date; updated_at: Date; manager_approved_at: Date | null;
};

const CUSTOMER_COLUMNS = `c.id, c.organization_id, c.name, c.customer_type, c.tax_number,
  c.phone, c.email, c.city, c.district, c.address, c.assigned_staff_user_id,
  c.status, c.version, c.created_at, c.updated_at`;
const CONTACT_COLUMNS = `id, organization_id, customer_id, name, title, phone, email,
  is_primary, is_active, version, created_at, updated_at`;

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    customerType: row.customer_type, taxNumber: row.tax_number, phone: row.phone,
    email: row.email, city: row.city, district: row.district, address: row.address,
    assignedStaffUserId: row.assigned_staff_user_id, status: row.status,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapCustomerSummary(row: CustomerRow): CustomerSummary {
  return {
    ...mapCustomer(row),
    assignedStaffName: row.assigned_staff_name ?? null,
    primaryContact: row.primary_contact_id && row.primary_contact_name
      ? { id: row.primary_contact_id, name: row.primary_contact_name, title: row.primary_contact_title ?? null }
      : null,
  };
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id, organizationId: row.organization_id, customerId: row.customer_id,
    name: row.name, title: row.title, phone: row.phone, email: row.email,
    isPrimary: row.is_primary, isActive: row.is_active, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapJobSummary(row: JobSummaryRow): CustomerJobSummary {
  return {
    id: row.id, title: row.title, status: row.status, assignedTo: row.assigned_to,
    dueDate: row.due_date, createdAt: row.created_at, updatedAt: row.updated_at,
    managerApprovedAt: row.manager_approved_at,
  };
}

export interface CrmTransaction {
  lockUser(organizationId: string, userId: string): Promise<CrmUserRecord | null>;
  lockCustomer(organizationId: string, customerId: string): Promise<Customer | null>;
  createCustomer(input: CreateCustomerRecord): Promise<Customer>;
  updateCustomer(input: UpdateCustomerRecord): Promise<Customer | null>;
  setCustomerStatus(input: SetCustomerStatusRecord): Promise<Customer | null>;
  customerHasActiveJobs(organizationId: string, customerId: string): Promise<boolean>;
  lockContact(organizationId: string, customerId: string, contactId: string): Promise<Contact | null>;
  lockActiveContacts(organizationId: string, customerId: string): Promise<Contact[]>;
  createContact(input: CreateContactRecord): Promise<Contact>;
  updateContact(input: UpdateContactRecord): Promise<Contact | null>;
  setContactActive(input: SetContactActiveRecord): Promise<Contact | null>;
  clearPrimary(contactId: string): Promise<Contact>;
  setPrimary(contactId: string, expectedVersion: number): Promise<Contact | null>;
  contactHasActiveJobs(organizationId: string, contactId: string): Promise<boolean>;
  appendAudit(input: AppendCrmAuditInput): Promise<void>;
}

export interface CrmRepository {
  execute<T>(work: (tx: CrmTransaction) => Promise<T>): Promise<T>;
  listCustomers(organizationId: string, filters: CustomerFilters): Promise<Paginated<CustomerSummary>>;
  getCustomerDetail(actor: CrmActor, customerId: string): Promise<CustomerDetail | null>;
  listContacts(organizationId: string, customerId: string, filters: ContactFilters): Promise<Paginated<Contact>>;
  getContact(organizationId: string, customerId: string, contactId: string): Promise<Contact | null>;
}

class PostgresCrmTransaction implements CrmTransaction {
  constructor(private readonly client: PoolClient) {}

  async lockUser(organizationId: string, userId: string) {
    const result = await this.client.query<{
      id: string; organization_id: string; role: CrmUserRecord['role']; is_active: boolean;
    }>(`SELECT id, organization_id, role, is_active FROM users
        WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, userId]);
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, role: row.role, isActive: row.is_active } : null;
  }

  async lockCustomer(organizationId: string, customerId: string) {
    const result = await this.client.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers c
       WHERE c.organization_id = $1 AND c.id = $2 FOR UPDATE`, [organizationId, customerId],
    );
    return result.rows[0] ? mapCustomer(result.rows[0]) : null;
  }

  async createCustomer(input: CreateCustomerRecord) {
    const result = await this.client.query<CustomerRow>(
      `INSERT INTO customers
         (organization_id, name, customer_type, tax_number, phone, email, city,
          district, address, assigned_staff_user_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, organization_id, name, customer_type, tax_number, phone, email,
         city, district, address, assigned_staff_user_id, status, version, created_at, updated_at`,
      [input.organizationId, input.name, input.customerType, normalizeTaxNumber(input.taxNumber),
        input.phone, input.email, input.city, input.district, input.address,
        input.assignedStaffUserId, input.status],
    );
    return mapCustomer(result.rows[0]!);
  }

  async updateCustomer(input: UpdateCustomerRecord) {
    const result = await this.client.query<CustomerRow>(
      `UPDATE customers SET name=$4, customer_type=$5, tax_number=$6, phone=$7,
         email=$8, city=$9, district=$10, address=$11, assigned_staff_user_id=$12,
         version = version + 1, updated_at = NOW()
       WHERE organization_id = $1 AND id = $2 AND version = $3
       RETURNING id, organization_id, name, customer_type, tax_number, phone, email,
         city, district, address, assigned_staff_user_id, status, version, created_at, updated_at`,
      [input.organizationId, input.customerId, input.expectedVersion, input.name,
        input.customerType, normalizeTaxNumber(input.taxNumber), input.phone, input.email,
        input.city, input.district, input.address, input.assignedStaffUserId],
    );
    return result.rows[0] ? mapCustomer(result.rows[0]) : null;
  }

  async setCustomerStatus(input: SetCustomerStatusRecord) {
    const result = await this.client.query<CustomerRow>(
      `UPDATE customers SET status=$4, version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND id=$2 AND version=$3
       RETURNING id, organization_id, name, customer_type, tax_number, phone, email,
         city, district, address, assigned_staff_user_id, status, version, created_at, updated_at`,
      [input.organizationId, input.customerId, input.expectedVersion, input.status],
    );
    return result.rows[0] ? mapCustomer(result.rows[0]) : null;
  }

  async customerHasActiveJobs(organizationId: string, customerId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM job_cards WHERE organization_id=$1 AND customer_id=$2
       AND status IN ('NEW','PLANNED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED') LIMIT 1`,
      [organizationId, customerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async lockContact(organizationId: string, customerId: string, contactId: string) {
    const result = await this.client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE organization_id=$1 AND customer_id=$2 AND id=$3 FOR UPDATE`,
      [organizationId, customerId, contactId],
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async lockActiveContacts(organizationId: string, customerId: string) {
    const result = await this.client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE organization_id=$1 AND customer_id=$2 AND is_active=TRUE ORDER BY id FOR UPDATE`,
      [organizationId, customerId],
    );
    return result.rows.map(mapContact);
  }

  async createContact(input: CreateContactRecord) {
    const result = await this.client.query<ContactRow>(
      `INSERT INTO contacts
         (organization_id, customer_id, name, title, phone, email, is_primary, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${CONTACT_COLUMNS}`,
      [input.organizationId, input.customerId, input.name, input.title, input.phone,
        input.email, input.isPrimary, input.isActive],
    );
    return mapContact(result.rows[0]!);
  }

  async updateContact(input: UpdateContactRecord) {
    const result = await this.client.query<ContactRow>(
      `UPDATE contacts SET name=$5, title=$6, phone=$7, email=$8,
         version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND customer_id=$2 AND id=$3 AND version=$4
       RETURNING ${CONTACT_COLUMNS}`,
      [input.organizationId, input.customerId, input.contactId, input.expectedVersion,
        input.name, input.title, input.phone, input.email],
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async setContactActive(input: SetContactActiveRecord) {
    const result = await this.client.query<ContactRow>(
      `UPDATE contacts SET is_active=$5,
         is_primary=CASE WHEN $5=FALSE THEN FALSE ELSE is_primary END,
         version=version+1, updated_at=NOW()
       WHERE organization_id=$1 AND customer_id=$2 AND id=$3 AND version=$4
       RETURNING ${CONTACT_COLUMNS}`,
      [input.organizationId, input.customerId, input.contactId, input.expectedVersion, input.isActive],
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async clearPrimary(contactId: string) {
    const result = await this.client.query<ContactRow>(
      `UPDATE contacts SET is_primary=FALSE, version=version+1, updated_at=NOW()
       WHERE id=$1 RETURNING ${CONTACT_COLUMNS}`, [contactId],
    );
    return mapContact(result.rows[0]!);
  }

  async setPrimary(contactId: string, expectedVersion: number) {
    const result = await this.client.query<ContactRow>(
      `UPDATE contacts SET is_primary=TRUE, version=version+1, updated_at=NOW()
       WHERE id=$1 AND version=$2 RETURNING ${CONTACT_COLUMNS}`, [contactId, expectedVersion],
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async contactHasActiveJobs(organizationId: string, contactId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM job_cards WHERE organization_id=$1 AND contact_id=$2
       AND status IN ('NEW','PLANNED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED') LIMIT 1`,
      [organizationId, contactId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async appendAudit(input: AppendCrmAuditInput) {
    await this.client.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.organizationId, input.actorUserId, input.subjectType, input.subjectId,
        input.eventType, input.oldValue, input.newValue, input.metadata],
    );
  }
}

export class PostgresCrmRepository implements CrmRepository {
  constructor(private readonly pool: Pool) {}

  async execute<T>(work: (tx: CrmTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresCrmTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async listCustomers(organizationId: string, filters: CustomerFilters) {
    const values: unknown[] = [organizationId];
    const where = ['c.organization_id = $1'];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.status) where.push(`c.status = ${add(filters.status)}`);
    else where.push("c.status IN ('prospect', 'active')");
    if (filters.customerType) where.push(`c.customer_type = ${add(filters.customerType)}`);
    if (filters.assignedStaffUserId) where.push(`c.assigned_staff_user_id = ${add(filters.assignedStaffUserId)}`);
    if (filters.city) where.push(`LOWER(c.city) = ${add(filters.city.toLowerCase())}`);
    if (filters.unassigned) where.push('c.assigned_staff_user_id IS NULL');
    if (filters.q?.trim()) {
      const textPattern = add(`%${filters.q.trim().toLowerCase()}%`);
      const normalizedTax = normalizeTaxNumber(filters.q);
      const taxCondition = normalizedTax ? ` OR c.tax_number LIKE ${add(`%${normalizedTax}%`)}` : '';
      where.push(`(
        LOWER(c.name) LIKE ${textPattern}${taxCondition}
        OR LOWER(COALESCE(c.phone,'')) LIKE ${textPattern}
        OR LOWER(COALESCE(c.email,'')) LIKE ${textPattern}
        OR EXISTS (
          SELECT 1 FROM contacts contact
          WHERE contact.organization_id = c.organization_id AND contact.customer_id = c.id
          AND (LOWER(contact.name) LIKE ${textPattern} OR LOWER(COALESCE(contact.title,'')) LIKE ${textPattern}
            OR LOWER(COALESCE(contact.phone,'')) LIKE ${textPattern}
            OR LOWER(COALESCE(contact.email,'')) LIKE ${textPattern})
        )
      )`);
    }
    const condition = where.join(' AND ');
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM customers c WHERE ${condition}`, values,
    );
    const pageValues = [...values, filters.limit, filters.offset];
    const items = await this.pool.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}, u.name AS assigned_staff_name,
         pc.id AS primary_contact_id, pc.name AS primary_contact_name, pc.title AS primary_contact_title
       FROM customers c
       LEFT JOIN users u ON u.organization_id=c.organization_id AND u.id=c.assigned_staff_user_id
       LEFT JOIN contacts pc ON pc.organization_id=c.organization_id AND pc.customer_id=c.id
         AND pc.is_primary=TRUE AND pc.is_active=TRUE
       WHERE ${condition} ORDER BY c.name, c.id
       LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    return { items: items.rows.map(mapCustomerSummary), total: Number(count.rows[0]?.total ?? 0),
      limit: filters.limit, offset: filters.offset };
  }

  async getCustomerDetail(actor: CrmActor, customerId: string) {
    const customerResult = await this.pool.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}, u.name AS assigned_staff_name,
         pc.id AS primary_contact_id, pc.name AS primary_contact_name, pc.title AS primary_contact_title
       FROM customers c
       LEFT JOIN users u ON u.organization_id=c.organization_id AND u.id=c.assigned_staff_user_id
       LEFT JOIN contacts pc ON pc.organization_id=c.organization_id AND pc.customer_id=c.id
         AND pc.is_primary=TRUE AND pc.is_active=TRUE
       WHERE c.organization_id=$1 AND c.id=$2`, [actor.organizationId, customerId],
    );
    const row = customerResult.rows[0];
    if (!row) return null;
    const contacts = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE organization_id=$1 AND customer_id=$2
       ORDER BY is_primary DESC, is_active DESC, name, id`, [actor.organizationId, customerId],
    );
    const jobValues: unknown[] = [actor.organizationId, customerId];
    const staffScope = actor.role === 'STAFF' ? ` AND assigned_to = $${jobValues.push(actor.id)}` : '';
    const openJobs = await this.pool.query<JobSummaryRow>(
      `SELECT id, title, status, assigned_to, due_date, created_at, updated_at, manager_approved_at
       FROM job_cards WHERE organization_id=$1 AND customer_id=$2${staffScope}
       AND status IN ('NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
       ORDER BY updated_at DESC, id DESC LIMIT 5`, jobValues,
    );
    const completedJobs = await this.pool.query<JobSummaryRow>(
      `SELECT id, title, status, assigned_to, due_date, created_at, updated_at, manager_approved_at
       FROM job_cards WHERE organization_id=$1 AND customer_id=$2${staffScope}
       AND status = 'COMPLETED'
       ORDER BY manager_approved_at DESC NULLS LAST, id DESC LIMIT 5`, jobValues,
    );
    return { ...mapCustomerSummary(row), contacts: contacts.rows.map(mapContact),
      openJobs: openJobs.rows.map(mapJobSummary), completedJobs: completedJobs.rows.map(mapJobSummary) };
  }

  async listContacts(organizationId: string, customerId: string, filters: ContactFilters) {
    const values: unknown[] = [organizationId, customerId];
    const where = ['organization_id=$1', 'customer_id=$2'];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (filters.status === 'active') where.push('is_active=TRUE');
    if (filters.status === 'inactive') where.push('is_active=FALSE');
    if (filters.q?.trim()) {
      const pattern = add(`%${filters.q.trim().toLowerCase()}%`);
      where.push(`(LOWER(name) LIKE ${pattern} OR LOWER(COALESCE(title,'')) LIKE ${pattern}
        OR LOWER(COALESCE(phone,'')) LIKE ${pattern} OR LOWER(COALESCE(email,'')) LIKE ${pattern})`);
    }
    const condition = where.join(' AND ');
    const count = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM contacts WHERE ${condition}`, values,
    );
    const pageValues = [...values, filters.limit, filters.offset];
    const items = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE ${condition}
       ORDER BY is_primary DESC, name, id LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    return { items: items.rows.map(mapContact), total: Number(count.rows[0]?.total ?? 0),
      limit: filters.limit, offset: filters.offset };
  }

  async getContact(organizationId: string, customerId: string, contactId: string) {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE organization_id=$1 AND customer_id=$2 AND id=$3`, [organizationId, customerId, contactId],
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }
}
