import { expect, it } from 'vitest';
import { decodeDuplicateCursor, encodeDuplicateCursor } from '../src/modules/crm/duplicate-cursor.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';

it('PAIR-04/05, KEY-03: authenticates cursor scope, purpose, source revision and expiry', () => {
  const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 8).toString('base64') } }));
  const context = { organizationId: 'org', view: 'ALL' as const, anchorCustomerId: null, limit: 20, sourceRevision: 'source' };
  const pair = { customerAId: '10000000-0000-4000-8000-000000000001', customerBId: '10000000-0000-4000-8000-000000000002' };
  const cursor = encodeDuplicateCursor(context, pair, keys, 1000);
  expect(decodeDuplicateCursor(cursor, context, keys, 1001)).toEqual(pair);
  expect(() => decodeDuplicateCursor(cursor.slice(0, -2) + 'aa', context, keys, 1001)).toThrow();
  expect(() => decodeDuplicateCursor(cursor, { ...context, organizationId: 'foreign' }, keys, 1001)).toThrow();
  expect(() => decodeDuplicateCursor(cursor, { ...context, sourceRevision: 'changed' }, keys, 1001)).toThrowError(expect.objectContaining({ code: 'CURSOR_RESTART_REQUIRED' }));
  expect(() => decodeDuplicateCursor(cursor, context, keys, 901001)).toThrowError(expect.objectContaining({ code: 'CURSOR_RESTART_REQUIRED' }));
});
