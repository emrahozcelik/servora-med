/**
 * OVR-5 §3.9: revision correction deadline input. The server owns the 1 hour –
 * 14 day bound; this field only collects the value, shows the hint and the
 * server `fieldErrors.correctionDueAt` next to the control.
 */

import { useEffect } from 'react';

import { addMinutesLocal, isoInstantToLocalDateTime } from './scheduling';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';

export type RevisionCorrectionDraft = {
  /** Device-local `YYYY-MM-DDTHH:mm` for the datetime-local input. */
  value: string;
  fieldError: string | null;
};

/** Hint copy for the 1 hour – 14 day server bound. */
export const CORRECTION_DUE_HINT = 'En az 1 saat, en fazla 14 gün sonrası';

const CORRECTION_DUE_PRESETS = [
  { label: '+24 saat', minutes: 24 * 60 },
  { label: '+3 gün', minutes: 3 * 24 * 60 },
  { label: '+7 gün', minutes: 7 * 24 * 60 },
] as const;

export function RevisionCorrectionDueField({
  draft,
  disabled = false,
  onChange,
}: {
  draft: RevisionCorrectionDraft;
  disabled?: boolean;
  onChange: (next: RevisionCorrectionDraft) => void;
}) {
  const hintId = 'revision-correction-due-at-hint';
  const errorId = 'revision-correction-due-at-error';
  // OVR-5b visual review: a server field error moves focus to the picker
  // instead of leaving it on the dialog shell or the submit button.
  useEffect(() => {
    if (draft.fieldError) document.getElementById('revision-correction-due-at')?.focus();
  }, [draft.fieldError]);
  return (
    <div className="field-group">
      <WheelDateTimeField
        mode="datetime"
        id="revision-correction-due-at"
        name="correctionDueAt"
        value={draft.value}
        onChange={(value) => onChange({ value, fieldError: null })}
        required
        disabled={disabled}
        invalid={Boolean(draft.fieldError)}
        aria-describedby={draft.fieldError ? `${hintId} ${errorId}` : hintId}
        label="Düzeltme son tarihi"
      />
      <div className="schedule-quick-chips" role="group" aria-label="Hızlı düzeltme süresi seçenekleri">
        {CORRECTION_DUE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="schedule-quick-chip"
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              onChange({
                value: addMinutesLocal(
                  isoInstantToLocalDateTime(new Date().toISOString()),
                  preset.minutes,
                ),
                fieldError: null,
              });
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <span className="form-help" id={hintId}>{CORRECTION_DUE_HINT}</span>
      {draft.fieldError && (
        <span id={errorId} className="field-error" role="alert">{draft.fieldError}</span>
      )}
    </div>
  );
}
