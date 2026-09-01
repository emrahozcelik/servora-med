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
  overrideReason: string;
  inlineError: string | null;
  onChange: (next: Partial<FollowUpDraft>) => void;
  onOverrideReasonChange: (value: string) => void;
  onUseSuggestedAlternative: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
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

const TYPE_OPTIONS: JobCardType[] = ['SALES_MEETING', 'PRODUCT_DELIVERY', 'GENERAL_TASK'];

export function FollowUpProposalSection({
  mode,
  draft,
  origin,
  evaluation,
  assigneeName,
  assignees = [],
  allowTypeEdit,
  overrideReason,
  inlineError,
  onChange,
  onOverrideReasonChange,
  onUseSuggestedAlternative,
  initialFocusRef,
}: FollowUpProposalSectionProps): ReactNode {
  const scheduledLocal = draft?.scheduledAt
    ? isoInstantToLocalDateTime(draft.scheduledAt)
    : '';  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const frequencyExceeded = evaluation?.level === 'FREQUENCY_EXCEEDED';

  return (
    <section className="follow-up-proposal-card" aria-label="Takip işi planı">
      <div className="follow-up-proposal-heading">
        <h3>{mode === 'staff' ? 'Takip işi planı' : 'Takip işi'}</h3>
        <span className="follow-up-proposal-badge">{badgeLabel(origin, mode)}</span>
      </div>

      {draft === null ? (
        <p className="form-help">Takip için uygun bir tarih bulunamadı. Lütfen tarih ve saat seçin.</p>
      ) : (
        <>
          <p className="follow-up-proposal-summary">
            {draft.scheduledAt === '' ? (
              'Takip tarihi seçilmedi'
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
        </>
      )}

      {mode === 'staff' ? (
        <>
          <details className="task-optional-fields follow-up-edit">
            <summary
              ref={mode === 'staff' && initialFocusRef
                ? (node) => { initialFocusRef.current = node; }
                : undefined}
            >Tarih ve saati değiştir</summary>
            <div className="field-group">
              <label htmlFor="follow-up-proposal-scheduled-at">Takip tarihi ve saati</label>
              <input
                id="follow-up-proposal-scheduled-at"
                type="datetime-local"
                value={scheduledLocal}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  if (!value) return;
                  onChange({ scheduledAt: localDateTimeToIso(value) });
                }}
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
      ) : (
        <div className="follow-up-proposal-fields">
          <div className="field-group">
            <label htmlFor="follow-up-proposal-scheduled-at">Takip tarihi ve saati</label>
            <input
              ref={mode === 'manager' && initialFocusRef
                ? (node) => { initialFocusRef.current = node; }
                : undefined}
              id="follow-up-proposal-scheduled-at"
              type="datetime-local"
              value={scheduledLocal}
              onChange={(event) => {
                const value = event.target.value.trim();
                if (!value) return;
                onChange({ scheduledAt: localDateTimeToIso(value) });
              }}
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
              <label htmlFor="follow-up-proposal-type">Takip işi türü</label>
              <select
                id="follow-up-proposal-type"
                value={draft?.type ?? ''}
                onChange={(event) => onChange({ type: event.target.value as JobCardType })}
              >
                {TYPE_OPTIONS.map((type) => (
                  <option key={type} value={type}>{jobTypeLabels[type]}</option>
                ))}
              </select>
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
              <label htmlFor="follow-up-proposal-due-date">Son tarih (isteğe bağlı)</label>
              <input
                id="follow-up-proposal-due-date"
                type="date"
                value={draft?.dueDate ?? ''}
                onChange={(event) => onChange({ dueDate: event.target.value || null })}
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

          {evaluation?.conflicts && evaluation.conflicts.length > 0 && (
            <div className="follow-up-conflict-list" role="alert">
              <p className="field-error">Aynı müşteri için aynı tarihte başka bir plan bulunuyor:</p>
              <ul>
                {evaluation.conflicts.map((conflict) => (
                  <li key={conflict.jobCardId}>
                    <a href={conflict.jobPath}>{conflict.title}</a>
                    {' — '}{conflict.assignee.name}
                  </li>
                ))}
              </ul>
              {evaluation.suggestedAlternativeAt && (
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={onUseSuggestedAlternative}
                >
                  Önerilen alternatif zamanı kullan ({formatDateTime(evaluation.suggestedAlternativeAt)})
                </button>
              )}
            </div>
          )}

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

          {frequencyExceeded && (
            <div className="follow-up-frequency-warning" role="alert">
              <p className="follow-up-recent-visit-title">Sık ziyaret uyarısı</p>
              <p className="form-help">Bu ziyaret, müşteri için 14 günlük bir dönemde
                ziyaret sıklığı sınırını aşıyor. Yeni ziyareti yine de planlamak için nedeni belirtin.</p>
              <div className="field-group">
                <label htmlFor="follow-up-override-reason">Neden *</label>
                <textarea
                  id="follow-up-override-reason"
                  rows={2}
                  maxLength={2000}
                  value={overrideReason}
                  onChange={(event) => onOverrideReasonChange(event.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {inlineError && <p className="field-error" role="alert">{inlineError}</p>}
    </section>
  );
}
