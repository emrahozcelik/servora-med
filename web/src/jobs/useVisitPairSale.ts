import { useCallback, useEffect, useRef, useState } from 'react';

import { useRealtimeInvalidation } from '../realtime/RealtimeProvider';
import { ApiError } from '../services/api';
import { getJobCard, type JobCard, type JobCardStatus } from './jobs-api';
import { getSaleCreateContext, getSaleDetails } from './sale-api';
import {
  COORDINATING_VISIT_STATUSES,
  isActiveSaleStatus,
  type VisitPairSale,
} from './sale-pair';

/**
 * SALE-002 S2 pair discovery for a visit card (§4.1).
 *
 * The lookup uses only existing read endpoints: the visit's sale-create context
 * names the active linked sale (and withholds it from a Staff member who cannot
 * read it), the sale card supplies status/version/assignee and the sale's own
 * server-computed submission readiness, and the sale details supply the product
 * lines the approval dialog reviews. The server remains authoritative for every
 * command; this state only decides what the dialog shows and whether the
 * request carries `expectedSaleVersion`.
 */
export type VisitPairState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'error' }
  | { kind: 'ready'; sale: VisitPairSale; coordinated: boolean };

export function useVisitPairSale(input: {
  visitId: string;
  visitType: JobCard['type'];
  visitStatus: JobCardStatus;
  visitAssignedTo: string;
  visitVersion: number;
}): [VisitPairState, () => void] {
  const { visitId, visitType, visitStatus, visitAssignedTo, visitVersion } = input;
  const applicable = visitType === 'SALES_MEETING'
    && COORDINATING_VISIT_STATUSES.includes(visitStatus);
  const [state, setState] = useState<VisitPairState>({ kind: applicable ? 'loading' : 'idle' });
  const [reloadKey, setReloadKey] = useState(0);
  const saleIdRef = useRef<string | null>(null);
  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useRealtimeInvalidation(
    ['job-detail:' + visitId, ...(saleIdRef.current ? ['job-detail:' + saleIdRef.current] : [])],
    reload,
  );

  useEffect(() => {
    if (!applicable) {
      saleIdRef.current = null;
      setState({ kind: 'idle' });
      return;
    }
    let current = true;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const context = await getSaleCreateContext(visitId);
        if (!current) return;
        const activeSale = context.activeSale;
        if (activeSale === null) {
          saleIdRef.current = null;
          setState({ kind: 'none' });
          return;
        }
        if (activeSale.access === 'RESTRICTED') {
          // Unreadable to this actor: a divergent-assignee legacy pair, which
          // never coordinates (R17) and must never leak the other card's id.
          saleIdRef.current = null;
          setState({ kind: 'unreadable' });
          return;
        }
        saleIdRef.current = activeSale.id;
        const [card, details] = await Promise.all([
          getJobCard(activeSale.id),
          getSaleDetails(activeSale.id),
        ]);
        if (!current) return;
        setState({
          kind: 'ready',
          sale: {
            id: card.id,
            title: card.title,
            status: card.status,
            version: card.version,
            assignedTo: card.assignedTo,
            readiness: card.workflowContext.submissionReadiness,
            items: details.items,
          },
          // §4.2: coordination needs one owner for the live pair. A status that
          // is no longer active (approved/cancelled between the two reads) also
          // stops coordinating; the server revalidates both.
          coordinated: card.assignedTo === visitAssignedTo && isActiveSaleStatus(card.status),
        });
      } catch (caught) {
        if (!current) return;
        saleIdRef.current = null;
        if (caught instanceof ApiError && caught.status === 404) {
          setState({ kind: 'none' });
          return;
        }
        setState({ kind: 'error' });
      }
    })();
    return () => { current = false; };
  }, [applicable, visitId, visitStatus, visitAssignedTo, visitVersion, reloadKey]);

  return [state, reload];
}
