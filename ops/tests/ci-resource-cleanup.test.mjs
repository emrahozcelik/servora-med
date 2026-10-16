// Wiring/policy integrity. Stateful behavior is covered by the actual
// entrypoint tests in ci-resource-lifecycle.test.mjs (no real Docker required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

test('local CI wires its lifecycle tests and every one of the 27 mandatory producers', () => {
  const run = read('ops/local-ci/run.sh');
  assert.match(run, /ci_create_run_resources/);
  assert.match(run, /ci_cleanup_run_resources/);
  const chain = read('ops/local-ci/chains/server-chain-user.sh');
  assert.match(chain, /ci-resource-lifecycle\.test\.mjs/);
  assert.match(chain, /lib\/resource-cleanup\.sh/);
  assert.match(chain, /local-ci\/docker-gated\.sh/);
  const required = read('ops/local-ci/required-checks.txt').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(required.length, 27);
  assert.equal(new Set(required).size, 27);
  const producers = ['ops/local-ci/chains/server-chain-user.sh', 'ops/local-ci/chains/web-chain.sh', 'ops/local-ci/docker-gated.sh']
    .flatMap((p) => [...read(p).matchAll(/^\s*(?:check|run_one)\s+([a-z0-9-]+)\s+--\s+\S/gm)].map((m) => m[1]));
  assert.match(run, /node \/repo\/ops\/benchmarks\/auth-kdf-benchmark\.mjs --mode=smoke/);
  assert.match(run, /chains\/linux-amd64-compat\.sh/);
  producers.push('benchmark-smoke', 'linux-compat');
  assert.deepEqual([...new Set(producers)].sort(), required.sort());
});

test('resource cleanup has no global prune or volume-label anonymity inference', () => {
  const source = read('ops/local-ci/lib/resource-cleanup.sh').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(source, /(?:volume|system) prune|colima delete|limactl delete/);
  assert.doesNotMatch(source, /volume (?:inspect|rm)|ci_is_removable_volume|ci_list_container_volumes/);
});
