import { useEffect, useRef, useState } from 'react';

import {
  previewCustomerSchedule,
  type CustomerScheduleEvaluation,
  type JobCardType,
} from './jobs-api';
import { localDateTimeToIso } from './scheduling';

export type CustomerSchedulePreviewInputs = {
  type: JobCardType;
  customerId: string | null;
  scheduledLocal: string;
  jobCardId?: string | null;
  enabled: boolean;
};

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Advisory Customer Scheduling preview. Debounced; stale responses are
 * discarded. The preview is never authoritative — the server re-evaluates
 * under the Customer lock on the actual create/edit write.
 */
export function useCustomerSchedulePreview(inputs: CustomerSchedulePreviewInputs): {
  evaluation: CustomerScheduleEvaluation | null;
  previewing: boolean;
} {
  const [evaluation, setEvaluation] = useState<CustomerScheduleEvaluation | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const requestSeq = useRef(0);

  const {
    type, customerId, scheduledLocal, jobCardId, enabled,
  } = inputs;

  useEffect(() => {
    if (!enabled) {
      setEvaluation(null);
      setPreviewing(false);
      return;
    }
    if (type !== 'SALES_MEETING' && type !== 'PRODUCT_DELIVERY') {
      setEvaluation(null);
      return;
    }
    if (!customerId || !scheduledLocal) {
      setEvaluation(null);
      setPreviewing(false);
      return;
    }
    const seq = ++requestSeq.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      try {
        previewCustomerSchedule({
          type,
          customerId,
          scheduledAt: localDateTimeToIso(scheduledLocal),
          jobCardId: jobCardId ?? null,
        })
          .then((next) => {
            if (requestSeq.current !== seq) return;
            setEvaluation(next);
            setPreviewing(false);
          })
          .catch(() => {
            if (requestSeq.current !== seq) return;
            // Advisory preview failure must not block the form; keep a null
            // evaluation and let the authoritative submit surface any error.
            setEvaluation(null);
            setPreviewing(false);
          });
      } catch {
        // Defensive: a missing/mocked API function must never break the form.
        setEvaluation(null);
        setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, type, customerId, scheduledLocal, jobCardId]);

  return { evaluation, previewing };
}
