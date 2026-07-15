import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JobFilters } from '../src/jobs/JobFilters';
import { jobTypeLabels } from '../src/jobs/job-labels';

describe('JobCard workspace ownership', () => {
  it('renders both exhaustive JobCard type filter labels', () => {
    expect(jobTypeLabels).toEqual({
      PRODUCT_DELIVERY: 'Ürün teslimi', GENERAL_TASK: 'Genel görev',
    });
    const html = renderToStaticMarkup(<JobFilters
      user={{ id: 'manager-1', organizationId: 'org-1', name: 'Manager', email: 'm@test.local',
        role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 }}
      filters={{ status: 'active', view: 'list', offset: 0 }}
      onApply={() => undefined} onChange={() => undefined} onViewChange={() => undefined}
      showViewControl
    />);
    expect(html).toContain('<option value="PRODUCT_DELIVERY">Ürün teslimi</option>');
    expect(html).toContain('<option value="GENERAL_TASK">Genel görev</option>');
  });

  it('removes the bounded legacy adapter and global unpaginated workspace state', async () => {
    const api = await readFile(fileURLToPath(new URL('../src/services/api.ts', import.meta.url)), 'utf8');
    const app = await readFile(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8');
    expect(api).not.toContain('listLegacyWorkspaceJobs');
    expect(api).not.toContain('LegacyWorkspaceJob');
    expect(app).not.toContain('WorkspaceState');
    expect(app).not.toContain('listLegacyWorkspaceJobs');
  });
});
