#!/usr/bin/env node

/**
 * audit-high-policy.mjs
 *
 * Runs npm audit --json and applies a generic high/critical gate.
 * Any HIGH or CRITICAL finding fails. Any malformed, inconsistent, or
 * unusable audit result fails closed.
 *
 * Usage:
 *   node scripts/audit-high-policy.mjs
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from './audit-high-policy-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function run() {
  // Run npm audit --json
  let auditJson;
  try {
    auditJson = execSync('npm audit --json', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero when finding vulnerabilities
    // Capture stdout (JSON output) from the error object
    auditJson = /** @type {Error & {stdout?: string}} */ (err).stdout || '';
    if (!auditJson) {
      console.error('FAIL: npm audit komutu basarisiz — JSON ciktisi alinamadi');
      if (err.message) console.error(err.message);
      process.exit(1);
    }
  }

  const result = evaluateAudit(auditJson);

  console.log(result.message);

  if (!result.pass) {
    process.exit(result.exitCode);
  }

  process.exit(0);
}

run();
