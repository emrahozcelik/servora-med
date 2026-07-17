import type { CurrentUser } from '../services/api';
import { jobStatusLabels } from './job-labels';
import type {
  DeliveryItem,
  JobCard,
  JobCardStatus,
  JobLifecycleFacts,
  JobWorkflowContext,
  LifecycleCommand,
  MeetingDetails,
  SubmissionRequirement,
} from './jobs-api';

export type WorkflowPhase = 'CREATED' | 'PLANNING' | 'EXECUTION' | 'REVIEW' | 'COMPLETION';
export type WorkflowPhaseState = 'complete' | 'current' | 'upcoming' | 'skipped' | 'attention';
export type ExpectedRole = 'STAFF' | 'MANAGEMENT' | null;

export type TransitionPresentation = {
  command: LifecycleCommand;
  label: string;
  consequence: string;
  successMessage: string;
  confirmation?: { title: string; details: string[]; confirmLabel: string };
};

export type RecordEditPresentation = {
  action: 'EDIT_JOB_FIELDS' | 'WITHDRAW_AND_EDIT_JOB_FIELDS';
  label: string;
  consequence: string;
  confirmation?: { title: string; details: string[]; confirmLabel: string };
};

export type JobWorkflowPresentation = {
  currentPhase: WorkflowPhase | null;
  phaseItems: Array<{ phase: WorkflowPhase; label: string; state: WorkflowPhaseState }>;
  revisionLoop: {
    active: true;
    returnedFrom: 'REVIEW';
    returnedTo: 'EXECUTION';
    reason: string | null;
  } | null;
  responsibility: {
    role: ExpectedRole;
    title: string;
    description: string;
    consequence: string | null;
  };
  requirements: Array<SubmissionRequirement & { label: string }>;
  recordEditAction: RecordEditPresentation | null;
  primaryTransition: TransitionPresentation | null;
  secondaryTransitions: TransitionPresentation[];
  terminalState: 'COMPLETED' | 'CANCELLED' | null;
};

export type CompactWorkflowSummary = {
  ordinal: 1 | 2 | 3 | 4 | 5 | null;
  total: 5;
  label: string;
  attention: boolean;
  expectedRole: ExpectedRole;
};

export type DeriveJobWorkflowPresentationInput = {
  job: JobCard;
  user: CurrentUser;
  workflowContext: JobWorkflowContext;
  deliveryItems: DeliveryItem[];
  meetingDetails: MeetingDetails | null;
};

export const requirementLabels: Record<SubmissionRequirement['code'], string> = {
  CUSTOMER_ELIGIBLE: 'Aktif ve geçerli müşteri',
  ASSIGNEE_ELIGIBLE: 'Aktif ve uygun sorumlu personel',
  DELIVERY_ITEM_PRESENT: 'En az bir ürün kalemi',
  DELIVERY_ITEMS_VALID: 'Ürün, amaç, miktar ve teslim zamanı',
  TASK_TITLE_VALID: 'Geçerli iş başlığı',
  MEETING_TIME_VALID: 'Gerçekleşen görüşme zamanı',
  MEETING_OUTCOME_VALID: 'Görüşme sonucu',
  MEETING_SUMMARY_PRESENT: 'Görüşme özeti',
  FOLLOW_UP_TIME_VALID: 'Takip zamanı (varsa görüşmeden sonra)',
};

const PHASE_ORDER: WorkflowPhase[] = [
  'CREATED', 'PLANNING', 'EXECUTION', 'REVIEW', 'COMPLETION',
];

const PHASE_LABELS: Record<WorkflowPhase, string> = {
  CREATED: 'Oluşturuldu',
  PLANNING: 'Planlandı',
  EXECUTION: 'Uygulanıyor',
  REVIEW: 'Yönetici kontrolü',
  COMPLETION: 'Tamamlandı',
};

const APPROVE_CONFIRMATION = {
  title: 'İşi tamamlamak üzeresiniz',
  details: [
    'Yönetici kontrolünü tamamlar',
    'İşi “Tamamlandı” durumuna geçirir',
    'Aktif iş listesinden kaldırır',
    'İş geçmişine onay kaydı ekler',
  ],
  confirmLabel: 'İşi tamamla',
} as const;

type CommandCopy = {
  label: string;
  consequence: string;
  successMessage: string;
  confirmation?: TransitionPresentation['confirmation'];
};

function isManagement(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

function isRevisionActive(lifecycle: JobLifecycleFacts): boolean {
  return lifecycle.revisionRequestedAt !== null
    && (lifecycle.submittedAt === null || lifecycle.revisionRequestedAt > lifecycle.submittedAt);
}

export function expectedRoleForStatus(status: JobCardStatus): ExpectedRole {
  switch (status) {
    case 'NEW':
    case 'PLANNED':
    case 'IN_PROGRESS':
    case 'REVISION_REQUESTED':
      return 'STAFF';
    case 'WAITING_APPROVAL':
      return 'MANAGEMENT';
    case 'COMPLETED':
    case 'CANCELLED':
      return null;
  }
}

function statusToPhase(status: JobCardStatus): WorkflowPhase | null {
  switch (status) {
    case 'NEW':
      return 'CREATED';
    case 'PLANNED':
      return 'PLANNING';
    case 'IN_PROGRESS':
    case 'REVISION_REQUESTED':
      return 'EXECUTION';
    case 'WAITING_APPROVAL':
      return 'REVIEW';
    case 'COMPLETED':
      return 'COMPLETION';
    case 'CANCELLED':
      return null;
  }
}

function planningSkipped(lifecycle: JobLifecycleFacts): boolean {
  return lifecycle.plannedAt === null && lifecycle.startedAt !== null;
}

function phaseIndex(phase: WorkflowPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

function commandCopy(
  command: LifecycleCommand,
  opts: { revisionActive: boolean; user: CurrentUser },
): CommandCopy {
  switch (command) {
    case 'PLAN':
      return {
        label: 'Planla',
        consequence: 'İş planlama aşamasına alınacaktır.',
        successMessage: 'İş planlandı.',
      };
    case 'START':
      return {
        label: 'İşi başlat',
        consequence: 'İş “Uygulanıyor” aşamasına alınacaktır.',
        successMessage: 'İş uygulanmaya başladı.',
      };
    case 'SUBMIT_FOR_APPROVAL':
      return {
        label: opts.revisionActive ? 'Yeniden kontrole gönder' : 'Kontrole gönder',
        consequence: 'İş yönetici kontrolüne geçecek ve kontrol sona erene kadar kayıtlar düzenlenemeyecektir.',
        successMessage: 'İş yönetici kontrolüne gönderildi. Kontrol tamamlanana veya iş geri çekilene kadar kayıtlar düzenlenemez.',
      };
    case 'APPROVE':
      return {
        label: 'Kontrolü tamamla ve işi kapat',
        consequence: 'İş “Tamamlandı” durumuna geçecek ve aktif işlerden çıkacaktır.',
        successMessage: 'İş tamamlandı ve aktif işlerden çıkarıldı.',
        confirmation: { ...APPROVE_CONFIRMATION, details: [...APPROVE_CONFIRMATION.details] },
      };
    case 'REQUEST_REVISION':
      return {
        label: 'Düzeltme için personele geri gönder',
        consequence: 'İş personele geri dönecek; yeniden düzenlemeye başlamak için personelin işi devam ettirmesi gerekecektir.',
        successMessage: 'İş düzeltme için personele geri gönderildi.',
      };
    case 'WITHDRAW_FROM_APPROVAL':
      return {
        label: opts.user.role === 'STAFF'
          ? 'Kontrolden geri çek ve düzenle'
          : 'Kontrolden geri çek',
        consequence: 'Kontrol sona erecek ve iş yeniden “Uygulanıyor” aşamasına alınacaktır; işlem geçmişi korunur.',
        successMessage: 'İş yönetici kontrolünden geri çekildi ve yeniden düzenlemeye açıldı.',
      };
    case 'RESUME':
      return {
        label: 'Düzeltmeye başla',
        consequence: 'İş yeniden “Uygulanıyor” aşamasına alınacak; tamamlandığında tekrar kontrole gönderilmesi gerekecektir.',
        successMessage: 'İş yeniden düzenlemeye açıldı. Tamamladığınızda tekrar kontrole gönderin.',
      };
    case 'CANCEL':
      return {
        label: 'İşi iptal et',
        consequence: 'İptal terminaldir; iş yeniden açılamaz.',
        successMessage: 'İş iptal edildi.',
      };
  }
}

function transitionPresentation(
  command: LifecycleCommand,
  opts: { revisionActive: boolean; user: CurrentUser },
): TransitionPresentation {
  const copy = commandCopy(command, opts);
  return {
    command,
    label: copy.label,
    consequence: copy.consequence,
    successMessage: copy.successMessage,
    ...(copy.confirmation ? { confirmation: copy.confirmation } : {}),
  };
}

function derivePhaseItems(
  status: JobCardStatus,
  lifecycle: JobLifecycleFacts,
): { currentPhase: WorkflowPhase | null; phaseItems: JobWorkflowPresentation['phaseItems'] } {
  const skippedPlanning = planningSkipped(lifecycle);

  if (status === 'CANCELLED') {
    const sourcePhase = lifecycle.cancelledFromStatus
      ? statusToPhase(lifecycle.cancelledFromStatus)
      : null;
    if (!sourcePhase) {
      return {
        currentPhase: null,
        phaseItems: PHASE_ORDER.map((phase) => ({
          phase,
          label: phase === 'PLANNING' && skippedPlanning ? 'Planlama atlandı' : PHASE_LABELS[phase],
          state: phase === 'CREATED' ? 'complete' : 'upcoming',
        })),
      };
    }
    const frozen = phaseIndex(sourcePhase);
    return {
      currentPhase: sourcePhase,
      phaseItems: PHASE_ORDER.map((phase) => {
        const index = phaseIndex(phase);
        if (phase === 'PLANNING' && skippedPlanning && index < frozen) {
          return { phase, label: 'Planlama atlandı', state: 'skipped' as const };
        }
        if (index < frozen) {
          return { phase, label: PHASE_LABELS[phase], state: 'complete' as const };
        }
        if (index === frozen) {
          return { phase, label: PHASE_LABELS[phase], state: 'attention' as const };
        }
        return { phase, label: PHASE_LABELS[phase], state: 'upcoming' as const };
      }),
    };
  }

  const currentPhase = statusToPhase(status)!;
  const current = phaseIndex(currentPhase);
  const attentionOnCurrent = status === 'REVISION_REQUESTED';

  return {
    currentPhase,
    phaseItems: PHASE_ORDER.map((phase) => {
      const index = phaseIndex(phase);
      if (phase === 'PLANNING' && skippedPlanning && index < current) {
        return { phase, label: 'Planlama atlandı', state: 'skipped' as const };
      }
      if (index < current) {
        return { phase, label: PHASE_LABELS[phase], state: 'complete' as const };
      }
      if (index === current) {
        return {
          phase,
          label: PHASE_LABELS[phase],
          state: attentionOnCurrent ? 'attention' as const : 'current' as const,
        };
      }
      return { phase, label: PHASE_LABELS[phase], state: 'upcoming' as const };
    }),
  };
}

function responsibilityFor(
  status: JobCardStatus,
  role: ExpectedRole,
): JobWorkflowPresentation['responsibility'] {
  switch (status) {
    case 'NEW':
      return {
        role,
        title: 'Şimdi sizden beklenen',
        description: 'İşi planlayın veya doğrudan uygulamaya başlatın.',
        consequence: null,
      };
    case 'PLANNED':
      return {
        role,
        title: 'Şimdi sizden beklenen',
        description: 'Planlanan işi uygulamak için başlatın.',
        consequence: null,
      };
    case 'IN_PROGRESS':
      return {
        role,
        title: 'Şimdi sizden beklenen',
        description: 'Gerekli kayıtları tamamlayıp işi yönetici kontrolüne gönderin.',
        consequence: null,
      };
    case 'REVISION_REQUESTED':
      return {
        role,
        title: 'Düzeltme gerekiyor',
        description: 'Yönetici düzeltme istedi. Düzeltmeye başlayıp kayıtları güncelleyin.',
        consequence: null,
      };
    case 'WAITING_APPROVAL':
      return {
        role,
        title: 'Yönetici kontrolü',
        description: 'Yönetici kayıtları inceleyerek işi tamamlar veya düzeltme ister.',
        consequence: null,
      };
    case 'COMPLETED':
      return {
        role: null,
        title: 'Tamamlandı',
        description: 'İş yönetici kontrolünden geçerek tamamlandı.',
        consequence: null,
      };
    case 'CANCELLED':
      return {
        role: null,
        title: 'İptal edildi',
        description: 'İş iptal edildi ve yeniden açılamaz.',
        consequence: null,
      };
  }
}

function preferredPrimaryCommand(status: JobCardStatus): LifecycleCommand | null {
  switch (status) {
    case 'NEW':
    case 'PLANNED':
      return 'START';
    case 'IN_PROGRESS':
      return 'SUBMIT_FOR_APPROVAL';
    case 'REVISION_REQUESTED':
      return 'RESUME';
    case 'WAITING_APPROVAL':
      return 'APPROVE';
    default:
      return null;
  }
}

function viewerOwnsPrimary(
  status: JobCardStatus,
  user: CurrentUser,
  job: JobCard,
): boolean {
  const expected = expectedRoleForStatus(status);
  if (expected === 'STAFF') {
    return user.role === 'STAFF' && job.assignedTo === user.id;
  }
  if (expected === 'MANAGEMENT') {
    return isManagement(user);
  }
  return false;
}

function deriveRecordEditAction(
  job: JobCard,
  user: CurrentUser,
  workflowContext: JobWorkflowContext,
): RecordEditPresentation | null {
  const actions = workflowContext.allowedActions;
  if (actions.includes('WITHDRAW_AND_EDIT_JOB_FIELDS')) {
    const staffWording = user.role === 'STAFF';
    return {
      action: 'WITHDRAW_AND_EDIT_JOB_FIELDS',
      label: staffWording
        ? 'Kontrolden geri çek ve düzenle'
        : 'Kontrolden çıkar ve kayıtları düzenle',
      consequence: 'Kontrol sona erecek ve iş yeniden “Uygulanıyor” aşamasına alınacaktır. '
        + 'Değişiklikler işi onaylamaz veya tamamlamaz; işin tekrar kontrole gönderilmesi gerekir.',
      confirmation: {
        title: staffWording
          ? 'Kontrolden geri çek ve düzenle'
          : 'Kontrolden çıkar ve kayıtları düzenle',
        details: [
          'Yönetici kontrolünü sona erdirir',
          'İşi yeniden “Uygulanıyor” aşamasına alır',
          'İşi onaylamaz veya tamamlamaz',
          'Değişikliklerden sonra yeniden kontrole gönderim gerektirir',
        ],
        confirmLabel: staffWording
          ? 'Geri çek ve düzenle'
          : 'Kontrolden çıkar ve düzenle',
      },
    };
  }
  if (actions.includes('EDIT_JOB_FIELDS') && job.type === 'SALES_MEETING') {
    return {
      action: 'EDIT_JOB_FIELDS',
      label: 'Görüşmeyi düzenle',
      consequence: 'Görüşme bilgileri düzenlenecektir.',
    };
  }
  return null;
}

function deriveTransitions(
  job: JobCard,
  user: CurrentUser,
  workflowContext: JobWorkflowContext,
  revisionActive: boolean,
  hideWithdraw: boolean,
): {
  primaryTransition: TransitionPresentation | null;
  secondaryTransitions: TransitionPresentation[];
} {
  const opts = { revisionActive, user };
  const allowed = workflowContext.allowedCommands.filter((command) => {
    if (hideWithdraw && command === 'WITHDRAW_FROM_APPROVAL') return false;
    return true;
  });

  let primary: TransitionPresentation | null = null;
  if (viewerOwnsPrimary(job.status, user, job)) {
    const preferred = preferredPrimaryCommand(job.status);
    if (preferred && allowed.includes(preferred)) {
      primary = transitionPresentation(preferred, opts);
    }
  }

  const secondaryCommands = allowed.filter((command) => command !== primary?.command);
  const withoutCancel = secondaryCommands.filter((command) => command !== 'CANCEL');
  const ordered = allowed.includes('CANCEL') && secondaryCommands.includes('CANCEL')
    ? [...withoutCancel, 'CANCEL' as const]
    : withoutCancel;

  return {
    primaryTransition: primary,
    secondaryTransitions: ordered.map((command) => transitionPresentation(command, opts)),
  };
}

export function deriveJobWorkflowPresentation(
  input: DeriveJobWorkflowPresentationInput,
): JobWorkflowPresentation {
  const { job, user, workflowContext } = input;
  const { lifecycle } = workflowContext;
  const revisionActive = isRevisionActive(lifecycle);
  const { currentPhase, phaseItems } = derivePhaseItems(job.status, lifecycle);
  const expectedRole = expectedRoleForStatus(job.status);
  const recordEditAction = deriveRecordEditAction(job, user, workflowContext);
  const hideWithdraw = recordEditAction?.action === 'WITHDRAW_AND_EDIT_JOB_FIELDS';
  const { primaryTransition, secondaryTransitions } = deriveTransitions(
    job, user, workflowContext, revisionActive, hideWithdraw,
  );

  const requirements = (workflowContext.submissionReadiness?.items ?? []).map((item) => ({
    ...item,
    label: requirementLabels[item.code],
  }));

  let terminalState: JobWorkflowPresentation['terminalState'] = null;
  if (job.status === 'COMPLETED') terminalState = 'COMPLETED';
  if (job.status === 'CANCELLED') terminalState = 'CANCELLED';

  const responsibility = responsibilityFor(job.status, expectedRole);
  if (primaryTransition) {
    responsibility.consequence = primaryTransition.consequence;
  }

  return {
    currentPhase,
    phaseItems,
    revisionLoop: revisionActive
      ? {
        active: true,
        returnedFrom: 'REVIEW',
        returnedTo: 'EXECUTION',
        reason: lifecycle.revisionReason,
      }
      : null,
    responsibility,
    requirements,
    recordEditAction,
    primaryTransition,
    secondaryTransitions,
    terminalState,
  };
}

const COMPACT_ORDINAL: Record<JobCardStatus, CompactWorkflowSummary['ordinal']> = {
  NEW: 1,
  PLANNED: 2,
  IN_PROGRESS: 3,
  REVISION_REQUESTED: 3,
  WAITING_APPROVAL: 4,
  COMPLETED: 5,
  CANCELLED: null,
};

export function deriveCompactWorkflowSummary(input: {
  job: { status: JobCardStatus };
  user: CurrentUser;
}): CompactWorkflowSummary {
  const { status } = input.job;
  return {
    ordinal: COMPACT_ORDINAL[status],
    total: 5,
    label: jobStatusLabels[status],
    attention: status === 'REVISION_REQUESTED',
    expectedRole: expectedRoleForStatus(status),
  };
}
