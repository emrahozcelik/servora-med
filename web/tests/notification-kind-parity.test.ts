import { describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS as SERVER_NOTIFICATION_KINDS } from '../../server/src/modules/notifications/types';
import { NOTIFICATION_KINDS } from '../src/services/notifications-api';

/**
 * TG-002 regression guard: the web parser must recognize every notification
 * kind the server can emit. Imports the server contract constant directly so a
 * server-side addition without the matching web change fails CI. The server
 * module has no imports, so this pulls no server runtime into the web suite.
 */
function assertNotificationKindParity(
  serverKinds: readonly string[],
  webKinds: readonly string[],
) {
  const server = new Set(serverKinds);
  const web = new Set(webKinds);
  const missingInWeb = [...server].filter((kind) => !web.has(kind));
  const extraInWeb = [...web].filter((kind) => !server.has(kind));
  if (missingInWeb.length > 0 || extraInWeb.length > 0) {
    throw new Error([
      missingInWeb.length > 0 ? `missing in web: ${missingInWeb.join(', ')}` : '',
      extraInWeb.length > 0 ? `unsupported by server: ${extraInWeb.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

describe('notification kind contract parity (server ↔ web)', () => {
  it('loads the canonical server kind list', () => {
    // Guard against an empty or truncated import: the known server contract has 13 kinds.
    expect(SERVER_NOTIFICATION_KINDS.length).toBeGreaterThanOrEqual(13);
    expect(SERVER_NOTIFICATION_KINDS).toContain('job.assigned');
  });

  it('server kinds are unique non-empty strings', () => {
    for (const kind of SERVER_NOTIFICATION_KINDS) {
      expect(typeof kind).toBe('string');
      expect(kind.length).toBeGreaterThan(0);
    }
    expect(new Set(SERVER_NOTIFICATION_KINDS).size).toBe(SERVER_NOTIFICATION_KINDS.length);
  });

  it('rejects a server-only notification kind', () => {
    expect(() => assertNotificationKindParity(
      [...SERVER_NOTIFICATION_KINDS, 'job.v2_invalidated'],
      NOTIFICATION_KINDS,
    )).toThrow(/missing in web: job\.v2_invalidated/);
  });

  it('rejects a web-only notification kind', () => {
    expect(() => assertNotificationKindParity(
      SERVER_NOTIFICATION_KINDS,
      [...NOTIFICATION_KINDS, 'web.only-kind'],
    )).toThrow(/unsupported by server: web\.only-kind/);
  });

  it('web recognizes exactly the server kind set including job.invalidated', () => {
    expect(() => assertNotificationKindParity(
      SERVER_NOTIFICATION_KINDS,
      NOTIFICATION_KINDS,
    )).not.toThrow();
    expect(NOTIFICATION_KINDS).toContain('job.invalidated');
  });
});
