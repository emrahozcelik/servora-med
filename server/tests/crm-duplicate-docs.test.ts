import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const folder = path.join(root, 'docs/features/crm-duplicate-review');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it('F02: owning portable documents preserve approved bytes except recorded machine-local links', () => {
  const manifest = JSON.parse(readFileSync(path.join(folder, 'source-manifest.json'), 'utf8'));
  expect(manifest.files).toHaveLength(5);
  for (const entry of manifest.files) {
    const portable = readFileSync(path.join(folder, entry.file), 'utf8');
    expect(hash(portable)).toBe(entry.portableSha256);
    expect(portable).not.toMatch(/\]\(\/(?:Users|private\/tmp)\//);
    let reconstructed = portable;
    for (const change of entry.linkChanges) {
      expect(change.from).toMatch(/\]\(\/(?:Users|private\/tmp)\//);
      expect(reconstructed.split(change.to)).toHaveLength(2);
      reconstructed = reconstructed.replace(change.to, change.from);
      if (change.kind === 'repository-relative') {
        const target = change.to.match(/\]\(([^)]+)\)/)[1].split('#')[0];
        expect(existsSync(path.resolve(folder, target))).toBe(true);
      } else expect(change.to).toContain('harici kaynak');
    }
    expect(hash(reconstructed)).toBe(entry.originalSha256);
    expect(reconstructed.match(/NOT_RUN/g)?.length).toBe(portable.match(/NOT_RUN/g)?.length);
  }
  expect(readFileSync(path.join(root, 'DECISIONS.md'), 'utf8')).toContain('docs/features/crm-duplicate-review/README.md');
  expect(readFileSync(path.join(root, 'docs/README.md'), 'utf8')).toContain('features/crm-duplicate-review/README.md');
  expect(readFileSync(path.join(folder, 'README.md'), 'utf8')).toContain('PR1 merged / PR2 merged / PR3 implemented-under-independent-review');
  expect(existsSync(path.join(folder, 'approved-design-originals.zip'))).toBe(false);
});

it('F16: rollout entry point distinguishes merged PR1/PR2, implemented PR3 and undeployed catalog 060', () => {
  const readme = readFileSync(path.join(folder, 'README.md'), 'utf8');
  expect(readme).toContain('PR1 merged / PR2 merged / PR3 implemented-under-independent-review');
  expect(readme).toContain('Catalog head 060');
  expect(readme).toContain('Production rollout: NOT DEPLOYED');
  expect(readme).not.toContain('PR2/PR3 persistent decisions, reopen and history are not implemented');
  expect(readme).not.toContain('Catalog head 059');
  expect(readme).toContain('PR3 adds the independent review register');
});
