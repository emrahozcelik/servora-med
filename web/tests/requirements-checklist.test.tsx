/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JobApprovalReviewPanel } from '../src/jobs/JobApprovalReviewPanel';
import { RequirementsChecklist } from '../src/jobs/JobWorkflowPanels';
import type { JobWorkflowPresentation } from '../src/jobs/job-workflow-presentation';
import type { JobCard, JobLifecycleFacts } from '../src/jobs/jobs-api';

const requirements: JobWorkflowPresentation['requirements'] = [
  { code: 'DELIVERY_ITEMS_PRESENT', state: 'met', label: 'Teslim ürün kalemleri' },
  { code: 'DELIVERY_PURPOSE_PRESENT', state: 'met', label: 'Teslim amacı' },
  { code: 'DELIVERY_ACTUAL_TIME_PRESENT', state: 'missing', label: 'Gerçekleşen teslim zamanı' },
  { code: 'DELIVERY_QUANTITIES_VALID', state: 'invalid', label: 'Ürün miktarları' },
];

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-07-17T08:00:00.000Z',
  acceptedAt: '2026-07-17T08:15:00.000Z',
  acceptedBy: { id: 'staff-1', name: 'Ayşe Personel' },
  startedAt: '2026-07-17T09:00:00.000Z',
  submittedAt: '2026-07-17T10:00:00.000Z',
  submittedBy: { id: 'staff-1', name: 'Ayşe Personel' },
  submissionNote: null,
  approvedAt: null,
  approvedBy: null,
  approvalNote: null,
  revisionRequestedAt: null,
  revisionRequestedBy: null,
  revisionReason: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  cancelledFromStatus: null,
};

const baseJob: JobCard = {
  id: 'job-1',
  organizationId: 'org-1',
  type: 'PRODUCT_DELIVERY',
  status: 'WAITING_APPROVAL',
  version: 3,
  title: 'ABC Klinik ürün teslimi',
  description: null,
  customerId: 'c1',
  contactId: null,
  assignedTo: 'staff-1',
  createdBy: 'mgr-1',
  priority: 'normal',
  dueDate: null,
  scheduledAt: '2026-07-17T09:00:00.000Z',
  engagementKind: null,
  assignee: { id: 'staff-1', name: 'Ayşe Personel' },
  customer: { id: 'c1', name: 'ABC Klinik' },
  contact: null,
  workflowContext: {
    allowedCommands: ['APPROVE', 'REQUEST_REVISION'],
    allowedActions: [],
    lifecycle,
    submissionReadiness: {
      ready: false,
      items: requirements.map(({ code, state }) => ({ code, state })),
    },
    invalidation: null,
  },
  followUpContext: null,
  followUpProposal: null,
  earlyStartAuthorization: null,
  submitLocationComparison: null,
  changeRequest: null,
  assignmentOffer: null,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
};

describe('Requirements checklist visual parity (Staff & Manager)', () => {
  it('renders Staff checklist with SVG icons, semantic states, and readiness counter', () => {
    const html = renderToStaticMarkup(<RequirementsChecklist requirements={requirements} />);
    const host = document.createElement('div');
    host.innerHTML = html;

    expect(host.querySelector('.workflow-requirements-progress')?.textContent).toBe('2 / 4 hazır');
    expect(host.querySelectorAll('.workflow-requirement')).toHaveLength(4);
    expect(host.querySelector('.workflow-requirement-met .workflow-requirement-icon svg')).not.toBeNull();
    expect(host.querySelector('.workflow-requirement-missing .workflow-requirement-icon svg')).not.toBeNull();
    expect(host.querySelector('.workflow-requirement-invalid .workflow-requirement-icon svg')).not.toBeNull();
    expect(host.querySelector('.workflow-requirement-met .workflow-requirement-state')?.textContent).toBe('Tamam');
    expect(host.querySelector('.workflow-requirement-missing .workflow-requirement-state')?.textContent).toBe('Eksik');
    expect(host.querySelector('.workflow-requirement-invalid .workflow-requirement-state')?.textContent).toBe('Geçersiz');
  });

  it('reuses RequirementsList inside Manager JobApprovalReviewPanel with matching state markup', () => {
    const html = renderToStaticMarkup(
      <JobApprovalReviewPanel job={baseJob} lifecycle={lifecycle} requirements={requirements} />,
    );
    const host = document.createElement('div');
    host.innerHTML = html;

    const list = host.querySelector('ul.workflow-requirements-list.approval-review-requirements');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('.workflow-requirement')).toHaveLength(4);
    expect(list?.querySelectorAll('.workflow-requirement-icon svg')).toHaveLength(4);
    expect(list?.querySelector('.workflow-requirement-met .workflow-requirement-state')?.textContent).toBe('Tamam');
    expect(list?.querySelector('.workflow-requirement-missing .workflow-requirement-state')?.textContent).toBe('Eksik');
    expect(list?.querySelector('.workflow-requirement-invalid .workflow-requirement-state')?.textContent).toBe('Geçersiz');
  });
});
