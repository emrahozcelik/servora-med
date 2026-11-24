import { useEffect, useRef, useState } from 'react';

import {
  findAvailableSlots,
  type AvailableSlot,
  type AvailableSlotsInput,
} from './jobs-api';
import { isoInstantToLocalDateTime, localDateTimeToIso } from './scheduling';

type SearchScope = {
  type: AvailableSlotsInput['type'];
  customerId: string | null;
  assignedTo: string | null;
  jobCardId: string | null;
  enabled: boolean;
};

export type AvailableSlotSearchInputs = {
  type: AvailableSlotsInput['type'];
  customerId: string | null;
  assignedTo: string | null;
  scheduledStartLocal: string;
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
 * Advisory Staff slot search. It is deliberately separate
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
  const slotsRef = useRef<AvailableSlot[]>([]);
  const lastScopeRef = useRef<SearchScope | null>(null);
  const {
    type,
    customerId,
    assignedTo,
    scheduledStartLocal,
    jobCardId,
    enabled,
  } = inputs;

  useEffect(() => {
    const normalizedJobCardId = jobCardId ?? null;
    const prevScope = lastScopeRef.current;
    const scopeUnchanged = prevScope !== null
      && prevScope.type === type
      && prevScope.customerId === customerId
      && prevScope.assignedTo === assignedTo
      && prevScope.jobCardId === normalizedJobCardId
      && prevScope.enabled === enabled;

    if (
      scopeUnchanged
      && scheduledStartLocal
      && slotsRef.current.some((slot) => {
        try {
          return isoInstantToLocalDateTime(slot.startsAt) === scheduledStartLocal;
        } catch {
          return false;
        }
      })
    ) {
      return;
    }

    lastScopeRef.current = {
      type,
      customerId,
      assignedTo,
      jobCardId: normalizedJobCardId,
      enabled,
    };
    requestSeq.current += 1;
    slotsRef.current = [];
    setSlots([]);
    setSearched(false);
    setError(null);
    setFeatureDisabled(false);
    if (!enabled || !customerId || !assignedTo || !scheduledStartLocal) {
      setSearching(false);
      return;
    }

    let scheduledAt: string;
    try {
      scheduledAt = localDateTimeToIso(scheduledStartLocal);
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
        jobCardId: normalizedJobCardId,
      }).then((result) => {
        if (requestSeq.current !== sequence) return;
        slotsRef.current = result.slots;
        setSlots(result.slots);
        setSearched(true);
        setSearching(false);
      }).catch((caught: unknown) => {
        if (requestSeq.current !== sequence) return;
        slotsRef.current = [];
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
    scheduledStartLocal,
    type,
  ]);

  return { slots, searching, searched, error, featureDisabled };
}
