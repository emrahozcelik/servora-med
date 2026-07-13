import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('JobCard workspace ownership', () => {
  it('removes the bounded legacy adapter and global unpaginated workspace state', async () => {
    const api = await readFile(fileURLToPath(new URL('../src/services/api.ts', import.meta.url)), 'utf8');
    const app = await readFile(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8');
    expect(api).not.toContain('listLegacyWorkspaceJobs');
    expect(api).not.toContain('LegacyWorkspaceJob');
    expect(app).not.toContain('WorkspaceState');
    expect(app).not.toContain('listLegacyWorkspaceJobs');
  });
});
