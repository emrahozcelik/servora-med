import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import base from './vitest.config.js';

const manifest = JSON.parse(readFileSync(new URL('../ops/ci-perf-001/manifest.json', import.meta.url), 'utf8'));

class DurationBalancedSequencer extends BaseSequencer {
  override async shard(specifications: TestSpecification[]) {
    const { root, shard } = this.ctx.config;
    if (!shard) throw new Error('CI-PERF-001 requires an explicit shard');
    const files = new Map(specifications.map(spec => [relative(root, spec.moduleId), spec]));
    const plan = manifest.groups[shard.count] as Record<string, string[]>;
    const planned = Object.values(plan).flat();
    if (files.size !== specifications.length || planned.length !== files.size ||
        new Set(planned).size !== planned.length || planned.some(file => !files.has(file))) {
      throw new Error('CI-PERF-001 manifest does not match discovered server files');
    }
    return shard.count === 1 ? specifications : plan[shard.index].map(file => files.get(file)!);
  }
}

export default defineConfig({
  ...base,
  test: { ...base.test, sequence: { sequencer: DurationBalancedSequencer } },
});
