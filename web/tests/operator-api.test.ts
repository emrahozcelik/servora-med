import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getOperatorSession,
  isModuleVersionConflict,
  listInstallationModules,
  operatorErrorMessage,
  operatorLogin,
  operatorLogout,
  parseInstallationModule,
  parseOperatorProfile,
  setInstallationModuleEnabled,
} from '../src/operator/operator-api';
import { ApiError } from '../src/services/api';

const operator = {
  id: 'op-1', name: 'Kurulum Operatörü', email: 'operator@example.com', capabilities: ['MODULE_MANAGEMENT'],
};
const overviewModule = {
  key: 'OVERVIEW', label: 'Genel Bakış', enabled: true, version: 3,
  source: 'OPERATOR', updatedAt: '2026-11-26T09:30:00.000Z',
};

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve(new Response(
    body === undefined ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  ));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('operator DTO parsing', () => {
  it('accepts the contract shapes', () => {
    expect(parseOperatorProfile(operator)).toEqual(operator);
    expect(parseInstallationModule(overviewModule)).toEqual(overviewModule);
    expect(parseInstallationModule({ ...overviewModule, source: 'ENV_TAKEOVER' }).source).toBe('ENV_TAKEOVER');
  });

  it('rejects malformed operator profiles', () => {
    expect(() => parseOperatorProfile(null)).toThrow(ApiError);
    expect(() => parseOperatorProfile({ ...operator, capabilities: 'MODULE_MANAGEMENT' })).toThrow(ApiError);
    expect(() => parseOperatorProfile({ ...operator, capabilities: [1] })).toThrow(ApiError);
    expect(() => parseOperatorProfile({ ...operator, email: '' })).toThrow(ApiError);
  });

  it.each([
    ['non-boolean enabled', { enabled: 'true' }],
    ['fractional version', { version: 1.5 }],
    ['negative version', { version: -1 }],
    ['string version', { version: '3' }],
    ['unknown source', { source: 'ENV' }],
    ['missing source', { source: undefined }],
    ['unparseable timestamp', { updatedAt: 'yesterday' }],
    ['empty label', { label: '' }],
  ])('rejects a module row with %s', (_name, override) => {
    expect(() => parseInstallationModule({ ...overviewModule, ...override })).toThrow(ApiError);
  });
});

describe('operator requests', () => {
  it('logs in against /api/operator/login with a JSON body and returns the profile', async () => {
    const fetchMock = vi.fn(() => respond(200, { operator }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(operatorLogin({ email: 'operator@example.com', password: 'secret-value' })).resolves.toEqual(operator);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/operator/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'operator@example.com', password: 'secret-value' });
  });

  it('treats a 401 from /me as "no session", but surfaces other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond(401, { code: 'OPERATOR_UNAUTHENTICATED', error: 'x' })));
    await expect(getOperatorSession()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(() => respond(500, { code: 'X', error: 'x' })));
    await expect(getOperatorSession()).rejects.toMatchObject({ status: 500 });

    vi.stubGlobal('fetch', vi.fn(() => respond(200, { operator })));
    await expect(getOperatorSession()).resolves.toEqual(operator);
  });

  it('lists modules and rejects a response without a modules array', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond(200, { modules: [overviewModule] })));
    await expect(listInstallationModules()).resolves.toEqual([overviewModule]);

    vi.stubGlobal('fetch', vi.fn(() => respond(200, { items: [] })));
    await expect(listInstallationModules()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('PUTs expectedVersion to the encoded module path and validates the echoed key', async () => {
    const fetchMock = vi.fn(() => respond(200, { module: { ...overviewModule, enabled: false, version: 4 } }));
    vi.stubGlobal('fetch', fetchMock);

    const updated = await setInstallationModuleEnabled('OVERVIEW', { enabled: false, expectedVersion: 3 });

    expect(updated).toMatchObject({ key: 'OVERVIEW', enabled: false, version: 4 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/operator/modules/OVERVIEW');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false, expectedVersion: 3 });

    vi.stubGlobal('fetch', vi.fn(() => respond(200, { module: { ...overviewModule, key: 'OTHER' } })));
    await expect(setInstallationModuleEnabled('OVERVIEW', { enabled: true, expectedVersion: 3 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('logs out with a POST that accepts a 204', async () => {
    const fetchMock = vi.fn(() => respond(204));
    vi.stubGlobal('fetch', fetchMock);
    await expect(operatorLogout()).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/operator/logout');
  });

  it('carries the contract error code on a version conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond(409, { code: 'MODULE_VERSION_CONFLICT', error: 'x' })));
    const error = await setInstallationModuleEnabled('OVERVIEW', { enabled: true, expectedVersion: 1 })
      .catch((caught: unknown) => caught);
    expect(isModuleVersionConflict(error)).toBe(true);
    expect(isModuleVersionConflict(new ApiError(409, 'OTHER', 'x'))).toBe(false);
  });
});

describe('operator error copy', () => {
  it('maps the contract status codes to Turkish guidance', () => {
    expect(operatorErrorMessage(new ApiError(401, 'INVALID_CREDENTIALS', 'x'), 'login')).toBe('E-posta veya parola hatalı.');
    expect(operatorErrorMessage(new ApiError(401, 'OPERATOR_UNAUTHENTICATED', 'x'), 'modules')).toContain('oturumunuz sona erdi');
    expect(operatorErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'modules')).toContain('yetkisi yok');
    expect(operatorErrorMessage(new ApiError(403, 'INVALID_ORIGIN', 'x'), 'login')).toContain('adresinden');
    expect(operatorErrorMessage(new ApiError(409, 'MODULE_VERSION_CONFLICT', 'x'), 'update')).toContain('başka bir oturumda');
    expect(operatorErrorMessage(new ApiError(503, 'MODULE_STATE_UNAVAILABLE', 'x', true), 'modules')).toContain('okunamıyor');
    const limited = new ApiError(429, 'RATE_LIMITED', 'x');
    limited.retryAfterSeconds = 30;
    expect(operatorErrorMessage(limited, 'login')).toContain('30 saniye');
    expect(operatorErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulaşılamadı.'), 'login')).toBe('Sunucuya ulaşılamadı.');
    expect(operatorErrorMessage(new Error('boom'), 'login')).toBe('Giriş yapılamadı. Lütfen tekrar deneyin.');
  });
});
