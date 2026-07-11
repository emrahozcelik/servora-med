import { describe, expect, it } from 'vitest';

import { bootstrapAdmin, seedDevelopment, type SetupRepository, type SetupRequest } from '../src/modules/auth/setup.js';
import { verifyPassword } from '../src/modules/auth/crypto.js';

class MemorySetupRepository implements SetupRepository {
  userCount = 0;
  requests: SetupRequest[] = [];
  async countUsers() { return this.userCount; }
  async createOrganizationWithUsers(request: SetupRequest) {
    this.requests.push(request);
    this.userCount += request.users.length;
  }
}

describe('auth setup', () => {
  it('bootstraps the first admin with normalized email and a password hash', async () => {
    const repository = new MemorySetupRepository();
    await bootstrapAdmin(repository, {
      organizationName: ' Servora Med ', name: ' First Admin ',
      email: ' ADMIN@EXAMPLE.COM ', password: 'secure-bootstrap-password',
    });
    const request = repository.requests[0]!;
    expect(request.organizationName).toBe('Servora Med');
    expect(request.users[0]).toMatchObject({ name: 'First Admin', email: 'admin@example.com', role: 'ADMIN', mustChangePassword: false });
    expect(request.referenceData).toBeUndefined();
    expect(await verifyPassword('secure-bootstrap-password', request.users[0]!.passwordHash)).toBe(true);
  });

  it('refuses bootstrap when any user already exists', async () => {
    const repository = new MemorySetupRepository(); repository.userCount = 1;
    await expect(bootstrapAdmin(repository, {
      organizationName: 'Org', name: 'Admin', email: 'admin@example.com', password: 'secure-bootstrap-password',
    })).rejects.toMatchObject({ code: 'BOOTSTRAP_NOT_ALLOWED' });
    expect(repository.requests).toHaveLength(0);
  });

  it('validates bootstrap fields before writing', async () => {
    const repository = new MemorySetupRepository();
    await expect(bootstrapAdmin(repository, {
      organizationName: '', name: 'Admin', email: 'not-an-email', password: 'short',
    })).rejects.toMatchObject({ code: 'INVALID_SETUP_INPUT' });
    expect(repository.requests).toHaveLength(0);
  });

  it('refuses development seed in production', async () => {
    const repository = new MemorySetupRepository();
    await expect(seedDevelopment(repository, {
      organizationName: 'Demo Org', password: 'development-password',
    }, 'production')).rejects.toMatchObject({ code: 'DEV_SEED_FORBIDDEN' });
    expect(repository.requests).toHaveLength(0);
  });

  it('creates admin, manager, and staff only in an empty non-production database', async () => {
    const repository = new MemorySetupRepository();
    await seedDevelopment(repository, {
      organizationName: 'Demo Org', password: 'development-password',
    }, 'development');
    expect(repository.requests[0]!.users.map((user) => user.role)).toEqual(['ADMIN', 'MANAGER', 'STAFF']);
    expect(repository.requests[0]!.users.every((user) => user.mustChangePassword)).toBe(true);
    expect(repository.requests[0]!.referenceData).toEqual({
      customer: { name: 'Demo Dental Klinik', customerType: 'clinic', status: 'active' },
      product: { sku: 'DEMO-001', name: 'Demo İmplant Seti', unit: 'adet' },
    });
  });
});
