#!/usr/bin/env node

/**
 * Pure, ordered migration-history reconciliation.
 *
 * The deployment probe uses this module so that a production history can only
 * be treated as an exact catalog or as an exact prefix of that catalog. Set
 * membership alone is not sufficient: a missing middle migration, reordering,
 * duplicate, or database-ahead history must fail closed.
 */

const VERSION_PATTERN = /^\d{3}_[A-Za-z0-9_]+$/;

/**
 * Keep operator output bounded to canonical migration identifiers. A damaged
 * or tampered database row must never be copied verbatim into deploy logs.
 */
export function formatMigrationVersions(values) {
  return Array.from(values ?? [])
    .map((value) => (typeof value === 'string' && VERSION_PATTERN.test(value) ? value : 'INVALID'))
    .join(',');
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = [];
  for (const value of values) {
    if (seen.has(value) && !duplicates.includes(value)) duplicates.push(value);
    seen.add(value);
  }
  return duplicates;
}

function isCanonicalSequence(values) {
  if (!Array.isArray(values) || values.length === 0) return false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) return false;
    const number = Number.parseInt(value.slice(0, 3), 10);
    if (number !== index + 1) return false;
  }
  return duplicateValues(values).length === 0;
}

/**
 * @param {readonly string[]} catalogVersions
 * @param {readonly string[]} appliedVersions
 * @returns {{
 *   status: 'EXACT'|'PREFIX_WITH_PENDING'|'DIVERGENT'|'DATABASE_AHEAD'|'DUPLICATE_HISTORY'|'INVALID_CATALOG',
 *   pendingVersions: string[],
 *   unexpectedVersions: string[],
 *   duplicateVersions: string[],
 *   reason: string,
 * }}
 */
export function classifyMigrationState(catalogVersions, appliedVersions) {
  const catalog = Array.from(catalogVersions ?? []);
  const applied = Array.from(appliedVersions ?? []);

  if (!isCanonicalSequence(catalog)) {
    return {
      status: 'INVALID_CATALOG',
      pendingVersions: [],
      unexpectedVersions: [],
      duplicateVersions: duplicateValues(catalog),
      reason: 'INVALID_CATALOG',
    };
  }

  const duplicateApplied = duplicateValues(applied);
  const duplicateAppliedNumbers = [];
  const seenNumbers = new Set();
  for (const value of applied) {
    if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) continue;
    const number = value.slice(0, 3);
    if (seenNumbers.has(number) && !duplicateAppliedNumbers.includes(value)) {
      duplicateAppliedNumbers.push(value);
    }
    seenNumbers.add(number);
  }
  const duplicateVersions = [...new Set([...duplicateApplied, ...duplicateAppliedNumbers])];
  if (duplicateVersions.length > 0) {
    return {
      status: 'DUPLICATE_HISTORY',
      pendingVersions: catalog.filter((version) => !applied.includes(version)),
      unexpectedVersions: applied.filter((version) => !catalog.includes(version)),
      duplicateVersions,
      reason: 'DUPLICATE_HISTORY',
    };
  }

  const sharedLength = Math.min(catalog.length, applied.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (catalog[index] !== applied[index]) {
      return {
        status: 'DIVERGENT',
        pendingVersions: catalog.slice(index),
        unexpectedVersions: applied.filter((version) => !catalog.includes(version)),
        duplicateVersions: [],
        reason: 'NON_PREFIX_HISTORY',
      };
    }
  }

  if (applied.length > catalog.length) {
    return {
      status: 'DATABASE_AHEAD',
      pendingVersions: [],
      unexpectedVersions: applied.slice(catalog.length),
      duplicateVersions: [],
      reason: 'DATABASE_AHEAD_OF_CANDIDATE',
    };
  }

  if (applied.length === catalog.length) {
    return {
      status: 'EXACT',
      pendingVersions: [],
      unexpectedVersions: [],
      duplicateVersions: [],
      reason: 'EXACT',
    };
  }

  return {
    status: 'PREFIX_WITH_PENDING',
    pendingVersions: catalog.slice(applied.length),
    unexpectedVersions: [],
    duplicateVersions: [],
    reason: 'PREFIX_WITH_PENDING',
  };
}
