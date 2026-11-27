import assert from 'node:assert/strict';
import test from 'node:test';
import { planServerShards, verifyServerShardCoverage } from '../ci/server-vitest-shards.mjs';

test('balances heavy tests and includes newly discovered files exactly once', () => {
  const files = ['heavy-a', 'heavy-b', 'medium', 'small', 'new-a', 'new-b'].map(name => `tests/${name}.test.ts`);
  const weights = Object.fromEntries(files.slice(0, 4).map((file, index) => [file, [9000, 8500, 7000, 1000][index]]));
  const groups = planServerShards(files, weights);
  assert.deepEqual(groups, [files.slice(0, 1), files.slice(1, 2), files.slice(2, 3), [files[4], files[5], files[3]]]);
  assert.deepEqual(planServerShards(files.toReversed(), weights), groups);
  assert.throws(() => planServerShards([...files, files[0]], weights), /duplicate/);
});

test('accepts mixed-attempt reports for the same commit and rejects incomplete coverage', () => {
  const files = ['a', 'b', 'c', 'd'].map(name => `tests/${name}.test.ts`);
  const run = { sha: 'a'.repeat(40), runId: '90210', attempt: 2 };
  const inventory = { ...run, attempt: 1, shard: 'inventory', files };
  const shards = planServerShards(files).map(([file], index) => ({
    ...run, attempt: 1, shard: index + 1,
    files: { [file]: [[['suite'], file, 4, 1, 'passed']] },
  }));
  const latest = { ...shards[1], attempt: 2 };
  assert.deepEqual(verifyServerShardCoverage([inventory, ...shards, latest], run), { files: 4, passed: 4, skipped: 0 });
  assert.throws(() => verifyServerShardCoverage([inventory, ...shards.slice(0, -1)], run), /Missing.*shard 4/);
  assert.throws(() => verifyServerShardCoverage([inventory, ...shards, { ...latest, files: {} }], run), /shard 2.*file set/);
  assert.throws(() => verifyServerShardCoverage([inventory, ...shards, { ...latest, sha: 'b'.repeat(40) }], run), /different commit or run/);
});
