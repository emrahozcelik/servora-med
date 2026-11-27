import type { ReactNode, RefObject } from 'react';

import {
  isoInstantToLocalDateTime,
  localDateTimeToIso,
} from './scheduling';
import { jobTypeLabels } from './job-labels';
import {
  JOB_CARD_PRIORITIES,
  type CustomerScheduleEvaluation,
  type FollowUpProposalOrigin,
  type JobCardPriority,
  type JobCardType,
  type RelatedName,
} from './jobs-api';
import { priorityChipLabels } from '../ui/PriorityChip';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';

export type FollowUpDraft = {
  scheduledAt: string;
  type: JobCardType;
  assignedTo: string;
  followUpInstructions: string;
  priority?: JobCardPriority;
  dueDate?: string | null;
};

export type FollowUpProposalSectionProps = {
  mode: 'staff' | 'manager';
  draft: FollowUpDraft | null;
  origin: FollowUpProposalOrigin | null;
  evaluation: CustomerScheduleEvaluation | null;
  assigneeName: string;
  assignees?: RelatedName[];
  allowTypeEdit: boolean;
  /**
   * A mandatory customer-visit follow-up must continue the visit cycle as a
   * SALES_MEETING. Optional approval-time follow-ups may be a SALES_MEETING or
   * a GENERAL_TASK; PRODUCT_DELIVERY needs products and is opened from the
   * dedicated follow-up creation screen, never from an approval.
   */
  mandatoryVisitFollowUp?: boolean;
  inlineError: string | null;
  onChange: (next: Partial<FollowUpDraft>) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Staff automatic scheduling presentation for backend-supported AUTO types.
   * Hides the manual datetime editor; the server selects the slot.
   */
  autoSupported?: boolean;
  /**
   * Explicit datetime fallback for the no-slot case. When true in Staff AUTO
   * mode, the manual datetime control is shown so the user is never stuck
   * with a dead-end message.
   */
  allowExplicitSchedule?: boolean;
  /**
   * Suggestion load failure message. Rendered with a retry action instead of
   * any scheduling controls; a failed load must never masquerade as no-slot.
   */
  loadError?: string | null;
  onRetrySuggestion?: () => void;
  /**
   * Forces the Staff instructions disclosure open so a required-instructions
   * validation error is discoverable instead of hidden in collapsed details.
   */
  expandInstructions?: boolean;
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long',
  }).format(new Date(value));
}

function badgeLabel(origin: FollowUpProposalOrigin | null, mode: 'staff' | 'manager'): string {
  if (mode === 'staff') return 'ÖNERİLEN';
  return origin === 'STAFF_ADJUSTED' ? 'PERSONEL ÖNERİSİ' : 'ÖNERİLEN';
}

export function FollowUpProposalSection({
  mode,
  draft,
  origin,
  evaluation,
  assigneeName,
  assignees = [],
  allowTypeEdit,
  mandatoryVisitFollowUp = false,
  inlineError,
  onChange,
  initialFocusRef,
  autoSupported = false,
  allowExplicitSchedule = false,
  loadError = null,
  onRetrySuggestion,
  expandInstructions = false,
}: FollowUpProposalSectionProps): ReactNode {
  const scheduledLocal = draft?.scheduledAt
    ? isoInstantToLocalDateTime(draft.scheduledAt)
    : '';  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const staffAuto = mode === 'staff' && autoSupported;
  const typeOptions: JobCardType[] = mandatoryVisitFollowUp
    ? ['SALES_MEETING']
    : ['SALES_MEETING', 'GENERAL_TASK'];

  return (
    <section className="follow-up-proposal-card" aria-label="Takip işi planı">
      <div className="follow-up-proposal-heading">
        <h3>{mode === 'staff' ? 'Takip işi planı' : 'Takip işi'}</h3>
        <span className="follow-up-proposal-badge">{badgeLabel(origin, mode)}</span>
      </div>

      {draft === null ? (
        loadError ? (
          <>
            <p className="field-error" role="alert">{loadError}</p>
            {onRetrySuggestion && (
              <button className="secondary-button compact-button" type="button" onClick={onRetrySuggestion}>
                Tekrar dene
              </button>
            )}
          </>
        ) : (
          <p className="form-help">Takip için uygun bir tarih bulunamadı. Lütfen tarih ve saat seçin.</p>
        )
      ) : (
        <>
          <p className="follow-up-proposal-summary">
            {draft.scheduledAt === '' ? (
              staffAuto ? (
                <>
                  {jobTypeLabels[draft.type]}
                  {' · '}{assigneeName}
                </>
              ) : (
                'Takip tarihi seçilmedi'
              )
            ) : (
              <>
                <time dateTime={draft.scheduledAt}>{formatDateTime(draft.scheduledAt)}</time>
                {' · '}{jobTypeLabels[draft.type]}
                {' · '}{mode === 'staff' ? assigneeName
                  : (assignees.find((entry) => entry.id === draft.assignedTo)?.name ?? assigneeName)}
              </>
            )}
          </p>
          {evaluation?.safeMessage && (
            <p className="form-help follow-up-proposal-notice">{evaluation.safeMessage}</p>
          )}
          {staffAuto && draft.scheduledAt === '' && !allowExplicitSchedule && (
            <p className="form-help follow-up-proposal-notice">Uygun takip zamanı sistem tarafından seçilecek. Tarih ve saat seçmeniz gerekmez.</p>
          )}
          {staffAuto && draft.scheduledAt === '' && allowExplicitSchedule && (
            <p className="form-help follow-up-proposal-notice">Uygun otomatik zaman bulunamadı. Devam etmek için tarih ve saat belirleyin.</p>
          )}
        </>
      )}

      {staffAuto ? (
        <>
          {allowExplicitSchedule && draft !== null && (
            <div className="field-group follow-up-explicit-schedule">
              <WheelDateTimeField
                mode="datetime"
                id="follow-up-proposal-scheduled-at"
                value={scheduledLocal}
                controlRef={initialFocusRef}
                onChange={(value) => {
                  const trimmed = value.trim();
                  if (!trimmed) return;
                  onChange({ scheduledAt: localDateTimeToIso(trimmed) });
                }}
                label="Takip tarihi ve saati"
              />
              <p className="form-help">Saat dilimi: {timeZone}</p>
            </div>
          )}
          <details className="task-optional-fields follow-up-edit" open={expandInstructions || undefined}>
            <summary
              ref={!allowExplicitSchedule && initialFocusRef
                ? (node) => { initialFocusRef.current = node; }
                : undefined}
            >Takip kapsamını düzenle</summary>
            <div className="field-group">
              <label htmlFor="follow-up-proposal-instructions">Takip kapsamı / talimatlar</label>
              <textarea
                id="follow-up-proposal-instructions"
                rows={2}
                maxLength={4000}
                value={draft?.followUpInstructions ?? ''}
                onChange={(event) => onChange({ followUpInstructions: event.target.value })}
              />
            </div>
          </details>
        </>
      ) : mode === 'staff' ? (
        draft === null && loadError ? null : (
        <>
          <details className="task-optional-fields follow-up-edit">
            <summary
              ref={mode === 'staff' && initialFocusRef
                ? (node) => { initialFocusRef.current = node; }
                : undefined}
            >Tarih ve saati değiştir</summary>
            <div className="field-group">
              <WheelDateTimeField
                mode="datetime"
                id="follow-up-proposal-scheduled-at"
                value={scheduledLocal}
                onChange={(value) => {
                  const trimmed = value.trim();
                  if (!trimmed) return;
                  onChange({ scheduledAt: localDateTimeToIso(trimmed) });
                }}
                label="Takip tarihi ve saati"
              />
              <p className="form-help">Saat dilimi: {timeZone}</p>
            </div>
          </details>
          <details className="task-optional-fields follow-up-edit">
            <summary>Takip kapsamını düzenle</summary>
            <div className="field-group">
              <label htmlFor="follow-up-proposal-instructions">Takip kapsamı / talimatlar</label>
              <textarea
                id="follow-up-proposal-instructions"
                rows={2}
                maxLength={4000}
                value={draft?.followUpInstructions ?? ''}
                onChange={(event) => onChange({ followUpInstructions: event.target.value })}
              />
            </div>
          </details>
        </>
        )
      ) : (
        <div className="follow-up-proposal-fields">
          <div className="field-group">
            <WheelDateTimeField
              mode="datetime"
              id="follow-up-proposal-scheduled-at"
              value={scheduledLocal}
              controlRef={mode === 'manager' ? initialFocusRef : undefined}
              onChange={(value) => {
                const trimmed = value.trim();
                if (!trimmed) return;
                onChange({ scheduledAt: localDateTimeToIso(trimmed) });
              }}
              label="Takip tarihi ve saati"
            />
            <p className="form-help">Saat dilimi: {timeZone}</p>
          </div>
          {assignees.length > 0 && (
            <div className="field-group">
              <label htmlFor="follow-up-proposal-assignee">Sorumlu personel</label>
              <select
                id="follow-up-proposal-assignee"
                value={draft?.assignedTo ?? ''}
                onChange={(event) => onChange({ assignedTo: event.target.value })}
              >
                {assignees.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </select>
            </div>
          )}
          {allowTypeEdit && (
            <div className="field-group">
              {typeOptions.length === 1 ? (
                <>
                  <span className="field-label" id="follow-up-proposal-type-label">Takip işi türü</span>
                  <p className="follow-up-proposal-type-fixed" aria-labelledby="follow-up-proposal-type-label">
                    {jobTypeLabels[typeOptions[0]!]}
                  </p>
                  <p className="form-help">Müşteri ziyaretinin takibi satış görüşmesi olarak devam eder.</p>
                </>
              ) : (
                <>
                  <label htmlFor="follow-up-proposal-type">Takip işi türü</label>
                  <select
                    id="follow-up-proposal-type"
                    value={draft?.type ?? ''}
                    onChange={(event) => onChange({ type: event.target.value as JobCardType })}
                  >
                    {typeOptions.map((type) => (
                      <option key={type} value={type}>{jobTypeLabels[type]}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          <div className="field-group">
            <label htmlFor="follow-up-proposal-priority">Öncelik</label>
            <select
              id="follow-up-proposal-priority"
              value={draft?.priority ?? 'normal'}
              onChange={(event) => onChange({ priority: event.target.value as JobCardPriority })}
            >
              {JOB_CARD_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>{priorityChipLabels[priority]}</option>
              ))}
            </select>
          </div>
          {draft?.type !== 'SALES_MEETING' && (
            <div className="field-group">
              <WheelDateTimeField
                mode="date"
                id="follow-up-proposal-due-date"
                value={draft?.dueDate ?? ''}
                onChange={(value) => onChange({ dueDate: value || null })}
                label="Son tarih (isteğe bağlı)"
              />
            </div>
          )}
          <div className="field-group">
            <label htmlFor="follow-up-proposal-instructions">Takip kapsamı / talimatlar</label>
            <textarea
              id="follow-up-proposal-instructions"
              rows={3}
              maxLength={4000}
              value={draft?.followUpInstructions ?? ''}
              onChange={(event) => onChange({ followUpInstructions: event.target.value })}
            />
          </div>

          {evaluation?.recentVisit && (
            <div className="follow-up-recent-visit" role="status">
              <p className="follow-up-recent-visit-title">Yakın tarihli müşteri ziyareti</p>
              <p>
                <strong>{formatDay(evaluation.recentVisit.occurredAt)} — {jobTypeLabels[evaluation.recentVisit.jobType]}</strong>
                <br />
                {evaluation.recentVisit.staffName}
                {evaluation.recentVisit.resultSummary && (
                  <>
                    <br />
                    <span className="form-help">
                      {Array.from(evaluation.recentVisit.resultSummary).slice(0, 200).join('')}
                    </span>
                  </>
                )}
              </p>
            </div>
          )}

          {evaluation?.safeMessage && evaluation.level === 'WARNING' && (
            <div className="follow-up-frequency-warning" role="status">
              <p className="follow-up-frequency-warning-label">Uyarı</p>
              <p className="form-help">{evaluation.safeMessage}</p>
            </div>
          )}
        </div>
      )}

      {inlineError && <p className="field-error" role="alert">{inlineError}</p>}
    </section>
  );
}
