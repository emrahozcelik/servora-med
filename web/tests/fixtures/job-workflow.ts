import type { JobWorkflowContext } from '../../src/jobs/jobs-api';

export const workflowContext: JobWorkflowContext = {
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
  allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
  lifecycle: {
    createdAt: '2026-07-17T08:00:00.000Z',
    acceptedAt: null,
    acceptedBy: null,
    startedAt: '2026-07-17T09:00:00.000Z', submittedAt: null,
    submittedBy: null, submissionNote: null, approvedAt: null, approvedBy: null,
    approvalNote: null, revisionRequestedAt: null, revisionRequestedBy: null,
    revisionReason: null, cancelledAt: null, cancelledBy: null,
    cancelReason: null, cancelledFromStatus: null,
  },
  submissionReadiness: {
    evaluatedAt: '2026-07-17T12:00:00.000Z', ready: false,
    items: [{ code: 'DELIVERY_ITEM_PRESENT', state: 'missing', field: 'deliveryItems' }],
  },
};
