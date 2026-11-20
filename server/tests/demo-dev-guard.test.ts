import { describe, expect, it } from 'vitest';

import { DemoDevError, assertLocalDevelopmentTarget, parseDemoDevArgs } from '../src/db/demo-dev-guard.js';

const DATASET = '0b450339-f273-4f7e-896d-9033558592f5';

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return (error as DemoDevError).code;
  }
  return undefined;
}

describe('development-only demo dataset command', () => {
  it('parses list, create and confirmed purge with a normalized Admin email', () => {
    expect(parseDemoDevArgs(['list', '--admin-email', ' Admin@Example.com ']))
      .toEqual({ command: 'list', adminEmail: 'admin@example.com' });
    expect(parseDemoDevArgs(['create', '--admin-email', 'admin@example.com']).command).toBe('create');
    expect(parseDemoDevArgs(['purge', '--admin-email', 'admin@example.com', '--dataset', DATASET, '--yes']))
      .toEqual({ command: 'purge', adminEmail: 'admin@example.com', datasetId: DATASET });
  });

  it('rejects unknown commands, missing Admin, malformed datasets and unconfirmed purge', () => {
    expect(codeOf(() => parseDemoDevArgs([]))).toBe('DEMO_DEV_USAGE');
    expect(codeOf(() => parseDemoDevArgs(['seed', '--admin-email', 'a@b.c']))).toBe('DEMO_DEV_USAGE');
    expect(codeOf(() => parseDemoDevArgs(['create']))).toBe('DEMO_DEV_USAGE');
    expect(codeOf(() => parseDemoDevArgs(['create', '--admin-email']))).toBe('DEMO_DEV_USAGE');
    expect(codeOf(() => parseDemoDevArgs(['create', '--admin-email', 'a@b.c', '--yes']))).toBe('DEMO_DEV_USAGE');
    expect(codeOf(() => parseDemoDevArgs(['purge', '--admin-email', 'a@b.c', '--dataset', 'x', '--yes']))).toBe('DEMO_DEV_USAGE');
    expect(codeOf(() => parseDemoDevArgs(['purge', '--admin-email', 'a@b.c', '--dataset', DATASET])))
      .toBe('DEMO_DEV_PURGE_CONFIRMATION_REQUIRED');
  });

  it('accepts only NODE_ENV=development on a loopback development database', () => {
    expect(assertLocalDevelopmentTarget({ nodeEnv: 'development', databaseUrl: 'postgresql://localhost:5432/servora_med' }))
      .toEqual({ databaseName: 'servora_med' });
    expect(assertLocalDevelopmentTarget({ nodeEnv: 'development', databaseUrl: 'postgresql://u:p@[::1]:5432/servora_med_dev2' }))
      .toEqual({ databaseName: 'servora_med_dev2' });
  });

  it('refuses production, test, staging and remote targets', () => {
    const local = 'postgresql://localhost:5432/servora_med';
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: 'production', databaseUrl: local })))
      .toBe('DEMO_DEV_NODE_ENV_REFUSED');
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: 'test', databaseUrl: local })))
      .toBe('DEMO_DEV_NODE_ENV_REFUSED');
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: '', databaseUrl: local })))
      .toBe('DEMO_DEV_NODE_ENV_REFUSED');
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: 'development', databaseUrl: 'postgresql://db.example.com/servora_med' })))
      .toBe('DEMO_DEV_NON_LOOPBACK_DATABASE');
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: 'development', databaseUrl: 'postgresql://localhost/servora_med_staging' })))
      .toBe('DEMO_DEV_PROTECTED_DATABASE');
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: 'development', databaseUrl: 'postgresql://localhost/servora_med_test_wd1' })))
      .toBe('DEMO_DEV_TEST_DATABASE');
    expect(codeOf(() => assertLocalDevelopmentTarget({ nodeEnv: 'development', databaseUrl: 'postgresql://localhost/' })))
      .toBe('DEMO_DEV_DATABASE_NAME_REQUIRED');
  });
});
