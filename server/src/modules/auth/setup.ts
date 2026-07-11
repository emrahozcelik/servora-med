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
  product: { sku: string; name: string; unit: string };
};

export type SetupRequest = {
  organizationName: string;
  users: SetupUser[];
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
    referenceData: {
      customer: { name: 'Demo Dental Klinik', customerType: 'clinic', status: 'active' },
      product: { sku: 'DEMO-001', name: 'Demo İmplant Seti', unit: 'adet' },
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
      if (request.referenceData) {
        const { customer, product } = request.referenceData;
        await client.query(
          `INSERT INTO customers
             (organization_id, name, customer_type, assigned_staff_user_id, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [organization.rows[0]!.id, customer.name, customer.customerType, userIds.get('STAFF'), customer.status],
        );
        await client.query(
          `INSERT INTO products (organization_id, sku, name, unit)
           VALUES ($1, $2, $3, $4)`,
          [organization.rows[0]!.id, product.sku, product.name, product.unit],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
