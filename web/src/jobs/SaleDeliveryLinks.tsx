import { useId, type ReactNode } from 'react';

import { paths } from '../paths';
import { jobCardStatusLabel } from './job-labels';
import type { LinkedDelivery } from './jobs-api';
import './sale-pair.css';

/**
 * SALE-002 §8.1: the sale card's "Bağlı teslimat" panel. Rendered only when the
 * server exposes the link at all (`undefined` = not exposed → no panel); `null`
 * says no delivery was opened at approval.
 */
export function LinkedDeliveryPanel(props: { linkedDelivery: LinkedDelivery | null | undefined }): ReactNode {
  const titleId = useId();
  if (props.linkedDelivery === undefined) return null;
  const delivery = props.linkedDelivery;
  return <section className="sale-pair-note" aria-labelledby={titleId} data-sale-delivery-link="true">
    <h3 id={titleId} className="sale-pair-heading">Bağlı teslimat</h3>
    {delivery === null
      ? <p>Henüz teslim işi açılmadı.</p>
      : delivery.id === null
        // The delivery is carried by another staff member: the sale owner sees
        // that it exists and how it progresses, without a link it cannot open.
        ? <p>Teslim işi açıldı, başka bir personel teslim ediyor · {jobCardStatusLabel(delivery.status)}</p>
        : <p>
            <a href={paths.job(delivery.id)}>Teslim işini aç</a>
            {' · '}
            {jobCardStatusLabel(delivery.status)}
          </p>}
  </section>;
}

/**
 * SALE-002 §5.5/§8.1: the delivery card's provenance line. Shown only when the
 * server names a readable source sale, so no id leaks to a viewer who cannot
 * read it.
 */
export function DeliveryProvenanceLine(props: { sourceSaleId: string | null | undefined }): ReactNode {
  if (typeof props.sourceSaleId !== 'string' || props.sourceSaleId.length === 0) return null;
  return <p className="sale-pair-note" data-delivery-provenance="true">
    Satış kaydından oluşturuldu:{' '}
    <a href={paths.job(props.sourceSaleId)}>Satış kaydını aç</a>
  </p>;
}
