import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';

import { ApiError } from '../services/api';
import { ResponsiveFormDrawer } from '../ui/antd/ResponsiveFormDrawer';
import {
  PAST_START_ACKNOWLEDGEMENT_CODES,
  type PastStartAcknowledgement,
  type PastStartAcknowledgementCode,
} from './jobs-api';
import { pastStartAcknowledgementLabels } from './job-labels';

export const PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH = 2000;

/** The server asks for an explicit acknowledgement only when it needs one. */
export function isPastStartAcknowledgementRequired(caught: unknown): boolean {
  return caught instanceof ApiError && caught.code === 'PAST_START_ACKNOWLEDGEMENT_REQUIRED';
}

/**
 * JOB-010 release 2b: a direct management producer (create, reassign,
 * reschedule, re-offer) is rejected with 409 when the planned start already
 * passed. The server cannot accept the action without an explicit customer
 * acknowledgement, so the same form value is retried with this field.
 */
export function PastStartAcknowledgementDrawer({
  open,
  title = 'Başlangıç saati geçti',
  description,
  pending = false,
  error = '',
  onDismiss,
  onConfirm,
  returnFocusRef,
}: {
  open: boolean;
  title?: string;
  description: ReactNode;
  pending?: boolean;
  error?: string;
  onDismiss: () => void;
  onConfirm: (acknowledgement: PastStartAcknowledgement) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [code, setCode] = useState<PastStartAcknowledgementCode | ''>('');
  const [text, setText] = useState('');
  const [formError, setFormError] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef<HTMLSelectElement>(null);

  // A reopened dialog always starts from an empty answer: a previous attempt's
  // acknowledgement belongs to a different request.
  useEffect(() => {
    if (!open) return;
    setCode('');
    setText('');
    setFormError('');
  }, [open]);

  function dismiss() {
    if (pending) return;
    onDismiss();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const selected = PAST_START_ACKNOWLEDGEMENT_CODES.find((entry) => entry === code);
    if (selected === undefined) {
      setFormError('Başlangıcın neden geçtiğini açıklayan bir neden seçin.');
      codeRef.current?.focus();
      return;
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
      setFormError('Onayı açıklayan metin zorunludur.');
      textRef.current?.focus();
      return;
    }
    if (Array.from(normalized).length > PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH) {
      setFormError(
        `Açıklama ${PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`,
      );
      return;
    }
    setFormError('');
    onConfirm({ code: selected, text: normalized });
  }

  return (
    <ResponsiveFormDrawer
      open={open}
      title={title}
      onDismiss={dismiss}
      returnFocusRef={returnFocusRef}
      dismissDisabled={pending}
    >
      <form
        className="past-start-acknowledgement-form"
        data-past-start-acknowledgement="true"
        onSubmit={submit}
        noValidate
      >
        <p className="form-help">{description}</p>
        <div className="field-group">
          <label htmlFor="past-start-ack-code">Neden</label>
          <select
            ref={codeRef}
            id="past-start-ack-code"
            value={code}
            disabled={pending}
            required
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? 'past-start-ack-error' : undefined}
            onChange={(event) => {
              setCode(event.target.value as PastStartAcknowledgementCode | '');
              setFormError('');
            }}
          >
            <option value="">Neden seçin</option>
            {PAST_START_ACKNOWLEDGEMENT_CODES.map((entry) => (
              <option key={entry} value={entry}>{pastStartAcknowledgementLabels[entry]}</option>
            ))}
          </select>
        </div>
        <div className="field-group">
          <label htmlFor="past-start-ack-text">Açıklama</label>
          <textarea
            ref={textRef}
            id="past-start-ack-text"
            rows={4}
            value={text}
            disabled={pending}
            required
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError
              ? 'past-start-ack-help past-start-ack-error'
              : 'past-start-ack-help'}
            onChange={(event) => {
              setText(event.target.value);
              setFormError('');
            }}
          />
          <span className="form-help" id="past-start-ack-help">
            Müşterinin güncel durumunu kısaca yazın. Kayıt iş geçmişinde saklanır. En fazla
            {' '}{PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakter.
          </span>
        </div>
        {formError && <p className="field-error" id="past-start-ack-error" role="alert">{formError}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="review-buttons">
          <button className="secondary-button" type="button" disabled={pending} onClick={dismiss}>
            Vazgeç
          </button>
          <button
            className="primary-button compact-button"
            type="submit"
            disabled={pending}
          >
            {pending ? 'Kaydediliyor…' : 'Onayla ve devam et'}
          </button>
        </div>
      </form>
    </ResponsiveFormDrawer>
  );
}
