import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
const ownedBoundaryRoot = resolve(sourceRoot, 'ui/antd');

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  }));

  return files.flat();
}

function isInsideOwnedBoundary(path: string) {
  return path === ownedBoundaryRoot || path.startsWith(`${ownedBoundaryRoot}${sep}`);
}

describe('Ant Design ownership boundary', () => {
  it('keeps production Ant imports and static feedback calls inside the owned boundary', async () => {
    const sourceFiles = await listSourceFiles(sourceRoot);
    const violations: string[] = [];
    const directImport = /\b(?:from\s+|import\s*(?:\(\s*)?)["']antd(?:\/[^"]*?)?["']/;
    const staticFeedback = /\b(?:(?:message|notification)\.(?:success|error|info|warning|open)|Modal\.(?:confirm|success|error|info|warning))\s*\(/;

    for (const path of sourceFiles) {
      if (isInsideOwnedBoundary(path)) {
        continue;
      }

      const source = await readFile(path, 'utf8');
      if (directImport.test(source) || staticFeedback.test(source)) {
        violations.push(relative(sourceRoot, path));
      }
    }

    expect(violations).toEqual([]);
  });

  it('does not re-export raw Ant Design primitives from the owned boundary', async () => {
    const boundaryFiles = await listSourceFiles(ownedBoundaryRoot);
    const rawReExports: string[] = [];
    const reExportFromAnt = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']antd(?:\/[^"']*)?["']/s;

    for (const path of boundaryFiles) {
      const source = await readFile(path, 'utf8');
      if (reExportFromAnt.test(source)) {
        rawReExports.push(relative(ownedBoundaryRoot, path));
      }
    }

    expect(rawReExports).toEqual([]);
  });

  it('keeps detail primitives inside their matching owned adapters', async () => {
    const boundaryFiles = await listSourceFiles(ownedBoundaryRoot);
    const owners = {
      Steps: 'WorkflowSteps.tsx',
      Descriptions: 'RecordDescriptions.tsx',
      Timeline: 'ActivityTimeline.tsx',
      Result: 'ResultState.tsx',
      Empty: 'EmptyState.tsx',
      Skeleton: 'LoadingSkeleton.tsx',
      Popconfirm: 'CompactConfirmationAction.tsx',
    } as const;
    const violations: string[] = [];
    const imports = new Map<string, string[]>();

    for (const path of boundaryFiles) {
      const source = await readFile(path, 'utf8');
      for (const [primitive, owner] of Object.entries(owners)) {
        const directImport = new RegExp(`import\\s*\\{[^}]*\\b${primitive}\\b[^}]*\\}\\s*from\\s*["']antd["']`, 's');
        if (directImport.test(source)) {
          const filename = path.split(sep).at(-1) ?? '';
          imports.set(primitive, [...(imports.get(primitive) ?? []), filename]);
          if (filename !== owner) {
            violations.push(`${relative(ownedBoundaryRoot, path)} imports ${primitive}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
    for (const [primitive, owner] of Object.entries(owners)) {
      expect(imports.get(primitive), `${primitive} owner`).toEqual([owner]);
    }
  });

  it('exports the owned compact confirmation adapter', async () => {
    const indexSource = await readFile(join(ownedBoundaryRoot, 'index.ts'), 'utf8');
    expect(indexSource).toContain(
      "export { CompactConfirmationAction } from './CompactConfirmationAction';",
    );
  });

  it('keeps servoraVisualTokens imports inside ui/antd only', async () => {
    const sourceFiles = await listSourceFiles(sourceRoot);
    const tokenImport = /from\s+['"][^'"]*servora-visual-tokens['"]/;
    const violations: string[] = [];

    for (const path of sourceFiles) {
      if (isInsideOwnedBoundary(path)) {
        continue;
      }
      // Token module itself is allowed; only feature consumers are restricted.
      if (path.endsWith(`${sep}servora-visual-tokens.ts`)) {
        continue;
      }
      const source = await readFile(path, 'utf8');
      if (tokenImport.test(source)) {
        violations.push(relative(sourceRoot, path));
      }
    }

    expect(violations).toEqual([]);
  });
});
