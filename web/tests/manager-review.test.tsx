import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ManagerReviewActions, runManagerJobCommand } from '../src/JobDetail';
import { ApiError, type Activity, type JobCard } from '../src/services/api';

const job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 4,
  title: 'Klinik teslimi', description: null, customerId: 'c1', assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null };
const activity: Activity[] = [{ id: 'e1', jobCardId: 'job-1', actorId: 's1', eventType: 'JOB_SUBMITTED_FOR_APPROVAL', oldValue: null,
  newValue: null, metadata: null, clientActionId: 'a1', createdAt: '2026-07-11T10:00:00Z' }];

describe('Manager review', () => {
  it('renders immutable activity and explicit review actions', () => {
    const html = renderToStaticMarkup(<ManagerReviewActions activities={activity} pending={false} revisionOpen={false}
      onApprove={() => {}} onOpenRevision={() => {}} onCancelRevision={() => {}} onRequestRevision={() => {}} />);
    expect(html).toContain('Onaya gönderildi');
    expect(html).toContain('11 Tem 2026');
    expect(html).toContain('Onayla');
    expect(html).toContain('Düzeltme iste');
    expect(html).not.toContain('name="quantity"');
  });

  it('uses an inline required revision reason instead of a modal', () => {
    const html = renderToStaticMarkup(<ManagerReviewActions activities={activity} pending={false} revisionOpen
      onApprove={() => {}} onOpenRevision={() => {}} onCancelRevision={() => {}} onRequestRevision={() => {}} />);
    expect(html).toContain('<label for="revision-reason">Düzeltme nedeni</label>');
    expect(html).toContain('required=""');
    expect(html).toContain('Düzeltme talebini gönder');
  });

  it('sends approve and revision with the current backend version', async () => {
    const approve = vi.fn().mockResolvedValue({ ...job, status: 'COMPLETED', version: 5 });
    const revise = vi.fn().mockResolvedValue({ ...job, status: 'REVISION_REQUESTED', version: 5 });
    const refresh = vi.fn();
    await runManagerJobCommand(job, 'approve', '', { approve, revise, refresh, createActionId: () => 'approve-1' });
    await runManagerJobCommand(job, 'revise', 'Miktarı doğrulayın', { approve, revise, refresh, createActionId: () => 'revise-1' });
    expect(approve).toHaveBeenCalledWith('job-1', { clientActionId: 'approve-1', expectedVersion: 4 });
    expect(revise).toHaveBeenCalledWith('job-1', { clientActionId: 'revise-1', expectedVersion: 4, revisionReason: 'Miktarı doğrulayın' });
  });

  it('refetches after manager version conflict', async () => {
    const refreshed = { ...job, version: 5 };
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const result = await runManagerJobCommand(job, 'approve', '', {
      approve: vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Güncellendi')),
      revise: vi.fn(), refresh, createActionId: () => 'approve-1',
    });
    expect(result).toEqual({ kind: 'conflict', job: refreshed });
  });
});
