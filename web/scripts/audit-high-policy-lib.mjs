// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} ViaObject
 * @property {number} source
 * @property {string} name
 * @property {string} title
 * @property {string} url
 * @property {string} severity
 * @property {string[]} cwe
 * @property {{score: number, vectorString: string|null}} cvss
 * @property {string} range
 */

/**
 * @typedef {Object} Vulnerability
 * @property {string} name
 * @property {'info'|'low'|'moderate'|'high'|'critical'} severity
 * @property {Array<ViaObject|string>} via
 * @property {string[]} effects
 * @property {string} range
 */

/**
 * @typedef {Object} AuditMetadataVulns
 * @property {number} info
 * @property {number} low
 * @property {number} moderate
 * @property {number} high
 * @property {number} critical
 * @property {number} total
 */

/**
 * @typedef {Object} AuditMetadata
 * @property {AuditMetadataVulns} vulnerabilities
 */

/**
 * @typedef {Object} AuditReport
 * @property {number} auditReportVersion
 * @property {Record<string, Vulnerability>} vulnerabilities
 * @property {AuditMetadata} metadata
 */

/**
 * @typedef {Object} ScanResult
 * @property {string[]} violations
 * @property {string[]} scanErrors
 */

const ALLOWED_GHSA = 'GHSA-qwww-vcr4-c8h2';
const ALLOWED_GHSA_URL = `https://github.com/advisories/${ALLOWED_GHSA}`;
const ALLOWED_PACKAGES = new Set(['react-router', 'react-router-dom']);
const SUPPORTED_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

/**
 * RSC API identifiers that must not appear in production source.
 * If any are found, the audit waiver must be denied.
 */
const RSC_IDENTIFIERS = [
  'RSCHydratedRouter',
  'RSCStaticRouter',
  'createCallServer',
  'getRSCStream',
  'matchRSCServerRequest',
  'routeRSCServerRequest',
];

/**
 * RSC conditions/import patterns that must not appear in production source.
 */
const RSC_CONDITIONS = ['react-server'];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Validate a vulnerability entry shape.
 * Returns null if valid, or an error message string.
 *
 * @param {unknown} vuln
 * @returns {string|null}
 */
export function validateVulnShape(vuln) {
  if (!vuln || typeof vuln !== 'object') return 'vuln not an object';
  const v = /** @type {Record<string, unknown>} */ (vuln);
  if (typeof v.name !== 'string' || !v.name) return 'name missing or not string';
  if (typeof v.severity !== 'string' || !SUPPORTED_SEVERITIES.has(v.severity)) {
    return 'severity not supported value';
  }
  if (!Array.isArray(v.via)) return 'via not array';
  if (!Array.isArray(v.effects)) return 'effects not array';
  if (typeof v.range !== 'string') return 'range not string';
  return null;
}

/**
 * Check whether a single advisory object matches the allowed GHSA.
 * This is a narrow helper — only for advisory objects, not string references.
 *
 * @param {unknown} entry
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function isAllowedAdvisoryObject(entry) {
  if (!entry || typeof entry !== 'object') {
    return { allowed: false, reason: 'via entry not an object' };
  }
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (typeof e.url !== 'string') {
    return { allowed: false, reason: 'via object missing url' };
  }
  if (e.url !== ALLOWED_GHSA_URL) {
    return { allowed: false, reason: `unapproved advisory: ${e.url}` };
  }
  if (typeof e.name !== 'string' || !ALLOWED_PACKAGES.has(e.name)) {
    return { allowed: false, reason: `advisory package not allowed: ${e.name}` };
  }
  return { allowed: true };
}

// ─── Recursive chain resolver ──────────────────────────────────────────────

/**
 * Recursively resolve a vulnerability chain through string via references.
 *
 * Every high vulnerability's via chain must terminate at the exact allowed GHSA.
 * - Advisory objects are checked directly against ALLOWED_GHSA_URL.
 * - String references are followed recursively through the vulnerabilities map.
 * - Cycles (self-reference and multi-node) are detected and fail.
 * - Missing referenced entries fail.
 * - Legacy GHSA-id strings fail.
 *
 * @param {object} params
 * @param {string} params.packageName - Current package to resolve
 * @param {Record<string, Vulnerability>} params.vulnerabilities - Full map
 * @param {Set<string>} params.visiting - Cycle detection set
 * @param {Map<string, {allowed: boolean, reason?: string}>} params.resolved - Memo
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluateVulnerabilityChain({
  packageName,
  vulnerabilities,
  visiting,
  resolved,
}) {
  // Check memo
  const memo = resolved.get(packageName);
  if (memo) return memo;

  // Cycle detection
  if (visiting.has(packageName)) {
    const result = { allowed: false, reason: `cycle detected: ${packageName}` };
    resolved.set(packageName, result);
    return result;
  }

  // Look up vulnerability entry
  const vuln = vulnerabilities[packageName];
  if (!vuln) {
    const result = { allowed: false, reason: `referenced vulnerability missing: ${packageName}` };
    resolved.set(packageName, result);
    return result;
  }

  // Validate shape
  const shapeErr = validateVulnShape(vuln);
  if (shapeErr) {
    const result = { allowed: false, reason: `${packageName}: ${shapeErr}` };
    resolved.set(packageName, result);
    return result;
  }

  // Non-high/critical severities don't need waiver
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') {
    const result = { allowed: true };
    resolved.set(packageName, result);
    return result;
  }

  // Critical severity is never allowed
  if (vuln.severity === 'critical') {
    const result = { allowed: false, reason: `${packageName}: critical severity not allowed` };
    resolved.set(packageName, result);
    return result;
  }

  // High severity — must have via entries
  if (!Array.isArray(vuln.via) || vuln.via.length === 0) {
    const result = { allowed: false, reason: `${packageName}: via empty or missing` };
    resolved.set(packageName, result);
    return result;
  }

  // Mark visiting
  visiting.add(packageName);

  let foundTerminal = false;

  for (const viaEntry of vuln.via) {
    // Advisory object — check directly
    if (typeof viaEntry === 'object' && viaEntry !== null) {
      const advResult = isAllowedAdvisoryObject(viaEntry);
      if (!advResult.allowed) {
        visiting.delete(packageName);
        const result = { allowed: false, reason: `${packageName}: ${advResult.reason}` };
        resolved.set(packageName, result);
        return result;
      }
      // Found terminal advisory
      foundTerminal = true;
      continue;
    }

    // String reference
    if (typeof viaEntry === 'string') {
      // Legacy GHSA-id string — not allowed
      if (viaEntry.startsWith('GHSA-')) {
        visiting.delete(packageName);
        const result = { allowed: false, reason: `${packageName}: legacy GHSA string via: ${viaEntry}` };
        resolved.set(packageName, result);
        return result;
      }

      // Recursively resolve the referenced package
      const chainResult = evaluateVulnerabilityChain({
        packageName: viaEntry,
        vulnerabilities,
        visiting,
        resolved,
      });

      if (!chainResult.allowed) {
        visiting.delete(packageName);
        return chainResult;
      }

      // Track terminal advisory discovery through string references
      if (chainResult.terminalGhsa) {
        foundTerminal = true;
      }
      continue;
    }

    // Unknown via entry type
    visiting.delete(packageName);
    const result = { allowed: false, reason: `${packageName}: invalid via entry type` };
    resolved.set(packageName, result);
    return result;
  }

  visiting.delete(packageName);

  // High-severity package must have found a terminal advisory
  if (vuln.severity === 'high' && !foundTerminal) {
    const result = { allowed: false, reason: `${packageName}: no terminal advisory found` };
    resolved.set(packageName, result);
    return result;
  }

  // All via entries resolved successfully
  const terminalPart = foundTerminal ? { terminalGhsa: ALLOWED_GHSA } : {};
  const result = { allowed: true, ...terminalPart };
  resolved.set(packageName, result);
  return result;
}

// ─── Metadata consistency ──────────────────────────────────────────────────

/**
 * Check metadata counts against actual vulnerability entries.
 *
 * @param {AuditReport} report
 * @returns {string|null} Error message or null if consistent
 */
export function checkMetadataConsistency(report) {
  if (!report.metadata || typeof report.metadata !== 'object') {
    return 'metadata missing';
  }
  const mv = report.metadata.vulnerabilities;
  if (!mv || typeof mv !== 'object') {
    return 'metadata.vulnerabilities missing';
  }

  // Validate metadata values are finite non-negative integers
  for (const key of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    const val = /** @type {Record<string, unknown>} */ (mv)[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || !Number.isInteger(val)) {
      return `metadata.${key} invalid: ${val}`;
    }
  }

  // Count actual entries by severity
  const actualCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  if (report.vulnerabilities && typeof report.vulnerabilities === 'object') {
    for (const vuln of Object.values(report.vulnerabilities)) {
      const v = /** @type {Vulnerability} */ (vuln);
      if (v && typeof v.severity === 'string' && SUPPORTED_SEVERITIES.has(v.severity)) {
        actualCounts[v.severity]++;
      }
    }
  }

  // Check high mismatch
  if (mv.high === 0 && actualCounts.high > 0) {
    return 'metadata high=0 but actual high entries exist';
  }
  if (mv.high > 0 && actualCounts.high === 0) {
    return `metadata high=${mv.high} but no actual high entries`;
  }

  // Check critical mismatch
  if (mv.critical === 0 && actualCounts.critical > 0) {
    return 'metadata critical=0 but actual critical entries exist';
  }
  if (mv.critical > 0 && actualCounts.critical === 0) {
    return `metadata critical=${mv.critical} but no actual critical entries`;
  }

  return null;
}

// ─── RSC static guard ──────────────────────────────────────────────────────

/**
 * Scan src directory for RSC identifiers and conditions.
 *
 * Returns structured result with violations and scan errors.
 * If scanErrors.length > 0, the waiver must not be applied.
 *
 * @param {string} srcRoot
 * @param {typeof import('node:fs')} fsModule
 * @param {typeof import('node:path')} pathModule
 * @returns {ScanResult}
 */
export function runRSCStaticGuard(srcRoot, fsModule, pathModule) {
  /** @type {string[]} */
  const violations = [];
  /** @type {string[]} */
  const scanErrors = [];

  // src root must exist
  let rootStat;
  try {
    rootStat = fsModule.statSync(srcRoot);
  } catch (e) {
    scanErrors.push(`src root not accessible: ${srcRoot} — ${/** @type {Error} */ (e).message}`);
    return { violations, scanErrors };
  }

  if (!rootStat.isDirectory()) {
    scanErrors.push(`src root not a directory: ${srcRoot}`);
    return { violations, scanErrors };
  }

  /** @type {Array<{dir: string, relPath: string}>} */
  const dirStack = [{ dir: srcRoot, relPath: '' }];

  while (dirStack.length > 0) {
    const { dir, relPath } = dirStack.pop();
    let entries;
    try {
      entries = fsModule.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      scanErrors.push(`cannot read directory: ${dir} — ${/** @type {Error} */ (e).message}`);
      continue;
    }

    for (const entry of entries) {
      const fullPath = pathModule.join(dir, entry.name);
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        dirStack.push({ dir: fullPath, relPath: entryRelPath });
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        let content;
        try {
          content = fsModule.readFileSync(fullPath, 'utf-8');
        } catch (e) {
          scanErrors.push(`cannot read file: ${fullPath} — ${/** @type {Error} */ (e).message}`);
          continue;
        }

        // Check for RSC identifiers
        for (const id of RSC_IDENTIFIERS) {
          const idx = content.indexOf(id);
          if (idx !== -1) {
            const line = content.substring(0, idx).split('\n').length;
            violations.push(`${fullPath}:${line}: ${id}`);
          }
        }

        // Check for RSC conditions/import patterns
        for (const cond of RSC_CONDITIONS) {
          // Match exact condition usage: import "...react-server", "react-server" condition
          const regex = new RegExp(`['"\`]${cond}['"\`]`);
          const match = regex.exec(content);
          if (match) {
            const idx = match.index;
            const line = content.substring(0, idx).split('\n').length;
            violations.push(`${fullPath}:${line}: condition "${cond}"`);
          }
        }
      }
    }
  }

  return { violations, scanErrors };
}

// ─── evaluateAudit ─────────────────────────────────────────────────────────

/**
 * Parse npm audit JSON output and determine the result.
 *
 * @param {string} auditJson - Raw JSON from `npm audit --json`
 * @param {{ srcRoot?: string }} [options]
 * @returns {{ pass: boolean, exitCode: number, message: string, waiverApplied: boolean }}
 */
export function evaluateAudit(auditJson, options = {}) {
  /** @type {AuditReport} */
  let report;
  try {
    report = JSON.parse(auditJson);
  } catch {
    return {
      pass: false,
      exitCode: 1,
      message: 'FAIL: audit JSON parse hatasi — fail-closed',
      waiverApplied: false,
    };
  }

  // Validate report structure
  if (!report || typeof report !== 'object') {
    return {
      pass: false,
      exitCode: 1,
      message: 'FAIL: audit raporu gecersiz yapi — fail-closed',
      waiverApplied: false,
    };
  }

  // vulnerabilities must exist and be a plain object
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    return {
      pass: false,
      exitCode: 1,
      message: 'FAIL: vulnerabilities missing or not plain object — fail-closed',
      waiverApplied: false,
    };
  }

  // Check metadata consistency
  if (report.metadata) {
    const metaErr = checkMetadataConsistency(report);
    if (metaErr) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: metadata tutarsizligi — ${metaErr}`,
        waiverApplied: false,
      };
    }
  }

  const { high, critical } = report.metadata
    ? report.metadata.vulnerabilities
    : { high: 0, critical: 0 };

  // Collect all high/critical entries
  const highEntries = [];
  const criticalEntries = [];

  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    const v = /** @type {Vulnerability} */ (vuln);
    if (v.severity === 'high') highEntries.push([name, v]);
    else if (v.severity === 'critical') criticalEntries.push([name, v]);
  }

  // Early clean pass: only when metadata AND entries agree on zero
  if (highEntries.length === 0 && criticalEntries.length === 0 && high === 0 && critical === 0) {
    return {
      pass: true,
      exitCode: 0,
      message: 'PASS: high/critical vulnerability yok',
      waiverApplied: false,
    };
  }

  // Decision based on actual entries, not metadata alone
  // Evaluate each high entry through the recursive chain resolver
  const vulnerabilities = report.vulnerabilities;
  const resolvedGlobal = new Map();
  const visitingGlobal = new Set();

  for (const [name, vuln] of highEntries) {
    // First check shape
    const shapeErr = validateVulnShape(vuln);
    if (shapeErr) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: ${name}: ${shapeErr}`,
        waiverApplied: false,
      };
    }

    // Then resolve via chain
    const chainResult = evaluateVulnerabilityChain({
      packageName: name,
      vulnerabilities,
      visiting: visitingGlobal,
      resolved: resolvedGlobal,
    });

    if (!chainResult.allowed) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: ${chainResult.reason}`,
        waiverApplied: false,
      };
    }

    // Package must be in allowed set
    if (!ALLOWED_PACKAGES.has(vuln.name)) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: ${vuln.name}: package not in allowed set`,
        waiverApplied: false,
      };
    }

    // All effects must be in allowed set
    for (const effectPkg of vuln.effects) {
      if (!ALLOWED_PACKAGES.has(effectPkg)) {
        return {
          pass: false,
          exitCode: 1,
          message: `FAIL: ${vuln.name}: effect not in allowed set: ${effectPkg}`,
          waiverApplied: false,
        };
      }
    }
  }

  // Any critical entry → FAIL
  for (const [name] of criticalEntries) {
    return {
      pass: false,
      exitCode: 1,
      message: `FAIL: critical advisory not allowed — ${name}`,
      waiverApplied: false,
    };
  }

  // All high entries resolved successfully — now run RSC guard
  if (options.srcRoot) {
    const scanResult = runRSCStaticGuard(options.srcRoot, fs, path);
    if (scanResult.scanErrors.length > 0) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: RSC tarama hatasi — waiver uygulanamaz:\n${scanResult.scanErrors.join('\n')}`,
        waiverApplied: false,
      };
    }
    if (scanResult.violations.length > 0) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: RSC API kullanimi tespit edildi — waiver uygulanamaz:\n${scanResult.violations.join('\n')}`,
        waiverApplied: false,
      };
    }
  }

  // All checks passed — waiver or pass
  if (highEntries.length === 0 && criticalEntries.length === 0) {
    return {
      pass: true,
      exitCode: 0,
      message: 'PASS: high/critical vulnerability yok',
      waiverApplied: false,
    };
  }

  return {
    pass: true,
    exitCode: 0,
    message: `PASS_WITH_WAIVER: yalniz ${ALLOWED_GHSA} (RSC-only) izin verildi`,
    waiverApplied: true,
  };
}
