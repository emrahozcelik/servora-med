import {
  formatProposedInterval,
  hasManagementRecoveryOffer,
} from './assignment-transfer-helpers';
import type { JobWorkflowPresentation } from './job-workflow-presentation';
import type {
  ChangeRequestReasonCode,
  JobCard,
  JobCardEngagementKind,
  JobCardPriority,
} from './jobs-api';

export const MANAGER_RECOVERY_DECISION_IDS = [
  'ACCEPT_PROPOSED_TIME',
  'RESCHEDULE',
  'REASSIGN_KEEP_TIME',
  'REASSIGN_AND_RESCHEDULE',
  'REOFFER',
  'CORRECT',
  'CANCEL',
  'REJECT_CHANGE_REQUEST',
  'ACKNOWLEDGED_ONLY',
] as const;

export type ManagerRecoveryDecisionId = (typeof MANAGER_RECOVERY_DECISION_IDS)[number];

export const MANAGER_RECOVERY_DECISION_LABELS: Record<ManagerRecoveryDecisionId, string> = {
  ACCEPT_PROPOSED_TIME: 'Önerilen zamanı onayla',
  RESCHEDULE: 'Farklı bir zaman belirle',
  REASSIGN_KEEP_TIME: 'Başka personele devret',
  REASSIGN_AND_RESCHEDULE: 'Personeli ve zamanı değiştir',
  REOFFER: 'Yeniden teklif gönder',
  CORRECT: 'İş bilgilerini düzelt',
  CANCEL: 'İptal et',
  REJECT_CHANGE_REQUEST: 'Talebi reddet',
  ACKNOWLEDGED_ONLY: 'Talebi kayda al ve kapat',
};

export type ManagerRecoveryDecisionOption = {
  id: ManagerRecoveryDecisionId;
  label: string;
  description: string;
  recommended: boolean;
  suggestedByStaff: boolean;
  destructive: boolean;
};

export type ManagerRecoveryPlan = {
  hasRecoveryOffer: boolean;
  hasOpenChangeRequest: boolean;
  isStartedCase: boolean;
  proposalStatus: 'NONE' | 'VALID' | 'EXPIRED';
  options: ManagerRecoveryDecisionOption[];
  recommendedId: ManagerRecoveryDecisionId | null;
  defaultSelectedId: ManagerRecoveryDecisionId | null;
  advisoryNote: string;
  unavailableNotes: string[];
};

export type CorrectDraftValues = {
  title: string;
  description: string;
  priority: JobCardPriority;
  engagementKind: JobCardEngagementKind;
  customerId: string;
};

export type CorrectClosureEligibility = {
  hasAnyEdit: boolean;
  titleChanged: boolean;
  descriptionChanged: boolean;
  priorityChanged: boolean;
  engagementChanged: boolean;
  customerChanged: boolean;
  qualifyingFields: string[];
  hasQualifyingChange: boolean;
  hasOpenChangeRequest: boolean;
  requestReasonCode: ChangeRequestReasonCode | null;
  canOptInClosure: boolean;
};

export function evaluateCorrectClosureEligibility(
  job: JobCard,
  draft: CorrectDraftValues,
): CorrectClosureEligibility {
  const isFollowUp = job.followUpContext !== null;
  const titleChanged = draft.title.trim() !== job.title;
  const normalizedDraftDesc = draft.description.trim() || null;
  const normalizedJobDesc = job.description?.trim() || null;
  const descriptionChanged = normalizedDraftDesc !== normalizedJobDesc;
  const priorityChanged = draft.priority !== job.priority;
  const engagementChanged =
    job.type === 'SALES_MEETING'
    && draft.engagementKind !== (job.engagementKind ?? 'SALES_MEETING');
  const rawCustomerChanged =
    job.type === 'SALES_MEETING'
    && !isFollowUp
    && draft.customerId !== (job.customerId ?? '');
  const customerChanged = rawCustomerChanged && draft.customerId.trim() !== '';

  const qualifyingFields: string[] = [];
  if (descriptionChanged) qualifyingFields.push('Açıklama');
  if (engagementChanged) qualifyingFields.push('Görüşme / ziyaret türü');
  if (customerChanged) qualifyingFields.push('Müşteri');

  const hasAnyEdit =
    titleChanged
    || descriptionChanged
    || priorityChanged
    || engagementChanged
    || rawCustomerChanged;

  const hasOpenChangeRequest =
    job.changeRequest != null
    && job.workflowContext.allowedActions.includes('RESOLVE_CHANGE_REQUEST');
  const requestReasonCode = hasOpenChangeRequest ? job.changeRequest!.reasonCode : null;

  return {
    hasAnyEdit,
    titleChanged,
    descriptionChanged,
    priorityChanged,
    engagementChanged,
    customerChanged,
    qualifyingFields,
    hasQualifyingChange: qualifyingFields.length > 0,
    hasOpenChangeRequest,
    requestReasonCode,
    canOptInClosure:
      hasOpenChangeRequest
      && requestReasonCode === 'OTHER'
      && qualifyingFields.length > 0,
  };
}

const STARTED_STATUSES = new Set<JobCard['status']>([
  'IN_PROGRESS',
  'WAITING_APPROVAL',
  'REVISION_REQUESTED',
]);

const REOFFERABLE_OFFER_STATES = new Set([
  'DECLINED',
  'RELEASED',
  'EXPIRED',
  'WITHDRAWN',
]);

const RESCHEDULE_FIRST_CHANGE_REASONS = new Set([
  'CUSTOMER_POSTPONED',
  'CUSTOMER_ABSENT',
  'VISIT_NOT_POSSIBLE',
]);

function decisionDescription(
  id: ManagerRecoveryDecisionId,
  job: JobCard,
  proposalStatus: 'NONE' | 'VALID' | 'EXPIRED',
): string {
  const offer = job.assignmentOffer;
  switch (id) {
    case 'ACCEPT_PROPOSED_TIME':
      if (proposalStatus === 'VALID' && offer?.proposedScheduledAt) {
        return `Personelin önerisi · ${formatProposedInterval(offer.proposedScheduledAt, offer.proposedScheduledEndsAt)}`;
      }
      return 'Personelin önerdiği aralığı doğrudan uygular ve işi kabul edilmiş sayar.';
    case 'RESCHEDULE':
      return job.type === 'GENERAL_TASK'
        ? 'Mevcut sorumlu korunur; planlanan zaman veya son tarih güncellenir.'
        : 'Mevcut sorumlu korunur; farklı bir tarih ve saat seçilir.';
    case 'REASSIGN_KEEP_TIME':
      return 'Mevcut planlanan aralık korunur; iş başka bir aktif personele devredilir.';
    case 'REASSIGN_AND_RESCHEDULE':
      return 'Tek işlemde hem sorumlu personel hem planlanan zaman güncellenir.';
    case 'REOFFER':
      return `Mevcut plan ve personel (${job.assignee.name}) ile yeni atama teklifi açar.`;
    case 'CORRECT':
      if (job.changeRequest?.reasonCode === 'OTHER') {
        return 'Yetkili iş bilgilerini günceller; nitelikli düzenlemede talebi onay ve not ile kapatabilirsiniz.';
      }
      if (job.changeRequest != null) {
        return 'Yetkili iş bilgilerini günceller; bu talep nedeni düzenlemeyle kapatılmaz ve talep açık kalır.';
      }
      return 'Yetkili iş bilgilerini günceller.';
    case 'CANCEL':
      return 'İşi kalıcı olarak iptal eder; onay penceresinde iptal nedeni istenir.';
    case 'REJECT_CHANGE_REQUEST':
      return 'Personelin talebini açıklama ile reddeder; iş kaydı değişmez.';
    case 'ACKNOWLEDGED_ONLY':
      return 'Talebi not ekleyerek kapatır; iş, plan, teklif ve gecikme durumu değişmez.';
  }
}

function uniqueOrder(order: readonly ManagerRecoveryDecisionId[]): ManagerRecoveryDecisionId[] {
  const seen = new Set<ManagerRecoveryDecisionId>();
  const result: ManagerRecoveryDecisionId[] = [];
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of MANAGER_RECOVERY_DECISION_IDS) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function buildManagerRecoveryPlan(input: {
  job: JobCard;
  presentation: JobWorkflowPresentation;
  nowMs?: number;
}): ManagerRecoveryPlan {
  const { job, presentation, nowMs = Date.now() } = input;
  const hasRecoveryOffer = hasManagementRecoveryOffer(job);
  const hasOpenChangeRequest = job.changeRequest != null
    && job.workflowContext.allowedActions.includes('RESOLVE_CHANGE_REQUEST');
  const isStartedCase = STARTED_STATUSES.has(job.status);
  const isPreStart = job.status === 'NEW' || job.status === 'ACCEPTED';
  const offer = job.assignmentOffer ?? null;

  let proposalStatus: 'NONE' | 'VALID' | 'EXPIRED' = 'NONE';
  if (hasRecoveryOffer && offer?.proposedScheduledAt != null && offer.proposalAcceptedAt === null) {
    proposalStatus = Date.parse(offer.proposedScheduledAt) > nowMs ? 'VALID' : 'EXPIRED';
  }

  const eligible: Record<ManagerRecoveryDecisionId, boolean> = {
    ACCEPT_PROPOSED_TIME: proposalStatus === 'VALID',
    RESCHEDULE: presentation.scheduleEdit !== null,
    REASSIGN_KEEP_TIME:
      presentation.recordEditAction?.action === 'EDIT_JOB_FIELDS'
      && job.type !== 'SALE'
      && !isStartedCase
      && isPreStart,
    REASSIGN_AND_RESCHEDULE:
      (job.type === 'SALES_MEETING' || job.type === 'PRODUCT_DELIVERY')
      && presentation.recordEditAction?.action === 'EDIT_JOB_FIELDS'
      && presentation.scheduleEdit !== null,
    REOFFER:
      job.status === 'NEW'
      && offer !== null
      && REOFFERABLE_OFFER_STATES.has(offer.state)
      && job.scheduledAt !== null,
    CORRECT:
      presentation.recordEditAction?.action === 'EDIT_JOB_FIELDS'
      && (job.type === 'SALES_MEETING' || job.type === 'GENERAL_TASK'),
    CANCEL: job.workflowContext.allowedCommands.includes('CANCEL'),
    REJECT_CHANGE_REQUEST: hasOpenChangeRequest,
    ACKNOWLEDGED_ONLY: hasOpenChangeRequest,
  };

  const unavailableNotes: string[] = [];
  if (proposalStatus === 'EXPIRED') {
    unavailableNotes.push(
      'Personelin önerdiği zaman geçmişte kaldığı için doğrudan onaylanamıyor; farklı bir zaman seçebilir veya başka bir karar verebilirsiniz.',
    );
  }
  if (isStartedCase) {
    unavailableNotes.push(
      'İş başlatıldığı için ön aşama devir, yeniden planlama veya yeniden atama teklifi uygulanamaz; yürütme kanıtları korunur.',
    );
    if (job.status === 'WAITING_APPROVAL' && job.type === 'SALES_MEETING') {
      unavailableNotes.push(
        'Yönetici kontrolündeki görüşme bilgilerini düzeltmek için önce İşlemler panelinden kontrolü sonlandırın.',
      );
    }
  }
  if (job.type === 'PRODUCT_DELIVERY' && presentation.recordEditAction?.action === 'EDIT_JOB_FIELDS') {
    unavailableNotes.push(
      'Ürün teslim kalemleri teslim bilgileri bölümünden düzenlenir; burada planlama, devir veya talep sonuçlandırma yapılır.',
    );
  }
  if (job.type === 'SALE') {
    unavailableNotes.push(
      'Satış kaydı düzeltmeleri satış düzeltme bölümünden yapılır.',
    );
  }

  const reassignRescheduleFirst = offer?.urgentReason === 'START_PASSED' || job.scheduledAt === null;

  let orderedIds: ManagerRecoveryDecisionId[];
  let cancelSuggestedByStaff = false;
  let forceNoDefault = false;

  if (hasRecoveryOffer && offer !== null) {
    const suggested = offer.suggestedSolution;
    if (suggested === 'CANCEL_REQUEST' || job.changeRequest?.reasonCode === 'CUSTOMER_CHANGED_MIND') {
      cancelSuggestedByStaff = true;
    }
    switch (suggested) {
      case 'RESCHEDULE_SELF':
        orderedIds = [
          'ACCEPT_PROPOSED_TIME',
          'RESCHEDULE',
          'REASSIGN_AND_RESCHEDULE',
          'REASSIGN_KEEP_TIME',
          'REOFFER',
          'CORRECT',
          'CANCEL',
          'ACKNOWLEDGED_ONLY',
          'REJECT_CHANGE_REQUEST',
        ];
        break;
      case 'REASSIGN':
        orderedIds = reassignRescheduleFirst
          ? [
              'REASSIGN_AND_RESCHEDULE',
              'REASSIGN_KEEP_TIME',
              'RESCHEDULE',
              'ACCEPT_PROPOSED_TIME',
              'REOFFER',
              'CORRECT',
              'CANCEL',
              'ACKNOWLEDGED_ONLY',
              'REJECT_CHANGE_REQUEST',
            ]
          : [
              'REASSIGN_KEEP_TIME',
              'REASSIGN_AND_RESCHEDULE',
              'RESCHEDULE',
              'ACCEPT_PROPOSED_TIME',
              'REOFFER',
              'CORRECT',
              'CANCEL',
              'ACKNOWLEDGED_ONLY',
              'REJECT_CHANGE_REQUEST',
            ];
        break;
      case 'CORRECT_DETAILS':
        orderedIds = [
          'CORRECT',
          'RESCHEDULE',
          'REASSIGN_KEEP_TIME',
          'REASSIGN_AND_RESCHEDULE',
          'REOFFER',
          'ACCEPT_PROPOSED_TIME',
          'CANCEL',
          'ACKNOWLEDGED_ONLY',
          'REJECT_CHANGE_REQUEST',
        ];
        break;
      case 'CANCEL_REQUEST':
        forceNoDefault = true;
        orderedIds = [
          'CANCEL',
          'ACCEPT_PROPOSED_TIME',
          'RESCHEDULE',
          'REASSIGN_KEEP_TIME',
          'REASSIGN_AND_RESCHEDULE',
          'REOFFER',
          'CORRECT',
          'ACKNOWLEDGED_ONLY',
          'REJECT_CHANGE_REQUEST',
        ];
        break;
      case 'MANAGEMENT_DECIDES':
      case null:
        if (proposalStatus === 'VALID') {
          orderedIds = [
            'ACCEPT_PROPOSED_TIME',
            'RESCHEDULE',
            'REASSIGN_AND_RESCHEDULE',
            'REASSIGN_KEEP_TIME',
            'REOFFER',
            'CORRECT',
            'CANCEL',
            'ACKNOWLEDGED_ONLY',
            'REJECT_CHANGE_REQUEST',
          ];
        } else if (
          offer.closeReason === 'SCHEDULE_CONFLICT'
          || offer.state === 'EXPIRED'
          || offer.closeReason === 'PLANNED_WINDOW_PASSED'
        ) {
          orderedIds = [
            'RESCHEDULE',
            'REASSIGN_AND_RESCHEDULE',
            'REASSIGN_KEEP_TIME',
            'REOFFER',
            'CORRECT',
            'ACCEPT_PROPOSED_TIME',
            'CANCEL',
            'ACKNOWLEDGED_ONLY',
            'REJECT_CHANGE_REQUEST',
          ];
        } else {
          orderedIds = reassignRescheduleFirst
            ? [
                'REASSIGN_AND_RESCHEDULE',
                'REASSIGN_KEEP_TIME',
                'RESCHEDULE',
                'REOFFER',
                'CORRECT',
                'ACCEPT_PROPOSED_TIME',
                'CANCEL',
                'ACKNOWLEDGED_ONLY',
                'REJECT_CHANGE_REQUEST',
              ]
            : [
                'REASSIGN_KEEP_TIME',
                'REASSIGN_AND_RESCHEDULE',
                'RESCHEDULE',
                'REOFFER',
                'CORRECT',
                'ACCEPT_PROPOSED_TIME',
                'CANCEL',
                'ACKNOWLEDGED_ONLY',
                'REJECT_CHANGE_REQUEST',
              ];
        }
        break;
    }
  } else if (hasOpenChangeRequest && job.changeRequest !== null) {
    const reasonCode = job.changeRequest.reasonCode;
    if (reasonCode === 'CUSTOMER_CHANGED_MIND') {
      cancelSuggestedByStaff = true;
      forceNoDefault = true;
      orderedIds = [
        'CANCEL',
        'RESCHEDULE',
        'REASSIGN_KEEP_TIME',
        'REASSIGN_AND_RESCHEDULE',
        'CORRECT',
        'ACKNOWLEDGED_ONLY',
        'REJECT_CHANGE_REQUEST',
      ];
    } else if (RESCHEDULE_FIRST_CHANGE_REASONS.has(reasonCode)) {
      orderedIds = [
        'RESCHEDULE',
        'REASSIGN_AND_RESCHEDULE',
        'REASSIGN_KEEP_TIME',
        'CORRECT',
        'ACKNOWLEDGED_ONLY',
        'REJECT_CHANGE_REQUEST',
        'CANCEL',
      ];
    } else if (reasonCode === 'WRONG_PRODUCT') {
      orderedIds = [
        'CORRECT',
        'REASSIGN_KEEP_TIME',
        'RESCHEDULE',
        'REASSIGN_AND_RESCHEDULE',
        'ACKNOWLEDGED_ONLY',
        'REJECT_CHANGE_REQUEST',
        'CANCEL',
      ];
    } else {
      orderedIds = [
        'REASSIGN_KEEP_TIME',
        'RESCHEDULE',
        'REASSIGN_AND_RESCHEDULE',
        'CORRECT',
        'ACKNOWLEDGED_ONLY',
        'REJECT_CHANGE_REQUEST',
        'CANCEL',
      ];
    }
  } else {
    orderedIds = [...MANAGER_RECOVERY_DECISION_IDS];
  }

  const eligibleOrdered = uniqueOrder(orderedIds).filter((id) => eligible[id]);
  const firstNonDestructive = eligibleOrdered.find((id) => id !== 'CANCEL') ?? null;
  const recommendedId = forceNoDefault ? null : firstNonDestructive;
  const defaultSelectedId = forceNoDefault ? null : recommendedId;

  const options: ManagerRecoveryDecisionOption[] = eligibleOrdered.map((id) => ({
    id,
    label: MANAGER_RECOVERY_DECISION_LABELS[id],
    description: decisionDescription(id, job, proposalStatus),
    recommended: recommendedId === id,
    suggestedByStaff:
      (id === 'ACCEPT_PROPOSED_TIME' && proposalStatus === 'VALID')
      || (id === 'CORRECT' && offer?.suggestedSolution === 'CORRECT_DETAILS')
      || (id === 'CANCEL' && cancelSuggestedByStaff),
    destructive: id === 'CANCEL',
  }));

  const advisoryNote =
    'Sıralama mevcut iş, teklif ve talep kayıtları ile tarayıcı saatine dayalı süre tahminine göre önerilir; '
    + 'personel uygunluğu ve ek randevu riskleri bilinmiyor kabul edilir. '
    + 'Kesin geçerlilik ve takvim çakışması kaydetme sırasında sunucu tarafından doğrulanır.';

  return {
    hasRecoveryOffer,
    hasOpenChangeRequest,
    isStartedCase,
    proposalStatus,
    options,
    recommendedId,
    defaultSelectedId,
    advisoryNote,
    unavailableNotes,
  };
}

export type ManagerRecoveryPreview = {
  summary: string;
  effects: string[];
  nonEffects: string[];
  offerOutcome: string | null;
  requestDisposition: string | null;
  tone: 'neutral' | 'info' | 'warning' | 'danger';
};

export function buildManagerRecoveryPreview(input: {
  job: JobCard;
  selectedDecisionId: ManagerRecoveryDecisionId | null;
  hasRecoveryOffer: boolean;
  hasOpenChangeRequest: boolean;
  selectedStaffName?: string | null;
  proposedTimeLabel?: string | null;
  scheduledTimeLabel?: string | null;
  resolveChangeRequest?: boolean;
  hasCorrectionChanges?: boolean;
  correctClosureEligibility?: Pick<
    CorrectClosureEligibility,
    'canOptInClosure' | 'hasQualifyingChange' | 'requestReasonCode'
  >;
  followUpCancelDecision?: 'RESCHEDULE' | 'END_CYCLE' | null;
}): ManagerRecoveryPreview {
  const {
    job,
    selectedDecisionId,
    hasRecoveryOffer,
    hasOpenChangeRequest,
    selectedStaffName,
    proposedTimeLabel,
    scheduledTimeLabel,
    resolveChangeRequest = false,
    hasCorrectionChanges = false,
    correctClosureEligibility,
    followUpCancelDecision = null,
  } = input;

  if (selectedDecisionId === null) {
    return {
      summary: 'Devam etmek için yukarıdan bir karar seçin.',
      effects: [],
      nonEffects: ['Henüz hiçbir kayıt değiştirilmedi.'],
      offerOutcome: null,
      requestDisposition: null,
      tone: 'neutral',
    };
  }

  const coexistingRequestNote = hasOpenChangeRequest
    ? 'Açık personel değişiklik talebi bu işlemle kapatılmaz; ayrıca karara bağlanmalıdır.'
    : null;
  const coexistingOfferNote = hasRecoveryOffer
    ? 'Mevcut atama teklifi durumu, iş bilgileri ve planlanan zaman değişmez.'
    : null;

  switch (selectedDecisionId) {
    case 'ACCEPT_PROPOSED_TIME':
      return {
        summary: `İş önerilen zamana${proposedTimeLabel ? ` (${proposedTimeLabel})` : ''} taşınacak ve ${job.assignee.name} için kabul edilmiş olacak.`,
        effects: [
          `Planlanan zaman ${proposedTimeLabel ?? 'personelin önerdiği aralık'} olarak güncellenir.`,
          `İş ${job.assignee.name} için “Kabul edildi” aşamasına geçer.`,
        ],
        nonEffects: [
          'İkinci bir atama teklifi açılmaz.',
          ...(coexistingRequestNote ? [coexistingRequestNote] : []),
        ],
        offerOutcome: 'Önerilen zaman onaylanır ve atama kabul edilmiş sayılır.',
        requestDisposition: coexistingRequestNote,
        tone: 'info',
      };

    case 'RESCHEDULE':
      return {
        summary: scheduledTimeLabel
          ? `Planlanan zaman ${scheduledTimeLabel} olarak güncellenecek.`
          : 'Planlanan zaman seçtiğiniz tarihe göre güncellenecek.',
        effects: [
          job.type === 'GENERAL_TASK'
            ? 'Görevin planlanan zamanı ve/veya son tarihi güncellenir.'
            : 'İşin planlanan zaman aralığı (mevcut süre korunarak) güncellenir.',
          ...(job.status === 'ACCEPTED'
            ? ['Yönetici plan değişikliği nedeniyle iş yeniden “Atandı” aşamasına döner.']
            : []),
        ],
        nonEffects: [
          `Sorumlu personel (${job.assignee.name}) değişmez.`,
          ...(hasOpenChangeRequest && !resolveChangeRequest
            ? ['Açık personel talebi işaretlenmezse açık kalır.']
            : []),
        ],
        offerOutcome:
          job.status === 'NEW' || job.status === 'ACCEPTED'
            ? `${job.assignee.name} için yeni atama teklifi açılabilir; personelin yanıtı beklenir.`
            : null,
        requestDisposition: hasOpenChangeRequest
          ? resolveChangeRequest
            ? 'Açık personel talebi aynı işlemde “Yeniden planlandı” olarak kapatılacak.'
            : 'Açık personel talebi açık kalacak.'
          : null,
        tone: 'info',
      };

    case 'REASSIGN_KEEP_TIME':
      return {
        summary: selectedStaffName
          ? `İş mevcut planlanan zamanı korunarak ${selectedStaffName} kişisine devredilecek.`
          : 'İş mevcut planlanan zamanı korunarak seçilen aktif personele devredilecek.',
        effects: [
          `Sorumlu personel ${selectedStaffName ?? 'seçilen personel'} olarak güncellenir.`,
          ...(job.status === 'ACCEPTED' ? ['İş yeniden “Atandı” aşamasına döner.'] : []),
        ],
        nonEffects: [
          'Planlanan zaman aralığı ve süresi değişmez.',
          ...(coexistingRequestNote ? [coexistingRequestNote] : []),
        ],
        offerOutcome: `${selectedStaffName ?? 'Yeni personel'} için atama teklifi açılabilir; personelin yanıtı beklenir.`,
        requestDisposition: coexistingRequestNote,
        tone: 'info',
      };

    case 'REASSIGN_AND_RESCHEDULE':
      return {
        summary:
          `${selectedStaffName ?? 'Seçilen personel'} ve ${scheduledTimeLabel ?? 'yeni planlanan zaman'} tek işlemde güncellenecek.`,
        effects: [
          `Sorumlu personel ${selectedStaffName ?? 'seçilen personel'} olarak güncellenir.`,
          `Planlanan zaman ${scheduledTimeLabel ?? 'yeni aralık'} olarak güncellenir (süre korunur).`,
        ],
        nonEffects: [
          'Takvim çakışması veya geçersiz zaman durumunda hiçbir değişiklik kaydedilmez.',
          ...(hasOpenChangeRequest && !resolveChangeRequest
            ? ['Açık personel talebi işaretlenmezse açık kalır.']
            : []),
        ],
        offerOutcome: `${selectedStaffName ?? 'Yeni personel'} için yeni atama teklifi açılabilir; personelin yanıtı beklenir.`,
        requestDisposition: hasOpenChangeRequest
          ? resolveChangeRequest
            ? 'Açık personel talebi aynı işlemde “Yeniden planlandı” olarak kapatılacak.'
            : 'Açık personel talebi açık kalacak.'
          : null,
        tone: 'info',
      };

    case 'REOFFER':
      return {
        summary: `${job.assignee.name} kişisine mevcut zamanla yeniden atama teklifi gönderilecek.`,
        effects: [`${job.assignee.name} için yanıt bekleyen yeni bir atama teklifi açılır.`],
        nonEffects: [
          'İşin planlanan zamanı, sorumlu personeli ve diğer alanları değişmez.',
          'İş otomatik olarak kabul edilmiş sayılmaz; personelin yanıtı beklenir.',
          ...(coexistingRequestNote ? [coexistingRequestNote] : []),
        ],
        offerOutcome: 'Yeni teklif “Yanıt bekliyor” durumunda açılır.',
        requestDisposition: coexistingRequestNote,
        tone: 'info',
      };

    case 'CORRECT': {
      const reasonCode =
        correctClosureEligibility?.requestReasonCode ?? (hasOpenChangeRequest ? job.changeRequest?.reasonCode ?? null : null);
      const canCloseOther =
        correctClosureEligibility?.canOptInClosure
        ?? (hasOpenChangeRequest && reasonCode === 'OTHER' && hasCorrectionChanges);
      const hasQualifyingChange = correctClosureEligibility?.hasQualifyingChange ?? hasCorrectionChanges;
      const willCloseAsCorrected = hasOpenChangeRequest && canCloseOther && resolveChangeRequest;

      return {
        summary: !hasCorrectionChanges
          ? 'Kaydetmek için en az bir iş bilgisini güncelleyin.'
          : willCloseAsCorrected
            ? 'Düzenlenen iş bilgileri kaydedilecek ve açık “Diğer” talebi notunuzla “Düzeltildi” olarak kapatılacak.'
            : 'Düzenlenen iş bilgileri kaydedilecek.',
        effects: [
          'Yalnızca değiştirdiğiniz yetkili iş bilgileri güncellenir.',
          ...(willCloseAsCorrected
            ? ['Bir sonraki adımda girilecek açıklama notuyla açık personel talebi “Düzeltildi” olarak kapatılır.']
            : []),
        ],
        nonEffects: [
          'Planlanan zaman, sorumlu personel ve atama teklifi değişmez.',
          ...(hasOpenChangeRequest && !willCloseAsCorrected
            ? ['Açık personel talebi kapatılmaz.']
            : []),
        ],
        offerOutcome: null,
        requestDisposition: hasOpenChangeRequest
          ? willCloseAsCorrected
            ? 'Onay notu adımından sonra açık personel talebi aynı işlemde “Düzeltildi” olarak kapatılacak.'
            : reasonCode !== 'OTHER'
              ? 'Bu talep nedeni düzenlemeyle kapatılmaz; talep açık kalacak.'
              : !hasQualifyingChange
                ? '“Diğer” talebini kapatmak için açıklama, görüşme türü veya izinli müşteri değişmelidir; talep açık kalacak.'
                : 'Açık personel talebi açık kalacak.'
          : null,
        tone: 'info',
      };
    }

    case 'CANCEL':
      return {
        summary:
          followUpCancelDecision === 'RESCHEDULE'
            ? 'Onay adımında iptal nedeni ve yeni takip ziyareti zamanı alınarak iş iptal edilecek.'
            : 'Onay adımında iptal nedeni girildikten sonra iş kalıcı olarak iptal edilecek.',
        effects: [
          'İş “İptal edildi” durumuna geçer ve yeniden açılamaz.',
          'İş geçmişine iptal kaydı ve nedeni eklenir.',
        ],
        nonEffects: [
          'Devam eden onay penceresini onaylamadan iş iptal edilmez.',
        ],
        offerOutcome: hasRecoveryOffer ? 'İptal ile açık/kapalı atama döngüsü sona erer.' : null,
        requestDisposition: hasOpenChangeRequest
          ? 'İptal komutu açık talebi iptal kapsamında kapatır.'
          : null,
        tone: 'danger',
      };

    case 'REJECT_CHANGE_REQUEST':
      return {
        summary: 'Personelin değişiklik talebi yazdığınız açıklama ile reddedilecek.',
        effects: [
          'Açık personel talebi “Reddedildi” olarak kapatılır ve personele bildirim gider.',
        ],
        nonEffects: [
          'İş durumu, iş bilgileri, planlanan zaman ve atama teklifi değişmez.',
          'Mevcut gecikme ve teslim son tarihi kaydı korunur.',
          ...(coexistingOfferNote ? [coexistingOfferNote] : []),
        ],
        offerOutcome: null,
        requestDisposition: 'Talep “Reddedildi” olarak kapatılacak.',
        tone: 'warning',
      };

    case 'ACKNOWLEDGED_ONLY':
      return {
        summary: 'Personel talebi kayda alınarak kapatılacak; iş kaydı üzerinde hiçbir değişiklik yapılmaz.',
        effects: [
          'Açık personel talebi “Kayda alındı ve kapatıldı” olarak kapatılır.',
          'Yazdığınız yönetici notu kaydedilir ve personele bildirim gider.',
        ],
        nonEffects: [
          'İş durumu, iş bilgileri, planlanan zaman ve sorumlu personel değişmez.',
          'Teslim son tarihi, atama teklifi ve mevcut gecikme sorumluluğu korunur.',
        ],
        offerOutcome: null,
        requestDisposition: 'Talep nötr “Kayda alındı ve kapatıldı” olarak kapatılacak.',
        tone: 'info',
      };
  }
}
