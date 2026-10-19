import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { authenticatedUser } from '../src/modules/capabilities/service.js';

it('GATE-01, KEY-01: keeps comparison disabled without keys; enabling requires strict key configuration and management capability', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/synthetic' };
  expect(loadConfig(base).duplicateComparison).toEqual({ enabled: false });
  expect(() => loadConfig({ ...base, CRM_DUPLICATE_COMPARISON_ENABLED: 'true' })).toThrow();
  const config = loadConfig({ ...base, CRM_DUPLICATE_COMPARISON_ENABLED: 'true', CRM_DUPLICATE_EVIDENCE_KEYRING: JSON.stringify({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 3).toString('base64') } }) });
  expect(config.duplicateComparison?.enabled).toBe(true);
  expect(authenticatedUser({ role: 'STAFF' } as never, config.capabilities, undefined).capabilities.duplicateCustomerComparison).toBe(false);
  expect(authenticatedUser({ role: 'MANAGER' } as never, config.capabilities, undefined).capabilities.duplicateCustomerComparison).toBe(true);
});
