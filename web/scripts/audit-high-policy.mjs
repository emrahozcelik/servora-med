#!/usr/bin/env node

/**
 * audit-high-policy.mjs
 *
 * Runs npm audit --json and applies a scoped waiver for GHSA-qwww-vcr4-c8h2
 * (React Router RSC Mode CSRF Bypass). The waiver is only applied when:
 * - Every high/critical chain terminates at the exact allowed GHSA
 * - The production source (web/src) has no RSC API usage
 * - File system scan completes without errors
 *
 * Any other high/critical finding, malformed payload, metadata mismatch,
 * cycle in dependency chain, or scan error causes exit code 1.
 *
 * Usage:
 *   node scripts/audit-high-policy.mjs
 *
 * Env:
 *   AUDIT_SRC_ROOT  – override src root path (default: <repo_root>/src)
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from './audit-high-policy-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const srcRoot =
  process.env.AUDIT_SRC_ROOT || resolve(repoRoot, 'src');

function run() {
  // Verify src exists for RSC scan
  if (!existsSync(srcRoot)) {
    console.error(`FAIL: src directory not found: ${srcRoot}`);
    process.exit(1);
  }

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

  // Evaluate with RSC static guard (always on, no bypass)
  const result = evaluateAudit(auditJson, {
    srcRoot,
  });

  console.log(result.message);

  if (!result.pass) {
    process.exit(result.exitCode);
  }

  process.exit(0);
}

run();
