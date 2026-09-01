import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from '../src/services/notifications-api';

/**
 * TG-002 regression guard: the web parser must recognize every notification
 * kind the server can emit. Reads the server contract source directly so a
 * server-side addition without the matching web change fails CI.
 */
const SERVER_TYPES_SOURCE = readFileSync(
  new URL('../../server/src/modules/notifications/types.ts', import.meta.url),
  'utf8',
);

const SERVER_KINDS_BLOCK = /export const NOTIFICATION_KINDS = \[([\s\S]*?)\] as const;/.exec(
  SERVER_TYPES_SOURCE,
);
const SERVER_NOTIFICATION_KINDS = SERVER_KINDS_BLOCK === null
  ? []
  : [...SERVER_KINDS_BLOCK[1]!.matchAll(/'([a-z]+(?:\.[a-z_]+)*)'/g)].map((match) => match[1]!);

describe('notification kind contract parity (server ↔ web)', () => {
  it('extracts the canonical server kind list', () => {
    // Guard against silent extraction drift: the known server contract has 13 kinds.
    expect(SERVER_NOTIFICATION_KINDS.length).toBeGreaterThanOrEqual(13);
    expect(SERVER_NOTIFICATION_KINDS).toContain('job.assigned');
  });

  it('web recognizes exactly the server kind set including job.invalidated', () => {
    expect(new Set(SERVER_NOTIFICATION_KINDS)).toEqual(new Set(NOTIFICATION_KINDS));
    expect(SERVER_NOTIFICATION_KINDS).toHaveLength(NOTIFICATION_KINDS.length);
    expect(NOTIFICATION_KINDS).toContain('job.invalidated');
  });
});
