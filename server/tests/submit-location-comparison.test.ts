import { describe, expect, it } from 'vitest';

import {
  classifySubmitLocationComparison,
  haversineMeters,
} from '../src/modules/job-cards/submit-location-comparison.js';

const POLICY = { warningDistanceMeters: 300, maxReliableAccuracyMeters: 100 };

// Kızılay, Ankara → Kadıköy, İstanbul. Independent reference value ≈ 349 km.
const ANKARA = { latitude: 39.92077, longitude: 32.85411 };
const ISTANBUL = { latitude: 40.99025, longitude: 29.02702 };

describe('haversineMeters', () => {
  it('returns approximately zero for identical snapshots', () => {
    expect(haversineMeters(ANKARA.latitude, ANKARA.longitude, ANKARA.latitude, ANKARA.longitude))
      .toBeCloseTo(0, 6);
  });

  it('matches a known distant pair within tolerance', () => {
    const distance = haversineMeters(
      ANKARA.latitude, ANKARA.longitude, ISTANBUL.latitude, ISTANBUL.longitude,
    );
    expect(distance).toBeGreaterThan(340_000);
    expect(distance).toBeLessThan(360_000);
  });

  it('is symmetric', () => {
    const forward = haversineMeters(
      ANKARA.latitude, ANKARA.longitude, ISTANBUL.latitude, ISTANBUL.longitude,
    );
    const backward = haversineMeters(
      ISTANBUL.latitude, ISTANBUL.longitude, ANKARA.latitude, ANKARA.longitude,
    );
    expect(backward).toBeCloseTo(forward, 6);
  });

  it('measures one degree of latitude as roughly 111.2 km', () => {
    expect(haversineMeters(39, 32, 40, 32)).toBeCloseTo(111_195, -2);
  });

  it('resolves threshold-relevant nearby distances', () => {
    // ~285 m apart: confidently below the 300 m policy boundary.
    const below = haversineMeters(39.92077, 32.85411, 39.92333, 32.85411);
    expect(below).toBeGreaterThan(270);
    expect(below).toBeLessThan(300);
    // ~335 m apart: confidently above it.
    const above = haversineMeters(39.92077, 32.85411, 39.92378, 32.85411);
    expect(above).toBeGreaterThan(300);
    expect(above).toBeLessThan(350);
  });
});

describe('classifySubmitLocationComparison', () => {
  const reliable = { startAccuracyMeters: 18, submitAccuracyMeters: 24 };
  it.each([
    ['just below the boundary', 299.9, 'MATCH'],
    ['exact boundary', 300, 'DIFFERENT'],
    ['just above the boundary', 300.1, 'DIFFERENT'],
    ['identical snapshots', 0, 'MATCH'],
    ['far apart', 1240.5, 'DIFFERENT'],
  ] as const)('%s (%s m) → %s', (_name, distanceMeters, outcome) => {
    expect(classifySubmitLocationComparison({ distanceMeters, ...reliable, policy: POLICY }))
      .toBe(outcome);
  });

  it('treats the reliability ceiling as inclusive', () => {
    expect(classifySubmitLocationComparison({
      distanceMeters: 10, startAccuracyMeters: 100, submitAccuracyMeters: 100, policy: POLICY,
    })).toBe('MATCH');
  });

  it.each([
    ['poor START fix', 150, 18],
    ['poor SUBMIT fix', 18, 150],
    ['both poor', 250, 400],
  ])('classifies %s as UNRELIABLE even for nearby snapshots', (_name, start, submit) => {
    expect(classifySubmitLocationComparison({
      distanceMeters: 12, startAccuracyMeters: start, submitAccuracyMeters: submit, policy: POLICY,
    })).toBe('UNRELIABLE');
  });

  it('classifies UNRELIABLE for far snapshots too (never a false DIFFERENT)', () => {
    expect(classifySubmitLocationComparison({
      distanceMeters: 5_000, startAccuracyMeters: 18, submitAccuracyMeters: 500, policy: POLICY,
    })).toBe('UNRELIABLE');
  });

  it('honours a custom policy without touching the primitive', () => {
    const custom = { warningDistanceMeters: 1_000, maxReliableAccuracyMeters: 50 };
    expect(classifySubmitLocationComparison({
      distanceMeters: 500, startAccuracyMeters: 18, submitAccuracyMeters: 24, policy: custom,
    })).toBe('MATCH');
    expect(classifySubmitLocationComparison({
      distanceMeters: 500, startAccuracyMeters: 60, submitAccuracyMeters: 24, policy: custom,
    })).toBe('UNRELIABLE');
  });
});
