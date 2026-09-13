// @ts-check

/**
 * audit-high-policy-lib.mjs
 *
 * Generic npm audit high/critical gate. Fail-closed.
 * There are no advisory allowlists and no exceptions: any HIGH or CRITICAL
 * entry fails, and any malformed report fails.
 */

/**
 * @typedef {Object} AuditResult
 * @property {boolean} pass
 * @property {number} exitCode
 * @property {string} message
 */

const SUPPORTED_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const METADATA_COUNTER_KEYS = ['info', 'low', 'moderate', 'high', 'critical', 'total'];

/**
 * @param {string} message
 * @returns {AuditResult}
 */
function fail(message) {
  return { pass: false, exitCode: 1, message };
}

/**
 * Validate a vulnerability entry shape.
 * Returns null if valid, or an error message string.
 *
 * @param {unknown} vuln
 * @returns {string|null}
 */
function validateVulnShape(vuln) {
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
 * Parse npm audit JSON output and determine the result.
 *
 * Order (fail-closed, no early clean PASS):
 * parse JSON → envelope → version → vulnerabilities map → metadata
 * structure/counters → EVERY entry shape → key/name identity →
 * metadata high/critical consistency → high/critical decision.
 *
 * @param {string} auditJson - Raw JSON from `npm audit --json`
 * @returns {AuditResult}
 */
export function evaluateAudit(auditJson) {
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(auditJson);
  } catch {
    return fail('FAIL: audit JSON parse hatasi — fail-closed');
  }

  if (!report || typeof report !== 'object') {
    return fail('FAIL: audit raporu gecersiz yapi — fail-closed');
  }

  if (
    typeof report.auditReportVersion !== 'number' ||
    !Number.isInteger(report.auditReportVersion) ||
    report.auditReportVersion !== 2
  ) {
    return fail(`FAIL: unsupported auditReportVersion: ${report.auditReportVersion}`);
  }

  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    return fail('FAIL: vulnerabilities missing or not plain object — fail-closed');
  }

  if (!report.metadata || typeof report.metadata !== 'object') {
    return fail('FAIL: metadata missing — fail-closed');
  }

  const counters = report.metadata.vulnerabilities;
  if (!counters || typeof counters !== 'object') {
    return fail('FAIL: metadata.vulnerabilities missing — fail-closed');
  }

  for (const key of METADATA_COUNTER_KEYS) {
    const val = counters[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || !Number.isInteger(val)) {
      return fail(`FAIL: metadata.${key} invalid: ${val} — fail-closed`);
    }
  }

  // Validate EVERY entry before any clean PASS is possible.
  let highCount = 0;
  let criticalCount = 0;
  const highNames = [];
  const criticalNames = [];

  for (const [key, vuln] of Object.entries(report.vulnerabilities)) {
    const shapeErr = validateVulnShape(vuln);
    if (shapeErr) {
      return fail(`FAIL: ${key}: ${shapeErr}`);
    }
    if (vuln.name !== key) {
      return fail(`FAIL: vulnerability key/name mismatch: key=${key}, name=${vuln.name}`);
    }
    if (vuln.severity === 'high') {
      highCount++;
      highNames.push(key);
    } else if (vuln.severity === 'critical') {
      criticalCount++;
      criticalNames.push(key);
    }
  }

  if (counters.high !== highCount) {
    return fail(`FAIL: metadata high=${counters.high} but actual high=${highCount}`);
  }
  if (counters.critical !== criticalCount) {
    return fail(`FAIL: metadata critical=${counters.critical} but actual critical=${criticalCount}`);
  }

  if (highCount > 0) {
    return fail(`FAIL: high severity advisory bulundu: ${highNames.join(', ')}`);
  }
  if (criticalCount > 0) {
    return fail(`FAIL: critical severity advisory bulundu: ${criticalNames.join(', ')}`);
  }

  return { pass: true, exitCode: 0, message: 'PASS: high/critical vulnerability yok' };
}
