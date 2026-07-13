import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord, UserRole } from '../src/modules/auth/types.js';
import type {
  ProductRepository,
  ProductTransaction,
} from '../src/modules/products/repository.js';
import type {
  AppendProductAuditInput,
  CreateProductRecord,
  Product,
  ProductFilters,
  SetProductActiveRecord,
  UpdateProductRecord,
} from '../src/modules/products/types.js';

const config = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000,
  databaseUrl: 'postgresql://unused', logLevel: 'silent',
  corsOrigin: 'https://app.example.com', sessionTtlSeconds: 28_800,
  loginRateLimitMax: 100, rateLimitWindowMs: 60_000,
};

class MemoryAuthRepository implements AuthRepository {
  sessions: SessionRecord[] = [];

  constructor(readonly user: AuthUserRecord) {}

  async findUserByEmail(email: string) { return this.user.email === email ? this.user : null; }
  async findUserById(id: string) { return this.user.id === id ? this.user : null; }
  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const session = { ...input, id: `session-${this.sessions.length + 1}`, revokedAt: null };
    this.sessions.push(session);
    return session;
  }
  async findSessionWithUser(hash: string) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    return session ? { session, user: this.user } : null;
  }
  async revokeSession(hash: string, at: Date) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    if (session) session.revokedAt = at;
  }
  async updatePasswordAndRevokeSessions() { return false; }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1', organizationId: 'org-1', name: 'İmplant Seti', sku: 'IMP-1',
    brand: 'Servora', category: 'İmplant', model: null, unit: 'set', referencePrice: 1250,
    isActive: true, version: 1, createdAt: new Date('2026-07-13T08:00:00.000Z'),
    updatedAt: new Date('2026-07-13T08:00:00.000Z'), ...overrides,
  };
}

class MemoryProductRepository implements ProductRepository, ProductTransaction {
  products = new Map<string, Product>([['product-1', product()]]);
  filters: ProductFilters | null = null;
  audits: AppendProductAuditInput[] = [];

  async listProducts(organizationId: string, filters: ProductFilters) {
    this.filters = filters;
    const q = filters.q?.toLocaleLowerCase('tr') ?? null;
    const items = [...this.products.values()].filter((item) =>
      item.organizationId === organizationId
      && (filters.status === 'all' || item.isActive === (filters.status === 'active'))
      && (!q || [item.name, item.sku, item.brand, item.category, item.model]
        .some((value) => value?.toLocaleLowerCase('tr').includes(q))));
    return { items: items.slice(filters.offset, filters.offset + filters.limit),
      total: items.length, limit: filters.limit, offset: filters.offset };
  }
  async getProduct(organizationId: string, productId: string) {
    const current = this.products.get(productId);
    return current?.organizationId === organizationId ? current : null;
  }
  async execute<T>(work: (tx: ProductTransaction) => Promise<T>) { return work(this); }
  async lockProduct(organizationId: string, productId: string) {
    return this.getProduct(organizationId, productId);
  }
  async createProduct(input: CreateProductRecord) {
    const created = product({ ...input, id: `product-${this.products.size + 1}`, sku: input.sku,
      brand: input.brand, category: input.category, model: input.model, unit: input.unit,
      referencePrice: input.referencePrice });
    this.products.set(created.id, created);
    return created;
  }
  async updateProduct(input: UpdateProductRecord) {
    const current = await this.getProduct(input.organizationId, input.productId);
    if (!current || current.version !== input.expectedVersion) return null;
    const updated = product({ ...current, ...input, version: current.version + 1 });
    this.products.set(updated.id, updated);
    return updated;
  }
  async setProductActive(input: SetProductActiveRecord) {
    const current = await this.getProduct(input.organizationId, input.productId);
    if (!current || current.version !== input.expectedVersion) return null;
    const updated = product({ ...current, isActive: input.isActive, version: current.version + 1 });
    this.products.set(updated.id, updated);
    return updated;
  }
  async appendAudit(input: AppendProductAuditInput) { this.audits.push(input); }
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function createApp(role: UserRole = 'MANAGER', mustChangePassword = false) {
  const authRepository = new MemoryAuthRepository({
    id: `${role.toLowerCase()}-1`, organizationId: 'org-1', name: role,
    email: `${role.toLowerCase()}@example.com`, passwordHash: await hashPassword('correct-password'),
    role, mustChangePassword, isActive: true, version: 1,
  });
  const productRepository = new MemoryProductRepository();
  const app = await buildApp(config, { authRepository, productRepository });
  apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: authRepository.user.email, password: 'correct-password' } });
  return { app, productRepository, cookie: login.headers['set-cookie'] as string };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Product HTTP routes', () => {
  it('requires authentication and a completed forced-password change', async () => {
    const { app } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/products' })).statusCode).toBe(401);

    const forced = await createApp('MANAGER', true);
    const response = await forced.app.inject({ method: 'GET', url: '/api/products',
      headers: { cookie: forced.cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('registers the exact Product route surface', async () => {
    const { app, cookie } = await createApp();
    const routes = [
      ['GET', '/api/products', undefined],
      ['POST', '/api/products', { name: 'Cerrahi Frez' }],
      ['GET', '/api/products/product-1', undefined],
      ['PATCH', '/api/products/product-1', { expectedVersion: 1, name: 'Yeni Set' }],
      ['POST', '/api/products/product-1/activate', { expectedVersion: 1 }],
      ['POST', '/api/products/product-1/deactivate', { expectedVersion: 1 }],
    ] as const;
    for (const [method, url, payload] of routes) {
      const response = await app.inject({ method, url, payload, headers: { cookie } });
      expect(response.statusCode, `${method} ${url}`).not.toBe(404);
    }
    expect((await app.inject({ method: 'DELETE', url: '/api/products/product-1',
      headers: { cookie } })).statusCode).toBe(404);
  });

  it('creates with optional catalog fields omitted or null and propagates the actor', async () => {
    const { app, productRepository, cookie } = await createApp();
    const response = await app.inject({ method: 'POST', url: '/api/products', headers: { cookie },
      payload: { name: 'Cerrahi Frez', sku: null, referencePrice: null } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: 'Cerrahi Frez', sku: null, brand: null,
      category: null, model: null, unit: null, referencePrice: null });
    expect(productRepository.audits).toContainEqual(expect.objectContaining({
      organizationId: 'org-1', actorUserId: 'manager-1', eventType: 'PRODUCT_CREATED',
    }));
  });

  it('applies list defaults and passes only q/status/limit/offset', async () => {
    const { app, productRepository, cookie } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/products',
      headers: { cookie } })).statusCode).toBe(200);
    expect(productRepository.filters).toEqual({ q: null, status: 'active', limit: 50, offset: 0 });

    await app.inject({ method: 'GET',
      url: '/api/products?q=implant&status=all&limit=25&offset=5', headers: { cookie } });
    expect(productRepository.filters).toEqual({ q: 'implant', status: 'all', limit: 25, offset: 5 });
  });

  it.each([
    '/api/products?unknown=x', '/api/products?q=a&q=b', '/api/products?status=enabled',
    '/api/products?status=active&status=all', '/api/products?limit=0', '/api/products?limit=201',
    '/api/products?limit=1.5', '/api/products?limit=abc', '/api/products?offset=-1',
    '/api/products?offset=1.5', '/api/products?offset=a',
  ])('rejects invalid or duplicate list query values: %s', async (url) => {
    const { app, cookie } = await createApp();
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it.each([
    { expectedVersion: 1, name: 'X' }, { name: 'X', isActive: true }, { name: 'X', version: 1 },
    { name: 'X', organizationId: 'org-2' }, { name: 'X', stockQuantity: 2 },
    { name: 'X', cost: 4 }, { name: 'X', currency: 'TRY' }, { name: 'X', lotTracking: true },
  ])('rejects non-canonical create fields: %j', async (payload) => {
    const { app, cookie } = await createApp();
    expect((await app.inject({ method: 'POST', url: '/api/products', payload,
      headers: { cookie } })).statusCode).toBe(400);
  });

  it('requires a name on create and JSON number or null for referencePrice', async () => {
    const { app, cookie } = await createApp();
    for (const payload of [{}, { name: '' }, { name: 'X', referencePrice: '10' },
      { name: 'X', referencePrice: -1 }]) {
      expect((await app.inject({ method: 'POST', url: '/api/products', payload,
        headers: { cookie } })).statusCode).toBe(400);
    }
  });

  it('accepts a partial patch without replacing omitted fields', async () => {
    const { app, cookie } = await createApp();
    const response = await app.inject({ method: 'PATCH', url: '/api/products/product-1',
      headers: { cookie }, payload: { expectedVersion: 1, sku: 'IMP-2' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'İmplant Seti', sku: 'IMP-2', brand: 'Servora' });
  });

  it.each([
    {}, { expectedVersion: 1 }, { expectedVersion: 0, name: 'X' },
    { expectedVersion: 1.5, name: 'X' }, { expectedVersion: 1, sku: 12 },
    { expectedVersion: 1, referencePrice: '10' }, { expectedVersion: 1, isActive: false },
  ])('rejects invalid or non-canonical patch bodies: %j', async (payload) => {
    const { app, cookie } = await createApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/products/product-1', payload,
      headers: { cookie } })).statusCode).toBe(400);
  });

  it.each([
    ['/api/products/product-1/activate', {}],
    ['/api/products/product-1/deactivate', { expectedVersion: 1, reason: 'duplicate' }],
    ['/api/products/product-1/deactivate', { expectedVersion: -1 }],
  ])('requires the exact lifecycle body for %s', async (url, payload) => {
    const { app, cookie } = await createApp();
    expect((await app.inject({ method: 'POST', url, payload,
      headers: { cookie } })).statusCode).toBe(400);
  });

  it('allows Staff reads while service-owned policy rejects mutations', async () => {
    const { app, cookie } = await createApp('STAFF');
    expect((await app.inject({ method: 'GET', url: '/api/products',
      headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/products/product-1',
      headers: { cookie } })).statusCode).toBe(200);
    const mutation = await app.inject({ method: 'POST', url: '/api/products',
      headers: { cookie }, payload: { name: 'Yetkisiz ürün' } });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serializes concealed not-found and stable version conflicts safely', async () => {
    const { app, cookie } = await createApp();
    const missing = await app.inject({ method: 'GET', url: '/api/products/cross-org-id',
      headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });

    const conflict = await app.inject({ method: 'PATCH', url: '/api/products/product-1',
      headers: { cookie }, payload: { expectedVersion: 9, name: 'Çakışan ad' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'VERSION_CONFLICT',
      details: { currentVersion: 1 } });
  });
});
