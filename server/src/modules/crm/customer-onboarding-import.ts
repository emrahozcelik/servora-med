import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../errors/index.js';
import {
  CUSTOMER_STATUSES,
  CUSTOMER_TYPES,
  normalizeTaxNumber,
  type CustomerStatus,
  type CustomerType,
} from './types.js';

const IMPORT_SOURCE = 'production-customer-onboarding';
const IMPORT_VERSION = 1;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CustomerOnboardingContact = {
  sourceId: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  isActive: boolean;
};

export type CustomerOnboardingCustomer = {
  sourceId: string;
  name: string;
  customerType: CustomerType;
  status: CustomerStatus;
  taxNumber: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  assignedSourceStaffUserId: string | null;
  contacts: CustomerOnboardingContact[];
};

export type CustomerOnboardingManifest = {
  version: 1;
  customers: CustomerOnboardingCustomer[];
};

export type StaffMapping = {
  sourceUserId: string;
  productionUserId: string;
};

export type CustomerImportResult = {
  inputCustomers: number;
  inputContacts: number;
  createCount: number;
  existingCount: number;
  createContactCount: number;
  existingContactCount: number;
  conflictCount: number;
  invalidCount: number;
  staffMappingsResolved: number;
  staffMappingsUnresolved: number;
  taxConflicts: number;
  dryRun: boolean;
};

type ExistingCustomer = {
  id: string;
  name: string;
  customerType: CustomerType;
  status: CustomerStatus;
  taxNumber: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  assignedStaffUserId: string | null;
};

type ExistingContact = {
  id: string;
  customerId: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
  isActive: boolean;
};

type ExistingFingerprint = {
  subjectType: 'CUSTOMER' | 'CONTACT';
  subjectId: string;
  fingerprint: string;
};

type ExistingState = {
  customers: ExistingCustomer[];
  contacts: ExistingContact[];
  fingerprints: ExistingFingerprint[];
  staff: Map<string, { role: string; isActive: boolean }>;
};

type CustomerPlan = {
  source: CustomerOnboardingCustomer;
  destinationStaffUserId: string | null;
  customerFingerprint: string;
  existing: ExistingCustomer | null;
  contacts: Array<{
    source: CustomerOnboardingContact;
    isPrimary: boolean;
    fingerprint: string;
    existing: ExistingContact | null;
  }>;
  conflict: boolean;
};

type ImportPlan = {
  customers: CustomerPlan[];
  result: CustomerImportResult;
};

function importError(code: string, message: string) {
  return new AppError(code, 409, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `${label} unsupported field: ${unknown}`);
}

function uuid(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string') throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `${label} must be text`);
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `${label} is invalid`);
  }
  return cleaned;
}

function optionalText(value: unknown, label: string, max: number) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label, max);
}

function optionalEmail(value: unknown, label: string) {
  const cleaned = optionalText(value, label, 255);
  if (cleaned !== null && !EMAIL_PATTERN.test(cleaned)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `${label} is invalid`);
  }
  return cleaned?.toLowerCase() ?? null;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `${label} must be boolean`);
  return value;
}

function normalizeContact(value: unknown, index: number): CustomerOnboardingContact {
  if (!isRecord(value)) throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `contacts[${index}] must be an object`);
  exactKeys(value, ['sourceId', 'name', 'title', 'phone', 'email', 'isPrimary', 'isActive'], `contacts[${index}]`);
  return {
    sourceId: uuid(value.sourceId, `contacts[${index}].sourceId`),
    name: requiredText(value.name, `contacts[${index}].name`, 255),
    title: optionalText(value.title, `contacts[${index}].title`, 255),
    phone: optionalText(value.phone, `contacts[${index}].phone`, 50),
    email: optionalEmail(value.email, `contacts[${index}].email`),
    isPrimary: boolean(value.isPrimary, `contacts[${index}].isPrimary`),
    isActive: boolean(value.isActive, `contacts[${index}].isActive`),
  };
}

function normalizeCustomer(value: unknown, index: number): CustomerOnboardingCustomer {
  if (!isRecord(value)) throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `customers[${index}] must be an object`);
  exactKeys(value, ['sourceId', 'name', 'customerType', 'status', 'taxNumber', 'phone', 'email', 'city',
    'district', 'address', 'assignedSourceStaffUserId', 'contacts'], `customers[${index}]`);
  if (!CUSTOMER_TYPES.includes(value.customerType as CustomerType)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `customers[${index}].customerType is invalid`);
  }
  if (!CUSTOMER_STATUSES.includes(value.status as CustomerStatus)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `customers[${index}].status is invalid`);
  }
  if (!Array.isArray(value.contacts)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `customers[${index}].contacts must be an array`);
  }
  const contacts = value.contacts.map((contact, contactIndex) => normalizeContact(contact, contactIndex));
  if (new Set(contacts.map((contact) => contact.sourceId)).size !== contacts.length) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `customers[${index}] has duplicate contact source IDs`);
  }
  if (contacts.filter((contact) => contact.isPrimary && contact.isActive).length > 1) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `customers[${index}] has multiple active primary contacts`);
  }
  if (!contacts.some((contact) => contact.isPrimary && contact.isActive)) {
    const firstActive = contacts.find((contact) => contact.isActive);
    if (firstActive) firstActive.isPrimary = true;
  }
  return {
    sourceId: uuid(value.sourceId, `customers[${index}].sourceId`),
    name: requiredText(value.name, `customers[${index}].name`, 255),
    customerType: value.customerType as CustomerType,
    status: value.status as CustomerStatus,
    taxNumber: normalizeTaxNumber(optionalText(value.taxNumber, `customers[${index}].taxNumber`, 50)),
    phone: optionalText(value.phone, `customers[${index}].phone`, 50),
    email: optionalEmail(value.email, `customers[${index}].email`),
    city: optionalText(value.city, `customers[${index}].city`, 100),
    district: optionalText(value.district, `customers[${index}].district`, 100),
    address: optionalText(value.address, `customers[${index}].address`, 10_000),
    assignedSourceStaffUserId: value.assignedSourceStaffUserId === null
      ? null : uuid(value.assignedSourceStaffUserId, `customers[${index}].assignedSourceStaffUserId`),
    contacts,
  };
}

export function parseCustomerOnboardingManifest(value: unknown): CustomerOnboardingManifest {
  if (!isRecord(value)) throw new AppError('CUSTOMER_IMPORT_INVALID', 400, 'Manifest must be an object');
  exactKeys(value, ['version', 'customers'], 'Manifest');
  if (value.version !== 1 || !Array.isArray(value.customers)) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, 'Manifest version 1 and customers array are required');
  }
  const customers = value.customers.map((customer, index) => normalizeCustomer(customer, index));
  if (new Set(customers.map((customer) => customer.sourceId)).size !== customers.length) {
    throw new AppError('CUSTOMER_IMPORT_INVALID', 400, 'Manifest has duplicate customer source IDs');
  }
  return { version: 1, customers };
}

export function parseStaffMappings(value: unknown): StaffMapping[] {
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.mappings) ? value.mappings : null;
  if (!rows) throw new AppError('CUSTOMER_IMPORT_INVALID', 400, 'Staff mapping must be an array');
  return rows.map((entry, index) => {
    if (!isRecord(entry)) throw new AppError('CUSTOMER_IMPORT_INVALID', 400, `mappings[${index}] must be an object`);
    exactKeys(entry, ['sourceUserId', 'productionUserId'], `mappings[${index}]`);
    return {
      sourceUserId: uuid(entry.sourceUserId, `mappings[${index}].sourceUserId`),
      productionUserId: uuid(entry.productionUserId, `mappings[${index}].productionUserId`),
    };
  });
}

function optionalKey(value: string | null) {
  return value?.trim().toLocaleLowerCase('tr-TR') ?? '';
}

function customerFingerprint(source: CustomerOnboardingCustomer) {
  return createHash('sha256').update(JSON.stringify({ source: IMPORT_SOURCE, kind: 'customer', sourceId: source.sourceId })).digest('hex');
}

function contactFingerprint(source: CustomerOnboardingContact) {
  return createHash('sha256').update(JSON.stringify({ source: IMPORT_SOURCE, kind: 'contact', sourceId: source.sourceId })).digest('hex');
}

function sameCustomer(source: CustomerOnboardingCustomer, existing: ExistingCustomer, destinationStaffUserId: string | null) {
  return source.name === existing.name
    && source.customerType === existing.customerType
    && source.status === existing.status
    && source.taxNumber === existing.taxNumber
    && source.phone === existing.phone
    && source.email === existing.email
    && source.city === existing.city
    && source.district === existing.district
    && source.address === existing.address
    && destinationStaffUserId === existing.assignedStaffUserId;
}

function sameContact(source: CustomerOnboardingContact, existing: ExistingContact, expectedPrimary: boolean) {
  return source.name === existing.name && source.title === existing.title && source.phone === existing.phone
    && source.email === existing.email && source.isActive === existing.isActive && expectedPrimary === existing.isPrimary;
}

function noTaxCandidates(source: CustomerOnboardingCustomer, existing: ExistingCustomer[]) {
  const name = optionalKey(source.name);
  const withSecondary = source.email || source.phone || source.city || source.district || source.address;
  return existing.filter((candidate) => {
    if (candidate.taxNumber !== null || optionalKey(candidate.name) !== name) return false;
    if (!withSecondary) return true;
    return (!source.email || optionalKey(candidate.email) === optionalKey(source.email))
      && (!source.phone || optionalKey(candidate.phone) === optionalKey(source.phone))
      && (!source.city || optionalKey(candidate.city) === optionalKey(source.city))
      && (!source.district || optionalKey(candidate.district) === optionalKey(source.district))
      && (!source.address || optionalKey(candidate.address) === optionalKey(source.address));
  });
}

async function readState(client: PoolClient, organizationId: string, productionStaffIds: string[]): Promise<ExistingState> {
  const customerRows = await client.query<{
    id: string; name: string; customer_type: CustomerType; status: CustomerStatus; tax_number: string | null;
    phone: string | null; email: string | null; city: string | null; district: string | null;
    address: string | null; assigned_staff_user_id: string | null;
  }>(`SELECT id,name,customer_type,tax_number,phone,email,city,district,address,assigned_staff_user_id,status
      FROM customers WHERE organization_id=$1 ORDER BY id`, [organizationId]);
  const contactRows = await client.query<{
    id: string; customer_id: string; name: string; title: string | null; phone: string | null;
    email: string | null; is_primary: boolean; is_active: boolean;
  }>(`SELECT id,customer_id,name,title,phone,email,is_primary,is_active
      FROM contacts WHERE organization_id=$1 ORDER BY id`, [organizationId]);
  const fingerprintRows = await client.query<{ subject_type: 'CUSTOMER' | 'CONTACT'; subject_id: string; fingerprint: string }>(
    `SELECT subject_type,subject_id,metadata->>'sourceFingerprint' AS fingerprint
       FROM audit_events
      WHERE organization_id=$1 AND subject_type IN ('CUSTOMER','CONTACT')
        AND metadata->>'source'=$2 AND metadata->>'sourceFingerprint' IS NOT NULL`,
    [organizationId, IMPORT_SOURCE],
  );
  const staffRows = productionStaffIds.length === 0 ? { rows: [] } : await client.query<{ id: string; role: string; is_active: boolean }>(
    `SELECT id,role,is_active FROM users WHERE organization_id=$1 AND id=ANY($2::uuid[])`,
    [organizationId, productionStaffIds],
  );
  return {
    customers: customerRows.rows.map((row) => ({ id: row.id, name: row.name, customerType: row.customer_type,
      status: row.status, taxNumber: row.tax_number, phone: row.phone, email: row.email, city: row.city,
      district: row.district, address: row.address, assignedStaffUserId: row.assigned_staff_user_id })),
    contacts: contactRows.rows.map((row) => ({ id: row.id, customerId: row.customer_id, name: row.name,
      title: row.title, phone: row.phone, email: row.email, isPrimary: row.is_primary, isActive: row.is_active })),
    fingerprints: fingerprintRows.rows.map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id, fingerprint: row.fingerprint })),
    staff: new Map(staffRows.rows.map((row) => [row.id, { role: row.role, isActive: row.is_active }])),
  };
}

function fingerprintSubject(state: ExistingState, subjectType: ExistingFingerprint['subjectType'], fingerprint: string) {
  return state.fingerprints.filter((entry) => entry.subjectType === subjectType && entry.fingerprint === fingerprint);
}

function buildPlan(
  manifest: CustomerOnboardingManifest,
  mappings: StaffMapping[],
  state: ExistingState,
  apply: boolean,
): ImportPlan {
  const mapping = new Map<string, string>();
  let mappingConflict = 0;
  for (const entry of mappings) {
    const previous = mapping.get(entry.sourceUserId);
    if (previous && previous !== entry.productionUserId) mappingConflict += 1;
    mapping.set(entry.sourceUserId, entry.productionUserId);
  }
  const requiredSourceStaff = new Set(manifest.customers.flatMap((customer) =>
    customer.assignedSourceStaffUserId ? [customer.assignedSourceStaffUserId] : []));
  let staffMappingsResolved = 0;
  let staffMappingsUnresolved = mappingConflict;
  const destinationStaff = new Map<string, string | null>();
  for (const sourceStaffId of requiredSourceStaff) {
    const destination = mapping.get(sourceStaffId);
    const user = destination ? state.staff.get(destination) : undefined;
    if (!destination || !user || user.role !== 'STAFF' || !user.isActive) {
      staffMappingsUnresolved += 1;
      destinationStaff.set(sourceStaffId, null);
    } else {
      staffMappingsResolved += 1;
      destinationStaff.set(sourceStaffId, destination);
    }
  }
  const seenSourceTax = new Set<string>();
  let taxConflicts = 0;
  const plans: CustomerPlan[] = [];
  let conflictCount = mappingConflict;
  for (const source of manifest.customers) {
    const destinationStaffUserId = source.assignedSourceStaffUserId
      ? destinationStaff.get(source.assignedSourceStaffUserId) ?? null : null;
    if (source.taxNumber) {
      if (seenSourceTax.has(source.taxNumber)) taxConflicts += 1;
      seenSourceTax.add(source.taxNumber);
    }
    const fingerprint = customerFingerprint(source);
    const fingerprintMatches = fingerprintSubject(state, 'CUSTOMER', fingerprint);
    let candidates = fingerprintMatches.length > 0
      ? state.customers.filter((candidate) => fingerprintMatches.some((match) => match.subjectId === candidate.id))
      : source.taxNumber
        ? state.customers.filter((candidate) => candidate.taxNumber === source.taxNumber)
        : noTaxCandidates(source, state.customers);
    let conflict = false;
    if (candidates.length > 1 || (fingerprintMatches.length > 1)) conflict = true;
    const existing = candidates.length === 1 ? candidates[0]! : null;
    if (existing && !sameCustomer(source, existing, destinationStaffUserId)) conflict = true;
    if (!existing && fingerprintMatches.length > 0) conflict = true;
    const customerId = existing?.id ?? null;
    const existingContacts = customerId ? state.contacts.filter((contact) => contact.customerId === customerId) : [];
    const contacts = source.contacts.map((contact) => {
      const contactFp = contactFingerprint(contact);
      const contactMatches = fingerprintSubject(state, 'CONTACT', contactFp)
        .filter((match) => existingContacts.some((candidate) => candidate.id === match.subjectId));
      const contactCandidates = contactMatches.length > 0
        ? existingContacts.filter((candidate) => contactMatches.some((match) => match.subjectId === candidate.id))
        : existingContacts.filter((candidate) => sameContact(contact, candidate, contact.isPrimary && contact.isActive));
      const contactExisting = contactCandidates.length === 1 ? contactCandidates[0]! : null;
      if (contactCandidates.length > 1 || (contactMatches.length > 1)
        || (contactExisting && !sameContact(contact, contactExisting, contact.isPrimary && contact.isActive))) conflict = true;
      return { source: contact, isPrimary: contact.isPrimary && contact.isActive,
        fingerprint: contactFp, existing: contactExisting };
    });
    if (source.contacts.some((contact) => contact.isPrimary && contact.isActive)
      && existingContacts.some((contact) => contact.isPrimary && contact.isActive)
      && contacts.every((contact) => !contact.existing || !contact.isPrimary)) conflict = true;
    if (conflict) conflictCount += 1;
    plans.push({ source, destinationStaffUserId, customerFingerprint: fingerprint, existing, contacts, conflict });
  }
  const createCount = plans.filter((plan) => !plan.existing).length;
  const existingCount = plans.filter((plan) => !!plan.existing).length;
  const createContactCount = plans.reduce((count, plan) => count + plan.contacts.filter((contact) => !contact.existing).length, 0);
  const existingContactCount = plans.reduce((count, plan) => count + plan.contacts.filter((contact) => !!contact.existing).length, 0);
  const result: CustomerImportResult = {
    inputCustomers: manifest.customers.length,
    inputContacts: manifest.customers.reduce((count, customer) => count + customer.contacts.length, 0),
    createCount, existingCount, createContactCount, existingContactCount,
    conflictCount, invalidCount: 0, staffMappingsResolved, staffMappingsUnresolved,
    taxConflicts, dryRun: !apply,
  };
  if (apply && (conflictCount > 0 || staffMappingsUnresolved > 0 || taxConflicts > 0)) {
    throw importError('CUSTOMER_IMPORT_BLOCKED', 'Customer import has unresolved conflicts or staff mappings');
  }
  return { customers: plans, result };
}

async function insertCustomerWithContacts(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  plan: CustomerPlan,
) {
  const customerResult = await client.query<{ id: string }>(
    `INSERT INTO customers
      (organization_id,name,customer_type,tax_number,phone,email,city,district,address,assigned_staff_user_id,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [organizationId, plan.source.name, plan.source.customerType, plan.source.taxNumber, plan.source.phone,
      plan.source.email, plan.source.city, plan.source.district, plan.source.address,
      plan.destinationStaffUserId, plan.source.status],
  );
  const customerId = customerResult.rows[0]!.id;
  await client.query(
    `INSERT INTO audit_events
      (organization_id,actor_user_id,subject_type,subject_id,event_type,old_value,new_value,metadata)
     VALUES ($1,$2,'CUSTOMER',$3,'CUSTOMER_CREATED',NULL,$4,$5)`,
    [organizationId, actorUserId, customerId,
      { customerType: plan.source.customerType, status: plan.source.status,
        assignedStaffUserId: plan.destinationStaffUserId },
      { source: IMPORT_SOURCE, importVersion: IMPORT_VERSION, sourceFingerprint: plan.customerFingerprint }],
  );
  const orderedContacts = [...plan.contacts].sort((left, right) => Number(left.isPrimary) - Number(right.isPrimary));
  for (const contact of orderedContacts) {
    const contactResult = await client.query<{ id: string }>(
      `INSERT INTO contacts
        (organization_id,customer_id,name,title,phone,email,is_primary,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [organizationId, customerId, contact.source.name, contact.source.title, contact.source.phone,
        contact.source.email, contact.isPrimary, contact.source.isActive],
    );
    await client.query(
      `INSERT INTO audit_events
        (organization_id,actor_user_id,subject_type,subject_id,event_type,old_value,new_value,metadata)
       VALUES ($1,$2,'CONTACT',$3,'CONTACT_CREATED',NULL,$4,$5)`,
      [organizationId, actorUserId, contactResult.rows[0]!.id,
        { customerId, isPrimary: contact.isPrimary, isActive: contact.source.isActive },
        { source: IMPORT_SOURCE, importVersion: IMPORT_VERSION, sourceFingerprint: contact.fingerprint }],
    );
  }
}

async function insertContactsForExistingCustomer(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  plan: CustomerPlan,
) {
  if (!plan.existing) return;
  const missing = plan.contacts.filter((contact) => !contact.existing);
  if (missing.length === 0) return;
  const primary = await client.query<{ id: string }>(
    `SELECT id FROM contacts WHERE organization_id=$1 AND customer_id=$2 AND is_primary=TRUE AND is_active=TRUE FOR UPDATE`,
    [organizationId, plan.existing.id],
  );
  const hasPrimary = primary.rowCount !== 0;
  for (const contact of [...missing].sort((left, right) => Number(left.isPrimary) - Number(right.isPrimary))) {
    const isPrimary = contact.isPrimary && !hasPrimary;
    const created = await client.query<{ id: string }>(
      `INSERT INTO contacts
        (organization_id,customer_id,name,title,phone,email,is_primary,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [organizationId, plan.existing.id, contact.source.name, contact.source.title, contact.source.phone,
        contact.source.email, isPrimary, contact.source.isActive],
    );
    await client.query(
      `INSERT INTO audit_events
        (organization_id,actor_user_id,subject_type,subject_id,event_type,old_value,new_value,metadata)
       VALUES ($1,$2,'CONTACT',$3,'CONTACT_CREATED',NULL,$4,$5)`,
      [organizationId, actorUserId, created.rows[0]!.id,
        { customerId: plan.existing.id, isPrimary, isActive: contact.source.isActive },
        { source: IMPORT_SOURCE, importVersion: IMPORT_VERSION, sourceFingerprint: contact.fingerprint }],
    );
  }
}

export async function importCustomers(
  pool: Pool,
  input: {
    organizationId: string;
    actorUserId: string;
    manifest: CustomerOnboardingManifest;
    mappings: StaffMapping[];
    apply: boolean;
  },
): Promise<CustomerImportResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`CUSTOMER_IMPORT:${input.organizationId}`]);
    const actor = await client.query(
      `SELECT id FROM users WHERE organization_id=$1 AND id=$2 AND role IN ('ADMIN','MANAGER') AND is_active=TRUE FOR SHARE`,
      [input.organizationId, input.actorUserId],
    );
    if (actor.rowCount !== 1) throw importError('CUSTOMER_IMPORT_FORBIDDEN', 'Import actor must be an active Admin or Manager');
    const productionStaffIds = input.mappings.map((mapping) => mapping.productionUserId);
    const state = await readState(client, input.organizationId, productionStaffIds);
    const plan = buildPlan(input.manifest, input.mappings, state, input.apply);
    if (!input.apply) return plan.result;
    for (const customer of plan.customers) {
      await client.query('BEGIN');
      try {
        if (customer.existing) await insertContactsForExistingCustomer(client, input.organizationId, input.actorUserId, customer);
        else await insertCustomerWithContacts(client, input.organizationId, input.actorUserId, customer);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return plan.result;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`CUSTOMER_IMPORT:${input.organizationId}`]); } finally { client.release(); }
  }
}
