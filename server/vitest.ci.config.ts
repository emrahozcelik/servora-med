import { relative } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { planServerShards, SERVER_SHARDS } from '../ops/ci/server-vitest-shards.mjs';
import base from './vitest.config.js';

class ServerCiSequencer extends BaseSequencer {
  override async shard(specifications: TestSpecification[]) {
    const { root, shard } = this.ctx.config;
    if (shard?.count !== SERVER_SHARDS) throw new Error(`Server CI requires ${SERVER_SHARDS} shards`);
    const files = new Map(specifications.map(spec => [relative(root, spec.moduleId), spec]));
    if (files.size !== specifications.length) throw new Error('Server discovery returned duplicate specifications');
    return planServerShards([...files.keys()])[shard.index - 1].map((file: string) => files.get(file)!);
  }
}

export default defineConfig({
  ...base,
  test: { ...base.test, sequence: { sequencer: ServerCiSequencer } },
});
