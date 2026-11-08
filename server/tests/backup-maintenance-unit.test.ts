import { describe, expect, it } from 'vitest';

import { maintenanceAllowsPositiveBackupHealth } from '../src/modules/health/backup-maintenance.js';

function poolRows(rows: readonly unknown[]) {
  return { query: async () => ({ rows }) } as never;
}

describe('BR5 shared maintenance fail-closed reader', () => {
  it('permits only a well-formed, explicit unpaused singleton after a revisioned operator change', async () => {
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: false, revision: '1' }]))).toBe(true);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: false, revision: 2 }]))).toBe(true);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: false, revision: '0' }]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: true, revision: '2' }]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: 'false', revision: '2' }]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: false, revision: 'invalid' }]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: false, revision: '-1' }]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([{ paused: false, revision: null }]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([]))).toBe(false);
    expect(await maintenanceAllowsPositiveBackupHealth(poolRows([
      { paused: false, revision: '1' }, { paused: false, revision: '1' },
    ]))).toBe(false);
  });

  it('denies if the primary DB query fails and never caches a prior permit', async () => {
    let reads = 0;
    const pool = {
      query: async () => {
        reads += 1;
        if (reads === 1) return { rows: [{ paused: false, revision: '1' }] };
        throw new Error('database unavailable');
      },
    } as never;
    expect(await maintenanceAllowsPositiveBackupHealth(pool)).toBe(true);
    expect(await maintenanceAllowsPositiveBackupHealth(pool)).toBe(false);
    expect(reads).toBe(2);
  });
});
