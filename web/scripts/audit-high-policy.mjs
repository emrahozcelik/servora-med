#!/usr/bin/env node

/**
 * Fail-closed security audit for web/server: any HIGH or CRITICAL advisory,
 * malformed report or unusable npm output fails. There are no exceptions.
 * Usage from web: node scripts/audit-high-policy.mjs
 * Usage from server: node ../web/scripts/audit-high-policy.mjs --workspace server
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from './audit-high-policy-lib.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--workspace' && args[1] === 'server')) {
  console.error('FAIL: unsupported audit workspace arguments — fail-closed');
  process.exit(1);
}
const workspace = args.length === 0 ? 'web' : 'server';
const repoRoot = resolve(scriptDir, '..', '..', workspace);

function audit(command) {
  try {
    return execSync(command, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    // npm audit itself exits nonzero on vulnerabilities; require a valid JSON
    // report rather than accepting command failure or a truncated response.
    const value = /** @type {Error & {stdout?: string}} */ (error).stdout;
    if (typeof value === 'string' && value.trim()) return value;
    throw new Error('audit command failed without usable JSON: ' + command);
  }
}

try {
  const result = evaluateAudit(audit('npm audit --json'));
  console.log(workspace + ': ' + result.message);
  if (!result.pass) process.exit(result.exitCode);
} catch (error) {
  console.error('FAIL: audit execution failed — fail-closed');
  if (error instanceof Error) console.error(error.message);
  process.exit(1);
}
