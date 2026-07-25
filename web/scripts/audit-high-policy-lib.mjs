// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Vulnerability
 * @property {string} name
 * @property {'info'|'low'|'moderate'|'high'|'critical'} severity
 * @property {Array<{source: number, name: string, title: string, url: string, severity: string, range: string}>} via
 * @property {string[]} effects
 * @property {string} range
 */

/**
 * @typedef {Object} AuditMetadata
 * @property {{info: number, low: number, moderate: number, high: number, critical: number, total: number}} vulnerabilities
 */

/**
 * @typedef {Object} AuditReport
 * @property {Record<string, Vulnerability>} vulnerabilities
 * @property {AuditMetadata} metadata
 */

const ALLOWED_GHSA = 'GHSA-qwww-vcr4-c8h2';
const ALLOWED_PACKAGES = new Set(['react-router', 'react-router-dom']);

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
 * Check whether a vulnerability chain is allowed.
 * Allowed if and only if every via entry is the allowed GHSA
 * and all affected packages are in ALLOWED_PACKAGES.
 *
 * @param {Vulnerability} vuln
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function isVulnerabilityAllowed(vuln) {
  // Every via entry must map to the allowed GHSA
  for (const viaEntry of vuln.via) {
    if (typeof viaEntry === 'string') {
      // String via entries are either:
      // 1. Transitive dependency references (e.g. "react-router") — ok if allowed package
      // 2. Legacy GHSA-id references — block those
      if (viaEntry.startsWith('GHSA-')) {
        return { allowed: false, reason: `Legacy via string: ${viaEntry}` };
      }
      // Transitive dep reference — verify the referenced package is in ALLOWED_PACKAGES
      if (!ALLOWED_PACKAGES.has(viaEntry)) {
        return { allowed: false, reason: `Transitive via non-allowed package: ${viaEntry}` };
      }
      continue; // transitive ref to allowed package is acceptable
    }
    if (viaEntry.url !== `https://github.com/advisories/${ALLOWED_GHSA}`) {
      return {
        allowed: false,
        reason: `Unapproved advisory: ${viaEntry.url || viaEntry.title}`,
      };
    }
  }

  // Affected packages must all be in the allowed set
  const allPackages = [vuln.name, ...vuln.effects];
  for (const pkg of allPackages) {
    if (!ALLOWED_PACKAGES.has(pkg)) {
      return {
        allowed: false,
        reason: `Package not in allowed set: ${pkg}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Parse npm audit JSON output and determine the result.
 *
 * @param {string} auditJson - Raw JSON from `npm audit --json`
 * @param {{ scanRscInSrc?: boolean, srcRoot?: string }} [options]
 * @returns {{ pass: boolean, exitCode: number, message: string, waiverApplied: boolean }}
 */
export function evaluateAudit(auditJson, options = {}) {
  let report;
  try {
    report = /** @type {AuditReport} */ (JSON.parse(auditJson));
  } catch {
    return {
      pass: false,
      exitCode: 1,
      message: 'FAIL: audit JSON parse hatası — fail-closed',
      waiverApplied: false,
    };
  }

  if (!report || !report.metadata || !report.vulnerabilities) {
    return {
      pass: false,
      exitCode: 1,
      message: 'FAIL: audit raporu geçersiz yapı — fail-closed',
      waiverApplied: false,
    };
  }

  const { high, critical } = report.metadata.vulnerabilities;

  // No high/critical findings → clean pass
  if (high === 0 && critical === 0) {
    return {
      pass: true,
      exitCode: 0,
      message: 'PASS: high/critical vulnerability yok',
      waiverApplied: false,
    };
  }

  // Check if the only findings are the allowed GHSA
  const vulnerabilityEntries = Object.entries(report.vulnerabilities);

  for (const [, vuln] of vulnerabilityEntries) {
    if (vuln.severity === 'high') {
      const { allowed, reason } = isVulnerabilityAllowed(vuln);
      if (!allowed) {
        return {
          pass: false,
          exitCode: 1,
          message: `FAIL: ${reason}`,
          waiverApplied: false,
        };
      }
    }
    if (vuln.severity === 'critical') {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: critical advisory izin verilmez — ${vuln.name}: ${vuln.via.map(v => typeof v === 'string' ? v : v.url).join(', ')}`,
        waiverApplied: false,
      };
    }
  }

  // RSC static guard
  if (options.scanRscInSrc !== false && options.srcRoot) {
    const violations = scanRscIdentifiers(options.srcRoot, fs, path);
    if (violations.length > 0) {
      return {
        pass: false,
        exitCode: 1,
        message: `FAIL: RSC API kullanımı tespit edildi — waiver uygulanamaz:\n${violations.join('\n')}`,
        waiverApplied: false,
      };
    }
  }

  // All findings are the allowed GHSA → waiver applied
  // Check if the allowed advisory has disappeared (clean audit)
  const remainingHigh = vulnerabilityEntries.filter(
    ([, v]) => v.severity === 'high' || v.severity === 'critical'
  );
  const allowedVulns = remainingHigh.filter(([, v]) => {
    const { allowed } = isVulnerabilityAllowed(v);
    return allowed;
  });

  if (allowedVulns.length === 0) {
    return {
      pass: true,
      exitCode: 0,
      message: 'PASS: waiver artık gereksiz — tüm advisory\'ler temizlendi',
      waiverApplied: false,
    };
  }

  return {
    pass: true,
    exitCode: 0,
    message: `PASS_WITH_WAIVER: yalnız ${ALLOWED_GHSA} (RSC-only) izin verildi`,
    waiverApplied: true,
  };
}

/**
 * Scan src directory for RSC identifiers.
 * Exported for testing.
 *
 * @param {string} srcRoot
 * @param {typeof import('node:fs')} fs
 * @param {typeof import('node:path')} path
 * @returns {string[]} List of violation descriptions
 */
export function scanRscIdentifiers(srcRoot, fs, path) {
  const violations = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const id of RSC_IDENTIFIERS) {
            const idx = content.indexOf(id);
            if (idx !== -1) {
              const line = content.substring(0, idx).split('\n').length;
              violations.push(`  ${fullPath}:${line}: ${id}`);
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(srcRoot);
  return violations;
}


