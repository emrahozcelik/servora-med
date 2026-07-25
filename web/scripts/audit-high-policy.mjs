#!/usr/bin/env node

/**
 * audit-high-policy.mjs
 *
 * Runs npm audit --json and applies a scoped waiver for GHSA-qwww-vcr4-c8h2
 * (React Router RSC Mode CSRF Bypass). Only this exact advisory is allowed;
 * all other high/critical findings will cause the script to exit with code 1.
 *
 * Usage:
 *   node scripts/audit-high-policy.mjs
 *
 * Env:
 *   AUDIT_SRC_ROOT  – override src root path (default: <repo_root>/src)
 *   AUDIT_SKIP_RSC  – set to "1" to skip RSC static guard (debug only)
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit, scanRscIdentifiers } from './audit-high-policy-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const srcRoot =
  process.env.AUDIT_SRC_ROOT || resolve(repoRoot, 'src');
const skipRsc = process.env.AUDIT_SKIP_RSC === '1';

function run() {
  // Verify src exists for RSC scan
  if (!skipRsc && !existsSync(srcRoot)) {
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
      console.error('FAIL: npm audit komutu başarısız — JSON çıktısı alınamadı');
      if (err.message) console.error(err.message);
      process.exit(1);
    }
  }

  // Evaluate
  const result = evaluateAudit(auditJson, {
    scanRscInSrc: !skipRsc,
    srcRoot,
  });

  console.log(result.message);

  if (!result.pass) {
    process.exit(result.exitCode);
  }

  process.exit(0);
}

run();
