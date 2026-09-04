import { describe, expect, it } from 'vitest';

import {
  BUILD_IDENTITY,
  BUILD_SHA_PATTERN,
  BUILD_SHORT_SHA_LENGTH,
  createBuildIdentity,
} from '../src/build-identity';

const RELEASE_SHA = '6325e44bf774d2cb0de2c4cd27ba93443b57d4c0';

describe('frontend build identity metadata', () => {
  it('resolves the product version from build metadata, not a retyped literal', () => {
    expect(BUILD_IDENTITY.appVersion).toBe('0.1.0');
    expect(BUILD_IDENTITY.appVersion).not.toBe('');
  });

  it('accepts an exact 40-character injected SHA', () => {
    const identity = createBuildIdentity({
      appVersion: '0.1.0',
      rawBuildSha: RELEASE_SHA,
      development: false,
    });
    expect(identity.buildSha).toBe(RELEASE_SHA);
    expect(identity.buildShortSha).toBe('6325e44');
    expect(identity.buildShortSha).toHaveLength(BUILD_SHORT_SHA_LENGTH);
    expect(identity.buildLabel).toBe('Servora Med 0.1.0 · Build 6325e44');
    expect(identity.isDevelopmentBuild).toBe(false);
    expect(identity.isValidRelease).toBe(true);
  });

  it('normalizes SHA case deterministically', () => {
    const identity = createBuildIdentity({
      appVersion: '0.1.0',
      rawBuildSha: RELEASE_SHA.toUpperCase(),
      development: false,
    });
    expect(identity.buildSha).toBe(RELEASE_SHA);
    expect(identity.buildShortSha).toBe('6325e44');
  });

  it('falls back to an explicit dev identity in local development', () => {
    const identity = createBuildIdentity({ appVersion: '0.1.0', rawBuildSha: '', development: true });
    expect(identity.buildSha).toBeNull();
    expect(identity.buildShortSha).toBe('dev');
    expect(identity.buildLabel).toBe('Servora Med 0.1.0 · Build dev');
    expect(identity.isDevelopmentBuild).toBe(true);
    expect(identity.isValidRelease).toBe(false);
  });

  it('never renders undefined or an empty build label', () => {
    for (const source of [
      { appVersion: '', rawBuildSha: '', development: true },
      { appVersion: '0.1.0', rawBuildSha: 'not-a-sha', development: false },
      { appVersion: '0.1.0', rawBuildSha: '6325e44', development: false },
      { appVersion: '0.1.0', rawBuildSha: '', development: false },
    ]) {
      const identity = createBuildIdentity(source);
      expect(identity.buildLabel).not.toContain('undefined');
      expect(identity.buildShortSha.trim()).not.toBe('');
      expect(identity.buildLabel.trim()).not.toBe('');
    }
  });

  it('marks a malformed production SHA as an invalid release, not a dev build', () => {
    const identity = createBuildIdentity({
      appVersion: '0.1.0',
      rawBuildSha: 'zzz',
      development: false,
    });
    expect(identity.buildSha).toBeNull();
    expect(identity.isDevelopmentBuild).toBe(false);
    expect(identity.isValidRelease).toBe(false);
  });

  it('keeps the production SHA pattern at exactly 40 lowercase hex characters', () => {
    expect(BUILD_SHA_PATTERN.test(RELEASE_SHA)).toBe(true);
    expect(BUILD_SHA_PATTERN.test('6325e44')).toBe(false);
    expect(BUILD_SHA_PATTERN.test(`${RELEASE_SHA}x`)).toBe(false);
    expect(BUILD_SHA_PATTERN.test(RELEASE_SHA.toUpperCase())).toBe(false);
  });
});
