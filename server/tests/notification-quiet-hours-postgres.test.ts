import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { instantFromLocal } from '../src/modules/job-cards/local-calendar.js';
import {
  DEFAULT_NOTIFICATION_WINDOW,
  isWithinNotificationWindow,
} from '../src/modules/notifications/quiet-hours.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * OVR-6 Q1 — TS predicate / SQL renderer parity.
 *
 * Contract §3.4/§10 Q1: the module owns both `isWithinNotificationWindow`
 * (Intl wall clock) and the SQL boolean expression used by discovery. They must
 * agree on every instant, including the exact boundaries, Sunday and a DST
 * date. The worker's discovery query and its TypeScript re-check read the same
 * rule, so a disagreement would either send outside the window or suppress an
 * in-window send.
 */

const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : null;

afterAll(async () => {
  await pool?.end();
});

type Case = { label: string; instant: Date; timezone: string };

function local(dateKey: string, hour: number, minute = 0, second = 0, tz = 'Europe/Istanbul'): Date {
  return instantFromLocal(dateKey, hour, minute, tz, second);
}

function cases(): Case[] {
  const matrix: Case[] = [];
  for (const [label, hour, minute, second] of [
    ['07:59', 7, 59, 0],
    ['08:00', 8, 0, 0],
    ['20:59', 20, 59, 0],
    ['21:00', 21, 0, 0],
  ] as const) {
    matrix.push({
      label: `Istanbul Monday ${label}`,
      instant: local('2026-11-23', hour, minute, second),
      timezone: 'Europe/Istanbul',
    });
  }
  matrix.push(
    {
      label: 'Istanbul Sunday 12:00 closed',
      instant: local('2026-11-22', 12),
      timezone: 'Europe/Istanbul',
    },
    {
      label: 'Istanbul Saturday 21:00 closed until Monday 08:00',
      instant: local('2026-11-21', 21),
      timezone: 'Europe/Istanbul',
    },
    {
      label: 'Istanbul Monday 08:00 open after the Sunday',
      instant: local('2026-11-23', 8),
      timezone: 'Europe/Istanbul',
    },
    {
      label: 'Berlin spring-forward 07:59 closed',
      instant: local('2026-03-29', 7, 59, 59, 'Europe/Berlin'),
      timezone: 'Europe/Berlin',
    },
    {
      label: 'Berlin spring-forward 08:00 open',
      instant: local('2026-03-29', 8, 0, 0, 'Europe/Berlin'),
      timezone: 'Europe/Berlin',
    },
    {
      label: 'Berlin fall-back 20:59 open',
      instant: local('2026-10-25', 20, 59, 59, 'Europe/Berlin'),
      timezone: 'Europe/Berlin',
    },
    {
      label: 'Berlin fall-back 21:00 closed',
      instant: local('2026-10-25', 21, 0, 0, 'Europe/Berlin'),
      timezone: 'Europe/Berlin',
    },
    {
      label: 'New York Monday 13:30 open while Istanbul is 21:30 closed',
      instant: local('2026-11-23', 13, 30, 0, 'America/New_York'),
      timezone: 'America/New_York',
    },
    {
      label: 'New York Monday 21:30 closed',
      instant: local('2026-11-23', 21, 30, 0, 'America/New_York'),
      timezone: 'America/New_York',
    },
  );
  return matrix;
}

async function sqlIsOpen(instant: Date, timezone: string): Promise<boolean> {
  const expression = DEFAULT_NOTIFICATION_WINDOW.sql({
    instant: '$1::timestamptz',
    timezone: '$2::text',
  });
  const result = await pool!.query<{ is_open: boolean }>(
    `SELECT (${expression}) AS is_open`,
    [instant, timezone],
  );
  return result.rows[0]!.is_open;
}

describe.skipIf(!databaseUrl)('OVR-6 quiet hours — SQL / TypeScript parity', () => {
  it('Q1 agrees on every boundary, Sunday and DST instant', async () => {
    let openCount = 0;
    let closedCount = 0;
    for (const entry of cases()) {
      const expected = isWithinNotificationWindow(entry.instant, entry.timezone);
      const actual = await sqlIsOpen(entry.instant, entry.timezone);
      expect(actual, entry.label).toBe(expected);
      if (expected) openCount += 1;
      else closedCount += 1;
    }
    // The matrix must exercise both outcomes; an always-open or always-closed
    // renderer would otherwise pass silently.
    expect(openCount).toBeGreaterThan(0);
    expect(closedCount).toBeGreaterThan(0);
  });

  it('Q1 renders the instant and the timezone as caller-supplied refs', async () => {
    const instant = local('2026-11-23', 21, 0);
    const timezone = 'Europe/Istanbul';
    // The same instant is open in Berlin and closed in Istanbul; a renderer
    // that ignored the timezone ref would return the same value twice.
    expect(await sqlIsOpen(instant, 'Europe/Berlin')).toBe(true);
    expect(await sqlIsOpen(instant, timezone)).toBe(false);
  });
});
