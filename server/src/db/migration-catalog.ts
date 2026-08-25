import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Shared migration catalog + compatibility checker (SD1).
 *
 * Single source of truth for:
 * - repository migration inventory,
 * - expected migration head,
 * - catalog integrity (duplicate / gap / invalid filename),
 * - pure DB history comparison (COMPATIBLE/BEHIND/AHEAD/DIVERGED/EMPTY).
 *
 * SD1 MUST NOT mutate DB, start server, or change health/deploy.
 * Callers supply the authoritative migrations directory (src vs dist).
 */

export type MigrationCatalogEntry = {
  readonly number: number;
  readonly version: string;
  readonly filename: string;
  readonly path: string;
};

export type MigrationCatalog = {
  readonly directory: string;
  readonly entries: readonly MigrationCatalogEntry[];
  readonly head: MigrationCatalogEntry | null;
  readonly count: number;
};

export type MigrationCatalogInvalidReason =
  | 'DUPLICATE_MIGRATION_NUMBER'
  | 'MIGRATION_NUMBER_GAP'
  | 'INVALID_MIGRATION_FILENAME';

export class MigrationCatalogError extends Error {
  readonly code = 'CATALOG_INVALID' as const;
  readonly reason: MigrationCatalogInvalidReason;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    reason: MigrationCatalogInvalidReason,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MigrationCatalogError';
    this.reason = reason;
    this.details = details;
  }
}

/**
 * Canonical migration filename convention: NNN_description.sql
 * NNN is zero-padded 3-digit numeric prefix, description is [A-Za-z0-9_]+.
 * Only *.sql files are considered; non-sql files are intentionally ignored.
 * Any *.sql file not matching the convention makes the catalog invalid.
 */
const MIGRATION_FILENAME_PATTERN = /^(\d{3})_([A-Za-z0-9_]+)\.sql$/;

export function parseMigrationFilename(filename: string): { number: number; version: string } | null {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename);
  if (!match) return null;
  const number = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(number)) return null;
  const version = filename.slice(0, -'.sql'.length);
  return { number, version };
}

export async function loadMigrationCatalog(migrationsDirectory: string): Promise<MigrationCatalog> {
  const files = await readdir(migrationsDirectory);

  const entries: MigrationCatalogEntry[] = [];
  const seenNumbers = new Map<number, string>();

  for (const filename of files) {
    // Ignore non-sql files (README, dotfiles, editor backups, etc.)
    if (!filename.endsWith('.sql')) continue;
    // Ignore dotfiles even if they end with .sql? Treat as invalid if they match pattern?
    // Spec: do not treat unrelated dotfiles as migrations — they are non-sql anyway,
    // but a .sql dotfile like .001_foo.sql would be malformed => invalid.
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new MigrationCatalogError(
        'INVALID_MIGRATION_FILENAME',
        `Invalid migration filename: ${filename}`,
        { filename, directory: migrationsDirectory },
      );
    }
    const { number, version } = parsed;
    const existing = seenNumbers.get(number);
    if (existing) {
      throw new MigrationCatalogError(
        'DUPLICATE_MIGRATION_NUMBER',
        `Duplicate migration number ${String(number).padStart(3, '0')}: ${existing} and ${filename}`,
        { number, filenames: [existing, filename], directory: migrationsDirectory },
      );
    }
    seenNumbers.set(number, filename);
    entries.push({
      number,
      version,
      filename,
      path: path.join(migrationsDirectory, filename),
    });
  }

  // Deterministic numeric order, independent of OS locale / filesystem order.
  entries.sort((a, b) => a.number - b.number);

  // Gap validation: contiguous from first canonical number through head.
  if (entries.length > 0) {
    const first = entries[0]!.number;
    for (let i = 0; i < entries.length; i += 1) {
      const expected = first + i;
      const actual = entries[i]!.number;
      if (actual !== expected) {
        const missing = expected;
        throw new MigrationCatalogError(
          'MIGRATION_NUMBER_GAP',
          `Migration number gap: missing ${String(missing).padStart(3, '0')} between ${String(entries[i - 1]!.number).padStart(3, '0')} and ${String(actual).padStart(3, '0')}`,
          {
            missingNumber: missing,
            missingVersionPrefix: String(missing).padStart(3, '0'),
            expectedNumber: expected,
            actualNumber: actual,
            directory: migrationsDirectory,
          },
        );
      }
    }
    // Verify first migration is 001 by inspecting real history; if not, still enforce contiguity
    // but SD1 spec says STOP if intentional exception — current repo starts at 001, so no exception.
  }

  const head = entries.length > 0 ? entries[entries.length - 1]! : null;
  return {
    directory: migrationsDirectory,
    entries,
    head,
    count: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Pure compatibility comparator
// ---------------------------------------------------------------------------

export type MigrationCompatibility =
  | {
      readonly status: 'COMPATIBLE';
      readonly catalog: MigrationCatalog;
      readonly appliedVersions: readonly string[];
    }
  | {
      readonly status: 'BEHIND';
      readonly catalog: MigrationCatalog;
      readonly appliedVersions: readonly string[];
      readonly appliedHead: string | null;
      readonly expectedHead: string;
      readonly pendingVersions: readonly string[];
      readonly pendingEntries: readonly MigrationCatalogEntry[];
    }
  | {
      readonly status: 'AHEAD';
      readonly catalog: MigrationCatalog;
      readonly appliedVersions: readonly string[];
      readonly appliedHead: string | null;
      readonly expectedHead: string;
      readonly unexpectedVersions: readonly string[];
    }
  | {
      readonly status: 'DIVERGED';
      readonly catalog: MigrationCatalog;
      readonly appliedVersions: readonly string[];
      readonly unexpectedVersions: readonly string[];
      readonly missingVersions: readonly string[];
      readonly duplicateVersions: readonly string[];
      readonly pendingVersions: readonly string[];
      readonly pendingEntries: readonly MigrationCatalogEntry[];
      readonly reason: string;
    }
  | {
      readonly status: 'EMPTY';
      readonly catalog: MigrationCatalog;
      readonly appliedVersions: readonly string[];
      readonly expectedHead: string | null;
      readonly pendingVersions: readonly string[];
      readonly pendingEntries: readonly MigrationCatalogEntry[];
    };

function catalogHeadVersion(catalog: MigrationCatalog): string | null {
  return catalog.head ? catalog.head.version : null;
}

/**
 * Pure, read-only comparison of applied DB history vs repository catalog.
 *
 * Normalizes by catalog order (deterministic) and set membership, not by
 * input array order, so a shuffled DB order does not hide divergences.
 * Duplicate applied versions are treated as DIVERGED (fail-closed).
 */
export function compareMigrationState(
  catalog: MigrationCatalog,
  appliedVersions: readonly string[],
): MigrationCompatibility {
  const catalogVersions = catalog.entries.map((e) => e.version);
  const catalogSet = new Set(catalogVersions);

  // Detect duplicate applied versions (fail-closed)
  const seen = new Set<string>();
  const duplicateVersions: string[] = [];
  for (const v of appliedVersions) {
    if (seen.has(v)) {
      if (!duplicateVersions.includes(v)) duplicateVersions.push(v);
    } else {
      seen.add(v);
    }
  }
  if (duplicateVersions.length > 0) {
    const pendingVersions = catalogVersions.filter((v) => !seen.has(v));
    const pendingEntries = catalog.entries.filter((e) => !seen.has(e.version));
    const unexpectedVersions = [...appliedVersions].filter((v) => !catalogSet.has(v));
    const missingVersions = [...pendingVersions];
    return {
      status: 'DIVERGED',
      catalog,
      appliedVersions: [...appliedVersions],
      unexpectedVersions,
      missingVersions,
      duplicateVersions,
      pendingVersions,
      pendingEntries,
      reason: 'DUPLICATE_APPLIED_VERSION',
    };
  }

  const appliedSet = new Set(appliedVersions);
  const pendingVersions = catalogVersions.filter((v) => !appliedSet.has(v));
  const pendingEntries = catalog.entries.filter((e) => !appliedSet.has(e.version));
  const unexpectedVersions = [...appliedVersions].filter((v) => !catalogSet.has(v));

  // Empty history — explicit classification (SD1 §18, §28F)
  if (appliedVersions.length === 0) {
    // If catalog is also empty, consider COMPATIBLE? But current catalog has 37 entries,
    // so empty always means pending. Return EMPTY with pending.
    // Preserve EMPTY distinct from BEHIND for operator clarity.
    return {
      status: 'EMPTY',
      catalog,
      appliedVersions: [],
      expectedHead: catalogHeadVersion(catalog),
      pendingVersions,
      pendingEntries,
    };
  }

  const allCatalogApplied = pendingVersions.length === 0;
  const noUnexpected = unexpectedVersions.length === 0;

  // Helper: appliedHead is last applied version in catalog order if possible,
  // otherwise last unexpected. For AHEAD, last applied wins.
  const appliedHead = (() => {
    if (unexpectedVersions.length > 0) {
      return appliedVersions[appliedVersions.length - 1] ?? null;
    }
    // No unexpected: last catalog entry that is applied, i.e., max index in catalog where appliedSet has it
    let last: string | null = null;
    for (const e of catalog.entries) {
      if (appliedSet.has(e.version)) last = e.version;
    }
    return last;
  })();

  const expectedHead = catalog.head ? catalog.head.version : '';

  if (allCatalogApplied && noUnexpected) {
    // Sets equal (duplicates already excluded, pending 0, unexpected 0 => sizes equal)
    return {
      status: 'COMPATIBLE',
      catalog,
      appliedVersions: [...appliedVersions],
    };
  }

  if (!allCatalogApplied && noUnexpected) {
    // Check prefix: applied must be exactly first N catalog versions.
    const expectedPrefix = new Set(catalogVersions.slice(0, appliedVersions.length));
    const isPrefix =
      appliedVersions.length === expectedPrefix.size &&
      [...appliedVersions].every((v) => expectedPrefix.has(v)) &&
      // Also ensure size matches (no missing within prefix) — already implied
      expectedPrefix.size === appliedSet.size;

    if (isPrefix) {
      return {
        status: 'BEHIND',
        catalog,
        appliedVersions: [...appliedVersions],
        appliedHead,
        expectedHead,
        pendingVersions,
        pendingEntries,
      };
    }
    return {
      status: 'DIVERGED',
      catalog,
      appliedVersions: [...appliedVersions],
      unexpectedVersions: [],
      missingVersions: pendingVersions,
      duplicateVersions: [],
      pendingVersions,
      pendingEntries,
      reason: 'NON_PREFIX_HISTORY',
    };
  }

  if (allCatalogApplied && !noUnexpected) {
    return {
      status: 'AHEAD',
      catalog,
      appliedVersions: [...appliedVersions],
      appliedHead,
      expectedHead,
      unexpectedVersions,
    };
  }

  // Both pending and unexpected => diverged
  return {
    status: 'DIVERGED',
    catalog,
    appliedVersions: [...appliedVersions],
    unexpectedVersions,
    missingVersions: pendingVersions,
    duplicateVersions: [],
    pendingVersions,
    pendingEntries,
    reason: 'DIVERGED_HISTORY',
  };
}
