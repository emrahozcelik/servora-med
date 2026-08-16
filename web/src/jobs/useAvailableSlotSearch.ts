import { useEffect, useRef, useState } from 'react';

import {
  findAvailableSlots,
  type AvailableSlot,
  type AvailableSlotsInput,
} from './jobs-api';
import { localDateTimeToIso } from './scheduling';

export type AvailableSlotSearchInputs = {
  type: AvailableSlotsInput['type'];
  customerId: string | null;
  assignedTo: string | null;
  scheduledStartLocal: string;
  scheduledEndLocal: string;
  jobCardId?: string | null;
  enabled: boolean;
};

export type AvailableSlotSearchResult = {
  slots: AvailableSlot[];
  searching: boolean;
  searched: boolean;
  error: Error | null;
  featureDisabled: boolean;
};

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Advisory joint Customer + Staff slot search. It is deliberately separate
 * from create/patch authority: stale responses are discarded and failures do
 * not block the authoritative submit path.
 */
export function useAvailableSlotSearch(
  inputs: AvailableSlotSearchInputs,
): AvailableSlotSearchResult {
  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const requestSeq = useRef(0);
  const {
    type,
    customerId,
    assignedTo,
    scheduledStartLocal,
    scheduledEndLocal,
    jobCardId,
    enabled,
  } = inputs;

  useEffect(() => {
    requestSeq.current += 1;
    setSlots([]);
    setSearched(false);
    setError(null);
    setFeatureDisabled(false);
    if (!enabled || !customerId || !assignedTo || !scheduledStartLocal || !scheduledEndLocal) {
      setSearching(false);
      return;
    }

    let scheduledAt: string;
    let scheduledEndsAt: string;
    try {
      scheduledAt = localDateTimeToIso(scheduledStartLocal);
      scheduledEndsAt = localDateTimeToIso(scheduledEndLocal);
      if (Date.parse(scheduledEndsAt) <= Date.parse(scheduledAt)) {
        setSearching(false);
        return;
      }
    } catch {
      setSearching(false);
      return;
    }

    const sequence = requestSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void findAvailableSlots({
        type,
        customerId,
        assignedTo,
        scheduledAt,
        scheduledEndsAt,
        jobCardId: jobCardId ?? null,
      }).then((result) => {
        if (requestSeq.current !== sequence) return;
        setSlots(result.slots);
        setSearched(true);
        setSearching(false);
      }).catch((caught: unknown) => {
        if (requestSeq.current !== sequence) return;
        setSlots([]);
        setSearched(true);
        setSearching(false);
        setFeatureDisabled(caught instanceof Error && 'code' in caught
          && (caught as Error & { code?: unknown }).code === 'NOT_FOUND');
        setError(caught instanceof Error ? caught : new Error('Uygun saatler yüklenemedi.'));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    assignedTo,
    customerId,
    enabled,
    jobCardId,
    scheduledEndLocal,
    scheduledStartLocal,
    type,
  ]);

  return { slots, searching, searched, error, featureDisabled };
}
