import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SERVER_SHARDS = 4;
const DEFAULT_MILLISECONDS = 3000;
const observedMilliseconds = JSON.parse(readFileSync(new URL('./server-vitest-weights.json', import.meta.url), 'utf8'));

export function planServerShards(files, weights = observedMilliseconds) {
  if (new Set(files).size !== files.length) throw new Error('Server discovery returned duplicate files');
  if (files.length < SERVER_SHARDS) throw new Error('Server discovery returned too few files');

  const weight = (file) => weights[file] ?? DEFAULT_MILLISECONDS;
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
  const groups = Array.from({ length: SERVER_SHARDS }, () => ({ milliseconds: 0, files: [] }));
  for (const file of ordered) {
    const lightest = groups.reduce((best, group) => {
      if (group.milliseconds === best.milliseconds) return group.files.length < best.files.length ? group : best;
      return group.milliseconds < best.milliseconds ? group : best;
    });
    lightest.files.push(file);
    lightest.milliseconds += weight(file);
  }
  return groups.map((group) => group.files);
}

export function verifyServerShardCoverage(reports, run) {
  const latest = new Map();
  const seen = new Set();
  for (const report of reports) {
    const { sha, runId, shard, attempt } = report;
    if (sha !== run.sha || runId !== run.runId || !Number.isInteger(attempt) || attempt < 1 || attempt > run.attempt) {
      throw new Error('Server report belongs to a different commit or run');
    }
    if (shard !== 'inventory' && (!Number.isInteger(shard) || shard < 1 || shard > SERVER_SHARDS)) {
      throw new Error(`Unexpected server report ${shard}`);
    }
    const key = `${shard}/${attempt}`;
    if (seen.has(key)) throw new Error(`Duplicate server report ${key}`);
    seen.add(key);
    if (!latest.has(shard) || attempt > latest.get(shard).attempt) latest.set(shard, report);
  }

  const inventory = latest.get('inventory');
  if (!inventory) throw new Error('Missing server file inventory');
  const groups = planServerShards(inventory.files);
  const totals = { files: inventory.files.length, passed: 0, skipped: 0 };
  for (const [index, expected] of groups.entries()) {
    const shard = index + 1;
    const report = latest.get(shard);
    if (!report) throw new Error(`Missing server shard ${shard}`);
    if (Object.keys(report.files).length !== expected.length || expected.some((file) => !Object.hasOwn(report.files, file))) {
      throw new Error(`Server shard ${shard} has an unexpected file set`);
    }
    for (const file of expected) {
      const cases = report.files[file];
      if (!Array.isArray(cases) || cases.length === 0) throw new Error(`Missing test cases for ${file}`);
      for (const [, , , , state] of cases) {
        if (state === 'passed') totals.passed++;
        else if (state === 'skipped' || state === 'todo') totals.skipped++;
        else throw new Error(`Unexpected test result for ${file}: ${state}`);
      }
    }
  }
  return totals;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function workspaceFile(file) {
  const name = relative(process.cwd(), file).split(sep).join('/');
  if (!name || name === '..' || name.startsWith('../')) throw new Error(`Test file is outside the workspace: ${name}`);
  return name;
}

function collectCases(raw) {
  if (!raw.success) throw new Error('Vitest run did not succeed');
  const files = Object.create(null);
  for (const result of raw.testResults) {
    const file = workspaceFile(result.name);
    if (Object.hasOwn(files, file)) throw new Error(`Duplicate Vitest result for ${file}`);
    files[file] = result.assertionResults.map(({ ancestorTitles, title, location, status }) => [
      ancestorTitles, title, location?.line ?? null, location?.column ?? null, status === 'pending' ? 'skipped' : status,
    ]);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, input, output, index] = process.argv.slice(2);
  const run = { sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  if (!run.sha || !run.runId || !Number.isInteger(run.attempt) || run.attempt < 1) throw new Error('Missing GitHub run identity');

  if (command === 'verify') {
    const reports = readdirSync(input).map((entry) => readJson(join(input, entry, 'coverage.json')));
    const { files, passed, skipped } = verifyServerShardCoverage(reports, run);
    console.log(`Verified ${SERVER_SHARDS} server shards: ${files} files, ${passed} passed, ${skipped} skipped/todo.`);
  } else if (command === 'inventory' || command === 'shard') {
    const raw = readJson(input);
    const shard = command === 'inventory' ? 'inventory' : Number(index);
    const files = command === 'inventory' ? raw.map(({ file }) => workspaceFile(file)).sort() : collectCases(raw);
    writeFileSync(output, `${JSON.stringify({ ...run, shard, files })}\n`);
  } else {
    throw new Error(`Unknown server shard evidence command: ${command}`);
  }
}
