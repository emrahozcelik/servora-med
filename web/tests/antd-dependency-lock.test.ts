import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8'));

describe('Ant Design dependency pin and lockfile', () => {
  it('uses an exact semver version and keeps npm lockfile in sync', () => {
    const version: string = pkg.dependencies.antd;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages[''].dependencies.antd).toBe(version);
    expect(lock.packages['node_modules/antd'].version).toBe(version);
  });
});
