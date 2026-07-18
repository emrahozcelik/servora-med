import { describe, expect, it } from 'vitest';

import {
  deriveCompactWorkflowSummary,
  deriveJobWorkflowPresentation,
  requirementLabels,
} from '../src/jobs/job-workflow-presentation';
import { jobStatusLabels } from '../src/jobs/job-labels';
import type {
  JobCard,
  JobCardStatus,
  JobLifecycleFacts,
  JobWorkflowContext,
  LifecycleCommand,
  SubmissionRequirement,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

const staff: CurrentUser = {
  id: 's1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'ayse@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = {
  id: 'm1', organizationId: 'org-1', name: 'Mehmet Yönetici', email: 'mehmet@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};
const admin: CurrentUser = { ...manager, id: 'a1', name: 'Admin', role: 'ADMIN' };

const baseJob: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS',
  version: 1, title: 'ABC Klinik teslimi', description: null, customerId: 'c1',
  contactId: null, assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
  assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'ABC Klinik' },
  contact: null, workflowContext,
};

function contextWith(partial: Partial<JobWorkflowContext>): JobWorkflowContext {
  return {
    ...workflowContext,
    ...partial,
    lifecycle: partial.lifecycle
      ? { ...workflowContext.lifecycle, ...partial.lifecycle }
      : workflowContext.lifecycle,
    submissionReadiness: partial.submissionReadiness === undefined
      ? workflowContext.submissionReadiness
      : partial.submissionReadiness,
  };
}

function jobWith(partial: Partial<JobCard> & {
  workflowContext?: JobWorkflowContext;
}): JobCard {
  return {
    ...baseJob,
    ...partial,
    workflowContext: partial.workflowContext ?? baseJob.workflowContext,
  };
}

function derive(job: JobCard, user: CurrentUser = staff) {
  return deriveJobWorkflowPresentation({
    job,
    user,
    workflowContext: job.workflowContext,
    deliveryItems: [],
    meetingDetails: null,
  });
}

function jobAt(status: JobCardStatus, lifecycle: JobLifecycleFacts) {
  return jobWith({ status, workflowContext: contextWith({ lifecycle }) });
}

describe('deriveJobWorkflowPresentation', () => {
  it('marks acceptance missing only when execution exists without an accepted timestamp', () => {
    const model = derive(jobWith({
      status: 'IN_PROGRESS',
      workflowContext: contextWith({
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: null,
          acceptedBy: null,
          startedAt: '2026-07-17T09:00:00.000Z',
        },
      }),
    }));
    expect(model.phaseItems.map(({ label, state }) => [label, state])).toEqual([
      ['Atandı', 'complete'], ['Kabul bilgisi kaydedilmemiş', 'skipped'],
      ['Uygulanıyor', 'current'], ['Yönetici kontrolü', 'upcoming'],
      ['Tamamlandı', 'upcoming'],
    ]);
    expect(model.currentPhase).toBe('EXECUTION');
    expect(model.phaseItems.map(({ label }) => label).join(' ')).not.toContain('Planlama atlandı');
  });

  it('shows acceptance complete when an accepted timestamp exists', () => {
    const model = derive(jobWith({
      status: 'IN_PROGRESS',
      workflowContext: contextWith({
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: '2026-07-17T08:30:00.000Z',
          acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          startedAt: '2026-07-17T09:00:00.000Z',
        },
      }),
    }));
    expect(model.phaseItems.map(({ phase, label, state }) => [phase, label, state])).toEqual([
      ['CREATED', 'Atandı', 'complete'],
      ['ACCEPTANCE', 'Kabul edildi', 'complete'],
      ['EXECUTION', 'Uygulanıyor', 'current'],
      ['REVIEW', 'Yönetici kontrolü', 'upcoming'],
      ['COMPLETION', 'Tamamlandı', 'upcoming'],
    ]);
  });

  it('maps NEW and ACCEPTED to the correct current phases', () => {
    const created = derive(jobWith({
      status: 'NEW',
      workflowContext: contextWith({
        allowedCommands: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: null, acceptedBy: null, startedAt: null,
        },
        submissionReadiness: null,
      }),
    }));
    expect(created.currentPhase).toBe('CREATED');
    expect(created.phaseItems.map(({ label, state }) => [label, state])).toEqual([
      ['Atandı', 'current'], ['Kabul edildi', 'upcoming'],
      ['Uygulanıyor', 'upcoming'], ['Yönetici kontrolü', 'upcoming'],
      ['Tamamlandı', 'upcoming'],
    ]);
    expect(created.terminalState).toBeNull();

    const accepted = derive(jobWith({
      status: 'ACCEPTED',
      workflowContext: contextWith({
        allowedCommands: ['START', 'CANCEL'],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: '2026-07-17T08:30:00.000Z',
          acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          startedAt: null,
        },
        submissionReadiness: null,
      }),
    }));
    expect(accepted.currentPhase).toBe('ACCEPTANCE');
    expect(accepted.phaseItems.map(({ state }) => state)).toEqual([
      'complete', 'current', 'upcoming', 'upcoming', 'upcoming',
    ]);
  });

  it('shows a revision loop until the work is submitted again', () => {
    const lifecycle = {
      ...workflowContext.lifecycle,
      submittedAt: '2026-07-17T10:00:00.000Z',
      revisionRequestedAt: '2026-07-17T10:30:00.000Z',
      revisionReason: 'İkinci miktarı düzeltin',
    };
    expect(derive(jobAt('REVISION_REQUESTED', lifecycle)).revisionLoop)
      .toEqual({
        active: true, returnedFrom: 'REVIEW', returnedTo: 'EXECUTION',
        reason: 'İkinci miktarı düzeltin',
      });
    expect(derive(jobAt('IN_PROGRESS', lifecycle)).revisionLoop?.active).toBe(true);
    expect(derive(jobAt('WAITING_APPROVAL', {
      ...lifecycle, submittedAt: '2026-07-17T11:00:00.000Z',
    })).revisionLoop).toBeNull();
  });

  it('marks execution as attention while revision is requested', () => {
    const model = derive(jobWith({
      status: 'REVISION_REQUESTED',
      workflowContext: contextWith({
        allowedCommands: ['RESUME', 'CANCEL'],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: null,
          acceptedBy: null,
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          revisionRequestedAt: '2026-07-17T10:30:00.000Z',
          revisionReason: 'Miktarı düzeltin',
        },
      }),
    }));
    expect(model.currentPhase).toBe('EXECUTION');
    expect(model.phaseItems.find((item) => item.phase === 'EXECUTION')?.state).toBe('attention');
  });

  it('uses exact consequence-led manager transitions without changing permissions', () => {
    const managerWaitingJob = jobWith({
      type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
      workflowContext: contextWith({
        allowedCommands: [
          'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
        ],
        allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
      }),
    });
    const model = derive(managerWaitingJob, manager);
    expect(model.primaryTransition).toMatchObject({
      command: 'APPROVE', label: 'Kontrolü tamamla ve işi kapat',
      successMessage: 'İş tamamlandı ve aktif işlerden çıkarıldı.',
      confirmation: { title: 'İşi tamamlamak üzeresiniz', confirmLabel: 'İşi tamamla' },
    });
    expect(model.primaryTransition?.confirmation?.details).toEqual([
      'Yönetici kontrolünü tamamlar',
      'İşi “Tamamlandı” durumuna geçirir',
      'Aktif iş listesinden kaldırır',
      'İş geçmişine onay kaydı ekler',
    ]);
    expect(model.secondaryTransitions.map(({ command, label }) => [command, label])).toEqual([
      ['REQUEST_REVISION', 'Düzeltme için personele geri gönder'],
      ['WITHDRAW_FROM_APPROVAL', 'Kontrolden geri çek'],
      ['CANCEL', 'İşi iptal et'],
    ]);
    expect(model.responsibility.role).toBe('MANAGEMENT');
  });

  it('keeps management interventions secondary outside the management review phase', () => {
    const managerInProgressJob = jobWith({
      type: 'GENERAL_TASK', status: 'IN_PROGRESS',
      workflowContext: contextWith({
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    });
    const model = derive(managerInProgressJob, manager);
    expect(model.responsibility.role).toBe('STAFF');
    expect(model.primaryTransition).toBeNull();
    expect(model.secondaryTransitions.map((item) => item.command)).toEqual([
      'SUBMIT_FOR_APPROVAL', 'CANCEL',
    ]);
  });

  it('gives assigned Staff the exact primary transitions by phase', () => {
    const newJob = jobWith({
      status: 'NEW', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        lifecycle: {
          ...workflowContext.lifecycle, acceptedAt: null, acceptedBy: null, startedAt: null,
        },
        submissionReadiness: null,
      }),
    });
    expect(derive(newJob, staff).primaryTransition).toMatchObject({
      command: 'ACCEPT_ASSIGNMENT',
      label: 'İşi kabul et',
    });
    expect(derive(newJob, staff).secondaryTransitions.map((t) => t.command))
      .toEqual(['CANCEL']);

    const acceptedJob = jobWith({
      status: 'ACCEPTED', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: '2026-07-17T08:30:00.000Z',
          acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          startedAt: null,
        },
        submissionReadiness: null,
      }),
    });
    expect(derive(acceptedJob, staff).primaryTransition).toMatchObject({
      command: 'START',
      label: 'İşi başlat',
    });
    expect(derive(acceptedJob, staff).secondaryTransitions.map((t) => t.command))
      .toEqual(['CANCEL']);

    const inProgress = jobWith({
      status: 'IN_PROGRESS', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    });
    expect(derive(inProgress, staff).primaryTransition).toMatchObject({
      command: 'SUBMIT_FOR_APPROVAL',
      label: 'Kontrole gönder',
    });

    const revision = jobWith({
      status: 'REVISION_REQUESTED', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['RESUME', 'CANCEL'],
        lifecycle: {
          ...workflowContext.lifecycle,
          submittedAt: '2026-07-17T10:00:00.000Z',
          revisionRequestedAt: '2026-07-17T10:30:00.000Z',
          revisionReason: 'Düzeltin',
        },
      }),
    });
    expect(derive(revision, staff).primaryTransition).toMatchObject({
      command: 'RESUME',
      label: 'Düzeltmeye başla',
    });
  });

  it('does not fabricate acceptance for management viewing NEW', () => {
    const managerNewJob = jobWith({
      status: 'NEW', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['CANCEL'],
        allowedActions: ['VIEW_NOTES'],
        lifecycle: {
          ...workflowContext.lifecycle, acceptedAt: null, acceptedBy: null, startedAt: null,
        },
        submissionReadiness: null,
      }),
    });
    const model = derive(managerNewJob, manager);
    expect(model.primaryTransition).toBeNull();
    expect(model.secondaryTransitions.map((t) => t.command)).toEqual(['CANCEL']);
    expect(model.secondaryTransitions.some((t) => t.command === 'ACCEPT_ASSIGNMENT')).toBe(false);
  });

  it('does not give unassigned Staff a primary transition', () => {
    const model = derive(jobWith({
      status: 'IN_PROGRESS', assignedTo: 'other-staff',
      workflowContext: contextWith({
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      }),
    }), staff);
    expect(model.primaryTransition).toBeNull();
    expect(model.secondaryTransitions.map((t) => t.command)).toEqual([
      'SUBMIT_FOR_APPROVAL', 'CANCEL',
    ]);
  });

  it('does not give Staff a primary transition while management owns review', () => {
    const model = derive(jobWith({
      status: 'WAITING_APPROVAL', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
      }),
    }), staff);
    expect(model.responsibility.role).toBe('MANAGEMENT');
    expect(model.primaryTransition).toBeNull();
    expect(model.secondaryTransitions.map(({ command, label }) => [command, label])).toEqual([
      ['WITHDRAW_FROM_APPROVAL', 'Kontrolden geri çek ve düzenle'],
      ['CANCEL', 'İşi iptal et'],
    ]);
  });

  it('uses the revised submit label while the revision loop is active', () => {
    const model = derive(jobWith({
      status: 'IN_PROGRESS', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        lifecycle: {
          ...workflowContext.lifecycle,
          submittedAt: '2026-07-17T10:00:00.000Z',
          revisionRequestedAt: '2026-07-17T10:30:00.000Z',
          revisionReason: 'Düzeltin',
        },
      }),
    }), staff);
    expect(model.primaryTransition?.label).toBe('Yeniden kontrole gönder');
  });

  it('presents WITHDRAW_AND_EDIT as a record action and hides duplicate withdraw', () => {
    const model = derive(jobWith({
      type: 'SALES_MEETING', status: 'WAITING_APPROVAL', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    }), staff);
    expect(model.recordEditAction).toEqual({
      action: 'WITHDRAW_AND_EDIT_JOB_FIELDS',
      label: 'Kontrolden geri çek ve düzenle',
      consequence: 'Kontrol sona erecek ve iş yeniden “Uygulanıyor” aşamasına alınacaktır. '
        + 'Değişiklikler işi onaylamaz veya tamamlamaz; işin tekrar kontrole gönderilmesi gerekir.',
      confirmation: {
        title: 'Kontrolden geri çek ve düzenle',
        details: [
          'Yönetici kontrolünü sona erdirir',
          'İşi yeniden “Uygulanıyor” aşamasına alır',
          'İşi onaylamaz veya tamamlamaz',
          'Değişikliklerden sonra yeniden kontrole gönderim gerektirir',
        ],
        confirmLabel: 'Geri çek ve düzenle',
      },
    });
    expect(model.secondaryTransitions.map((t) => t.command)).toEqual(['CANCEL']);
  });

  it('presents management withdraw-and-edit with management wording', () => {
    const model = derive(jobWith({
      type: 'SALES_MEETING', status: 'WAITING_APPROVAL',
      workflowContext: contextWith({
        allowedCommands: [
          'APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL',
        ],
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    }), manager);
    expect(model.recordEditAction).toMatchObject({
      action: 'WITHDRAW_AND_EDIT_JOB_FIELDS',
      label: 'Kontrolden çıkar ve kayıtları düzenle',
      confirmation: {
        title: 'Kontrolden çıkar ve kayıtları düzenle',
        confirmLabel: 'Kontrolden çıkar ve düzenle',
      },
    });
    expect(model.secondaryTransitions.map((t) => t.command)).toEqual([
      'REQUEST_REVISION', 'CANCEL',
    ]);
  });

  it('presents Sales Meeting field edit without confirmation', () => {
    const model = derive(jobWith({
      type: 'SALES_MEETING', status: 'IN_PROGRESS', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE', 'EDIT_MEETING_RESULT'],
      }),
    }), staff);
    expect(model.recordEditAction).toEqual({
      action: 'EDIT_JOB_FIELDS',
      label: 'Görüşmeyi düzenle',
      consequence: 'Görüşme bilgileri düzenlenecektir.',
    });
  });

  it('offers schedule edit only in NEW and ACCEPTED when EDIT_JOB_FIELDS is allowed', () => {
    const actions = ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'] as const;
    const newModel = derive(jobWith({
      status: 'NEW',
      workflowContext: contextWith({
        allowedCommands: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
        allowedActions: [...actions],
      }),
    }));
    expect(newModel.scheduleEdit).toEqual({
      label: 'Planlanan teslim zamanı',
      optional: false,
    });

    const acceptedModel = derive(jobWith({
      status: 'ACCEPTED',
      workflowContext: contextWith({
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: [...actions],
      }),
    }));
    expect(acceptedModel.scheduleEdit).toEqual({
      label: 'Planlanan teslim zamanı',
      optional: false,
    });

    const inProgressModel = derive(jobWith({
      status: 'IN_PROGRESS',
      workflowContext: contextWith({
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: [...actions],
      }),
    }));
    expect(inProgressModel.scheduleEdit).toBeNull();

    const revisionModel = derive(jobWith({
      status: 'REVISION_REQUESTED',
      workflowContext: contextWith({
        allowedCommands: ['RESUME', 'CANCEL'],
        allowedActions: [...actions],
      }),
    }));
    expect(revisionModel.scheduleEdit).toBeNull();
  });

  it('labels every submission requirement code from the SSOT', () => {
    const items: SubmissionRequirement[] = (Object.keys(requirementLabels) as Array<
      SubmissionRequirement['code']
    >).map((code, index) => ({
      code,
      state: index % 3 === 0 ? 'met' : index % 3 === 1 ? 'missing' : 'invalid',
      field: `field-${code}`,
    }));
    const model = derive(jobWith({
      status: 'IN_PROGRESS',
      workflowContext: contextWith({
        submissionReadiness: {
          evaluatedAt: '2026-07-17T12:00:00.000Z',
          ready: false,
          items,
        },
      }),
    }));
    expect(model.requirements).toEqual(items.map((item) => ({
      ...item,
      label: requirementLabels[item.code],
    })));
    expect(Object.keys(requirementLabels).sort()).toEqual([
      'ASSIGNEE_ELIGIBLE',
      'CUSTOMER_ELIGIBLE',
      'DELIVERY_ITEMS_VALID',
      'DELIVERY_ITEM_PRESENT',
      'FOLLOW_UP_TIME_VALID',
      'MEETING_OUTCOME_VALID',
      'MEETING_SUMMARY_PRESENT',
      'MEETING_TIME_VALID',
      'TASK_TITLE_VALID',
    ]);
  });

  it('returns empty requirements when readiness is null', () => {
    const model = derive(jobWith({
      status: 'NEW',
      workflowContext: contextWith({
        submissionReadiness: null,
        lifecycle: {
          ...workflowContext.lifecycle, acceptedAt: null, acceptedBy: null, startedAt: null,
        },
      }),
    }));
    expect(model.requirements).toEqual([]);
  });

  it('never invents commands that the backend did not allow', () => {
    const model = derive(jobWith({
      status: 'IN_PROGRESS', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['CANCEL'],
        allowedActions: ['VIEW_NOTES'],
      }),
    }), staff);
    expect(model.primaryTransition).toBeNull();
    expect(model.secondaryTransitions.map((t) => t.command)).toEqual(['CANCEL']);
    expect(model.recordEditAction).toBeNull();
  });

  it('always places CANCEL last among secondary transitions', () => {
    const model = derive(jobWith({
      status: 'NEW', assignedTo: 's1',
      workflowContext: contextWith({
        allowedCommands: ['CANCEL', 'ACCEPT_ASSIGNMENT'] as LifecycleCommand[],
        submissionReadiness: null,
        lifecycle: {
          ...workflowContext.lifecycle, acceptedAt: null, acceptedBy: null, startedAt: null,
        },
      }),
    }), staff);
    expect(model.primaryTransition?.command).toBe('ACCEPT_ASSIGNMENT');
    expect(model.secondaryTransitions.map((t) => t.command)).toEqual(['CANCEL']);
  });

  it('exposes completed terminal presentation with full phase progress', () => {
    const model = derive(jobWith({
      status: 'COMPLETED',
      workflowContext: contextWith({
        allowedCommands: [],
        allowedActions: ['VIEW_NOTES'],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: '2026-07-17T08:30:00.000Z',
          acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          approvedAt: '2026-07-17T11:00:00.000Z',
        },
        submissionReadiness: null,
      }),
    }));
    expect(model.terminalState).toBe('COMPLETED');
    expect(model.currentPhase).toBe('COMPLETION');
    expect(model.primaryTransition).toBeNull();
    expect(model.secondaryTransitions).toEqual([]);
    expect(model.responsibility.role).toBeNull();
    expect(model.phaseItems.map(({ state }) => state)).toEqual([
      'complete', 'complete', 'complete', 'complete', 'current',
    ]);
  });

  it('freezes cancelled detail at the cancelled-from phase with attention', () => {
    const model = derive(jobWith({
      status: 'CANCELLED',
      workflowContext: contextWith({
        allowedCommands: [],
        allowedActions: [],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: null,
          acceptedBy: null,
          startedAt: '2026-07-17T09:00:00.000Z',
          cancelledAt: '2026-07-17T12:00:00.000Z',
          cancelReason: 'Müşteri erteledi',
          cancelledFromStatus: 'IN_PROGRESS',
        },
        submissionReadiness: null,
      }),
    }));
    expect(model.terminalState).toBe('CANCELLED');
    expect(model.currentPhase).toBe('EXECUTION');
    expect(model.phaseItems.map(({ label, state }) => [label, state])).toEqual([
      ['Atandı', 'complete'],
      ['Kabul bilgisi kaydedilmemiş', 'skipped'],
      ['Uygulanıyor', 'attention'],
      ['Yönetici kontrolü', 'upcoming'],
      ['Tamamlandı', 'upcoming'],
    ]);
  });

  it('handles cancelled jobs without a safe source phase', () => {
    const model = derive(jobWith({
      status: 'CANCELLED',
      workflowContext: contextWith({
        allowedCommands: [],
        allowedActions: [],
        lifecycle: {
          ...workflowContext.lifecycle,
          acceptedAt: null,
          acceptedBy: null,
          startedAt: null,
          cancelledAt: '2026-07-17T12:00:00.000Z',
          cancelReason: 'İptal',
          cancelledFromStatus: null,
        },
        submissionReadiness: null,
      }),
    }));
    expect(model.terminalState).toBe('CANCELLED');
    expect(model.currentPhase).toBeNull();
    expect(model.phaseItems.map(({ state }) => state)).toEqual([
      'complete', 'upcoming', 'upcoming', 'upcoming', 'upcoming',
    ]);
  });

  it('shares job status labels for chip and presentation consumers', () => {
    expect(jobStatusLabels).toMatchObject({
      NEW: 'Hazırlanıyor',
      ACCEPTED: 'Atandı',
      PLANNED: 'Planlandı',
      IN_PROGRESS: 'Uygulanıyor',
      WAITING_APPROVAL: 'Yönetici kontrolünde',
      REVISION_REQUESTED: 'Düzeltme istendi',
      COMPLETED: 'Tamamlandı',
      CANCELLED: 'İptal edildi',
    });
  });
});


  it('surfaces staff waiting-state submission facts from lifecycle', () => {
    const model = derive(jobWith({
      status: 'WAITING_APPROVAL',
      workflowContext: contextWith({
        allowedCommands: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_NOTES'],
        lifecycle: {
          ...workflowContext.lifecycle,
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          submittedBy: { id: 's1', name: 'Ayşe Personel' },
        },
        submissionReadiness: { ready: true, items: [] },
      }),
    }), staff);
    expect(model.responsibility.title).toBe('Yönetici kontrolünde');
    expect(model.responsibility.submission).toEqual({
      actorName: 'Ayşe Personel',
      at: '2026-07-17T10:00:00.000Z',
    });
    const managerModel = derive(jobWith({
      status: 'WAITING_APPROVAL',
      workflowContext: contextWith({
        allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_NOTES'],
        lifecycle: {
          ...workflowContext.lifecycle,
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          submittedBy: { id: 's1', name: 'Ayşe Personel' },
        },
        submissionReadiness: { ready: true, items: [] },
      }),
    }), manager);
    expect(managerModel.responsibility.title).toBe('Yönetici kontrolü');
    expect(managerModel.responsibility.submission?.actorName).toBe('Ayşe Personel');
  });

describe('deriveCompactWorkflowSummary', () => {
  it('returns ordinal, label, attention, and expected role by status', () => {
    expect(deriveCompactWorkflowSummary({
      job: { status: 'NEW' }, user: staff,
    })).toEqual({
      ordinal: 1, total: 5, label: 'Hazırlanıyor', attention: false, expectedRole: 'STAFF',
    });
    expect(deriveCompactWorkflowSummary({
      job: { status: 'ACCEPTED' }, user: staff,
    })).toEqual({
      ordinal: 2, total: 5, label: 'Atandı', attention: false, expectedRole: 'STAFF',
    });
    expect(deriveCompactWorkflowSummary({
      job: { status: 'IN_PROGRESS' }, user: staff,
    })).toEqual({
      ordinal: 3, total: 5, label: 'Uygulanıyor', attention: false, expectedRole: 'STAFF',
    });
    expect(deriveCompactWorkflowSummary({
      job: { status: 'REVISION_REQUESTED' }, user: staff,
    })).toEqual({
      ordinal: 3, total: 5, label: 'Düzeltme istendi', attention: true, expectedRole: 'STAFF',
    });
    expect(deriveCompactWorkflowSummary({
      job: { status: 'WAITING_APPROVAL' }, user: manager,
    })).toEqual({
      ordinal: 4, total: 5, label: 'Yönetici kontrolünde', attention: false,
      expectedRole: 'MANAGEMENT',
    });
    expect(deriveCompactWorkflowSummary({
      job: { status: 'COMPLETED' }, user: staff,
    })).toEqual({
      ordinal: 5, total: 5, label: 'Tamamlandı', attention: false, expectedRole: null,
    });
  });

  it('uses null ordinal for cancelled compact rows', () => {
    expect(deriveCompactWorkflowSummary({
      job: { status: 'CANCELLED' }, user: staff,
    })).toEqual({
      ordinal: null, total: 5, label: 'İptal edildi', attention: false, expectedRole: null,
    });
  });
});
