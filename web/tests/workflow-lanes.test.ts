import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  activeWorkflowPresentation, activeWorkflowStatusOptions,
} from '../src/jobs/job-status-presentation';
import { workflowLanesFor } from '../src/jobs/workflow-lanes';

describe('workflow lane presentation model', () => {
  it('keeps shared active status presentation in a lane-neutral module', async () => {
    const sourceRoot = resolve(process.cwd(), 'src/jobs');
    const neutralSource = await readFile(resolve(sourceRoot, 'job-status-presentation.ts'), 'utf8')
      .catch(() => '');
    const laneSource = await readFile(resolve(sourceRoot, 'workflow-lanes.ts'), 'utf8');
    const labelSource = await readFile(resolve(sourceRoot, 'job-labels.ts'), 'utf8');

    expect(neutralSource).toContain('activeWorkflowPresentation');
    expect(laneSource).toContain("from './job-status-presentation'");
    expect(labelSource).toContain("from './job-status-presentation'");
  });

  it('owns the active workflow labels used by every current-state consumer', () => {
    expect(activeWorkflowPresentation).toEqual({
      NEW: { status: 'NEW', label: 'Hazırlanıyor' },
      ACCEPTED: { status: 'ACCEPTED', label: 'Atandı' },
      IN_PROGRESS: { status: 'IN_PROGRESS', label: 'Uygulanıyor' },
      WAITING_APPROVAL: { status: 'WAITING_APPROVAL', label: 'Yönetici kontrolünde' },
      REVISION_REQUESTED: { status: 'REVISION_REQUESTED', label: 'Düzeltme istendi' },
    });
    expect(activeWorkflowStatusOptions).toEqual([
      { value: 'NEW', label: 'Hazırlanıyor' },
      { value: 'ACCEPTED', label: 'Atandı' },
      { value: 'IN_PROGRESS', label: 'Uygulanıyor' },
      { value: 'WAITING_APPROVAL', label: 'Yönetici kontrolünde' },
      { value: 'REVISION_REQUESTED', label: 'Düzeltme istendi' },
    ]);
  });

  it('uses the approved desktop order and labels for every role', () => {
    const expected = [
      ['NEW', 'Hazırlanıyor'],
      ['ACCEPTED', 'Atandı'],
      ['IN_PROGRESS', 'Uygulanıyor'],
      ['WAITING_APPROVAL', 'Yönetici kontrolünde'],
      ['REVISION_REQUESTED', 'Düzeltme istendi'],
    ];

    for (const role of ['STAFF', 'MANAGER', 'ADMIN'] as const) {
      expect(workflowLanesFor(role, false).map(({ status, label }) => [status, label])).toEqual(expected);
    }
  });

  it('prioritizes recovery work for Staff on compact shells', () => {
    expect(workflowLanesFor('STAFF', true).map(({ status }) => status)).toEqual([
      'REVISION_REQUESTED', 'IN_PROGRESS', 'ACCEPTED', 'NEW', 'WAITING_APPROVAL',
    ]);
  });

  it.each(['MANAGER', 'ADMIN'] as const)('puts the control queue first for %s on compact shells', (role) => {
    expect(workflowLanesFor(role, true).map(({ status }) => status)).toEqual([
      'WAITING_APPROVAL', 'REVISION_REQUESTED', 'IN_PROGRESS', 'NEW', 'ACCEPTED',
    ]);
  });

  it('never creates persisted, terminal, or synthetic statuses', () => {
    const statuses = workflowLanesFor('MANAGER', true).map(({ status }) => status);
    expect(statuses).not.toContain('PLANNED');
    expect(statuses).not.toContain('COMPLETED');
    expect(statuses).not.toContain('CANCELLED');
    expect(statuses).not.toContain('OVERDUE');
  });
});
