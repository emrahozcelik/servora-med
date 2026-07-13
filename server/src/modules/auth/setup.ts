import type { Pool } from 'pg';

import type { NodeEnvironment } from '../../config.js';
import { AppError } from '../../errors/index.js';
import { hashPassword } from './crypto.js';
import type { UserRole } from './types.js';

export type SetupUser = {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword: boolean;
};

export type SetupReferenceData = {
  customer: { name: string; customerType: 'clinic'; status: 'active' };
  contact: { name: string; title: string; isPrimary: true };
  product: { sku: string; name: string; unit: string };
  jobCard: { type: 'PRODUCT_DELIVERY'; title: string; status: 'NEW'; priority: 'normal' };
};

export type SetupRequest = {
  organizationName: string;
  users: SetupUser[];
  staffProfile?: {
    title: string | null;
    phone: string | null;
    region: string | null;
    managerRole: 'MANAGER';
  };
  referenceData?: SetupReferenceData;
};

export interface SetupRepository {
  countUsers(): Promise<number>;
  createOrganizationWithUsers(request: SetupRequest): Promise<void>;
}

type BootstrapInput = { organizationName: string; name: string; email: string; password: string };
type SeedInput = { organizationName: string; password: string };

function required(value: string) { return value.trim(); }
function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

async function assertEmpty(repository: SetupRepository) {
  if (await repository.countUsers() !== 0) {
    throw new AppError('BOOTSTRAP_NOT_ALLOWED', 409, 'İlk kullanıcı kurulumu yalnızca boş veritabanında çalışabilir.');
  }
}

export async function bootstrapAdmin(repository: SetupRepository, input: BootstrapInput) {
  const organizationName = required(input.organizationName);
  const name = required(input.name);
  const email = required(input.email).toLowerCase();
  if (!organizationName || !name || !validEmail(email)) {
    throw new AppError('INVALID_SETUP_INPUT', 400, 'Kurulum bilgileri geçersiz.');
  }
  let passwordHash: string;
  try { passwordHash = await hashPassword(input.password); }
  catch { throw new AppError('INVALID_SETUP_INPUT', 400, 'Kurulum bilgileri geçersiz.'); }
  await assertEmpty(repository);
  await repository.createOrganizationWithUsers({
    organizationName,
    users: [{ name, email, passwordHash, role: 'ADMIN', mustChangePassword: false }],
  });
}

export async function seedDevelopment(repository: SetupRepository, input: SeedInput, nodeEnv: NodeEnvironment) {
  if (nodeEnv === 'production') {
    throw new AppError('DEV_SEED_FORBIDDEN', 403, 'Development seed production ortamında çalıştırılamaz.');
  }
  const organizationName = required(input.organizationName);
  if (!organizationName) throw new AppError('INVALID_SETUP_INPUT', 400, 'Organizasyon adı zorunludur.');
  const roles: Array<{ role: UserRole; name: string; email: string }> = [
    { role: 'ADMIN', name: 'Demo Admin', email: 'admin@servora.local' },
    { role: 'MANAGER', name: 'Demo Manager', email: 'manager@servora.local' },
    { role: 'STAFF', name: 'Demo Staff', email: 'staff@servora.local' },
  ];
  const users = await Promise.all(roles.map(async (user) => ({
    ...user, passwordHash: await hashPassword(input.password), mustChangePassword: true,
  })));
  await assertEmpty(repository);
  await repository.createOrganizationWithUsers({
    organizationName,
    users,
    staffProfile: {
      title: 'Saha Personeli', phone: null, region: null, managerRole: 'MANAGER',
    },
    referenceData: {
      customer: { name: 'Demo Dental Klinik', customerType: 'clinic', status: 'active' },
      contact: { name: 'Dr. Ayşe Yılmaz', title: 'Doktor', isPrimary: true },
      product: { sku: 'DEMO-001', name: 'Demo İmplant Seti', unit: 'adet' },
      jobCard: { type: 'PRODUCT_DELIVERY', title: 'Demo ürün teslimi', status: 'NEW', priority: 'normal' },
    },
  });
}

export class PostgresSetupRepository implements SetupRepository {
  constructor(private readonly pool: Pool) {}

  async countUsers() {
    const result = await this.pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    return Number(result.rows[0]!.count);
  }

  async createOrganizationWithUsers(request: SetupRequest) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('servora-med-auth-setup'))");
      const existing = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
      if (Number(existing.rows[0]!.count) !== 0) {
        throw new AppError('BOOTSTRAP_NOT_ALLOWED', 409, 'İlk kullanıcı kurulumu yalnızca boş veritabanında çalışabilir.');
      }
      const organization = await client.query<{ id: string }>(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id', [request.organizationName],
      );
      const userIds = new Map<UserRole, string>();
      for (const user of request.users) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users
             (organization_id, name, email, password_hash, role, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [organization.rows[0]!.id, user.name, user.email, user.passwordHash, user.role, user.mustChangePassword],
        );
        userIds.set(user.role, inserted.rows[0]!.id);
      }
      if (request.staffProfile) {
        const staffUserId = userIds.get('STAFF');
        const managerUserId = userIds.get(request.staffProfile.managerRole);
        if (!staffUserId || !managerUserId) {
          throw new AppError('INVALID_SETUP_INPUT', 400, 'Development personel profili kullanıcıları eksik.');
        }
        await client.query(
          `INSERT INTO staff_profiles
             (organization_id, user_id, title, phone, region, manager_user_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [organization.rows[0]!.id, staffUserId, request.staffProfile.title,
            request.staffProfile.phone, request.staffProfile.region, managerUserId],
        );
      }
      if (request.referenceData) {
        const { customer, contact, product, jobCard } = request.referenceData;
        const insertedCustomer = await client.query<{ id: string }>(
          `INSERT INTO customers
             (organization_id, name, customer_type, assigned_staff_user_id, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [organization.rows[0]!.id, customer.name, customer.customerType, userIds.get('STAFF'), customer.status],
        );
        const insertedContact = await client.query<{ id: string }>(
          `INSERT INTO contacts (organization_id, customer_id, name, title, is_primary)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [organization.rows[0]!.id, insertedCustomer.rows[0]!.id,
            contact.name, contact.title, contact.isPrimary],
        );
        await client.query(
          `INSERT INTO products (organization_id, sku, name, unit)
           VALUES ($1, $2, $3, $4)`,
          [organization.rows[0]!.id, product.sku, product.name, product.unit],
        );
        const insertedJob = await client.query<{ id: string }>(
          `INSERT INTO job_cards
             (organization_id, type, status, title, customer_id, contact_id,
              assigned_to, created_by, priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id`,
          [organization.rows[0]!.id, jobCard.type, jobCard.status, jobCard.title,
            insertedCustomer.rows[0]!.id, insertedContact.rows[0]!.id,
            userIds.get('STAFF'), jobCard.priority],
        );
        await client.query(
          `INSERT INTO job_card_activity_logs
             (organization_id, job_card_id, actor_id, event_type, new_value)
           VALUES ($1,$2,$3,'JOB_CREATED',$4)`,
          [organization.rows[0]!.id, insertedJob.rows[0]!.id, userIds.get('STAFF'),
            { status: jobCard.status, assignedTo: userIds.get('STAFF'), version: 1 }],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
