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
  expect(readFileSync(path.join(folder, 'README.md'), 'utf8')).toContain('PR2 Implemented / PR3 Pending Independent Review');
  expect(existsSync(path.join(folder, 'approved-design-originals.zip'))).toBe(false);
});
