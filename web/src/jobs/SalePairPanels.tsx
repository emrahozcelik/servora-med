import { useId, type ReactNode } from 'react';

import { paths } from '../paths';
import type { VisitPairState } from './useVisitPairSale';
import {
  approvalCompletesSale,
  lifecycleMovesSale,
  pairManagedSaleCommand,
  visitSubmitPairBlockers,
  type SalePairGuidance,
} from './sale-pair';
import { requirementLabels } from './job-workflow-presentation';
import type { JobCard, LifecycleCommand } from './jobs-api';
import { jobCardStatusLabel } from './job-labels';
import type { SaleSource } from './sale-api';
import './sale-pair.css';

const REQUIREMENT_STATE_TEXT = {
  met: 'Tamam',
  missing: 'Eksik',
  invalid: 'Geçersiz',
} as const;

function SalePairHeading(props: { id: string; children: ReactNode }): ReactNode {
  return <h3 id={props.id} className="sale-pair-heading">{props.children}</h3>;
}

function SalePairLink(props: { id: string; title: string }): ReactNode {
  return <a href={paths.job(props.id)}>{props.title}</a>;
}

function PairLoadNote(props: { pair: VisitPairState; onRetry: () => void }): ReactNode {
  if (props.pair.kind === 'loading') {
    return <p className="sale-pair-status" role="status">Bağlı satış bilgisi yükleniyor…</p>;
  }
  if (props.pair.kind === 'error') {
    return <p className="sale-pair-status" role="alert">
      Bağlı satış bilgisi yüklenemedi. Gönderim, bağlı satış kaydıyla birlikte yapılır.{' '}
      <button type="button" className="inline-action" onClick={props.onRetry}>
        Bağlı satış bilgisini yeniden dene
      </button>
    </p>;
  }
  return null;
}

/**
 * SALE-002 §8.1: the visit submit dialog states that the submission carries the
 * linked sale, links it, and lists the sale's unmet requirements. There is no
 * "skip the sale" control (D3/Q2).
 */
export function VisitPairSubmitNote(props: {
  pair: VisitPairState;
  onRetry: () => void;
}): ReactNode {
  const titleId = useId();
  const { pair } = props;
  if (pair.kind === 'loading' || pair.kind === 'error') {
    return <div className="sale-pair-note" data-sale-pair="submit">
      <PairLoadNote pair={pair} onRetry={props.onRetry} />
    </div>;
  }
  if (pair.kind !== 'ready' || !pair.coordinated) return null;
  const sale = pair.sale;
  const blockers = visitSubmitPairBlockers(sale, requirementLabels);
  return <section className="sale-pair-note" aria-labelledby={titleId} data-sale-pair="submit">
    <SalePairHeading id={titleId}>Bağlı satış kaydı</SalePairHeading>
    <p>
      Bu gönderim bağlı satış kaydını da onaya gönderir:{' '}
      <SalePairLink id={sale.id} title={sale.title} />
      {' · '}
      {jobCardStatusLabel(sale.status)}
    </p>
    {sale.status === 'WAITING_APPROVAL' && (
      <p className="sale-pair-status">
        Bağlı satış kaydı daha önce onaya gönderilmiş. Bu gönderim onu yeniden
        göndermez; tek onay iki kaydı birlikte tamamlar.
      </p>
    )}
    {sale.readiness === null && sale.status !== 'WAITING_APPROVAL' && (
      <p className="sale-pair-status">
        Bağlı satış kaydının hazırlığı bu aşamada önizlenemiyor; gönderim sunucuda
        doğrulanır.
      </p>
    )}
    {blockers.length > 0 && <div className="sale-pair-blocker" role="alert">
      {blockers.map((blocker) => blocker.kind === 'NOT_READY'
        ? <div key="not-ready">
            <p>Bağlı satış kaydı hazır değil. Eksikler giderilmeden gönderim yapılamaz:</p>
            <ul className="sale-pair-requirement-list">
              {blocker.unmet.map((item) => <li
                key={item.code}
                className={`sale-pair-requirement sale-pair-requirement-${item.state}`}
              >
                <span aria-hidden="true">{item.state === 'invalid' ? '!' : '○'}</span>
                {' '}{item.label}
                <span className="sale-pair-requirement-state">
                  {' · '}{REQUIREMENT_STATE_TEXT[item.state]}
                </span>
              </li>)}
            </ul>
          </div>
        : blocker.kind === 'ACCEPT_REQUIRED'
          ? <p key="accept">Bağlı satış kaydı önce kabul edilmeli. Gönderim, satış
              kaydı kabul edilmeden yapılamaz.</p>
          : <p key="resume">Bağlı satış kaydı düzeltme bekliyor. Önce satış
              kaydında düzeltmeye başlayın.</p>)}
      <a className="secondary-button compact-button" href={paths.job(sale.id)}>
        Satış kaydını aç
      </a>
    </div>}
  </section>;
}

/**
 * SALE-002 §8.1/§4.3: the visit approval is the pair's only approval surface.
 * It shows the linked sale and its product lines for review, and warns when a
 * legacy sale in another state will stay open.
 */
export function VisitPairApproveNote(props: {
  pair: VisitPairState;
  onRetry: () => void;
}): ReactNode {
  const titleId = useId();
  const itemsId = useId();
  const { pair } = props;
  if (pair.kind === 'loading' || pair.kind === 'error') {
    return <div className="sale-pair-note" data-sale-pair="approve">
      <PairLoadNote pair={pair} onRetry={props.onRetry} />
    </div>;
  }
  if (pair.kind !== 'ready' || !pair.coordinated) return null;
  const sale = pair.sale;
  return <section className="sale-pair-note" aria-labelledby={titleId} data-sale-pair="approve">
    <SalePairHeading id={titleId}>Bağlı satış kaydı</SalePairHeading>
    {approvalCompletesSale(sale)
      ? <p>
          Bu onay bağlı satış kaydını da tamamlar:{' '}
          <SalePairLink id={sale.id} title={sale.title} />
          {' · '}
          {jobCardStatusLabel(sale.status)}
        </p>
      : <div className="sale-pair-blocker" role="status">
          <p>
            Bağlı satış kaydı onaylanmadan kalacak:{' '}
            <SalePairLink id={sale.id} title={sale.title} />
            {' · '}
            {jobCardStatusLabel(sale.status)}. Bu onay yalnızca ziyareti tamamlar;
            satış kaydı kendi kartından yürütülür.
          </p>
        </div>}
    <h4 className="sale-pair-items-title" id={itemsId}>Satılan ürünler</h4>
    {sale.items.length === 0
      ? <p className="sale-pair-status">Bağlı satış kaydında ürün satırı yok.</p>
      : <ul className="sale-pair-items" aria-labelledby={itemsId}>
          {sale.items.map((item) => <li key={item.id}>
            <span className="sale-pair-quantity">{item.quantity} ürün</span>
            <span>{item.name}</span>
          </li>)}
        </ul>}
  </section>;
}

/**
 * SALE-002 §8.1: a revision or withdraw on the visit states whether the pair
 * moves together or only the card in hand.
 */
export function VisitPairLifecycleNote(props: {
  pair: VisitPairState;
  command: 'REQUEST_REVISION' | 'WITHDRAW_FROM_APPROVAL';
  onRetry: () => void;
}): ReactNode {
  const titleId = useId();
  const { pair, command } = props;
  if (pair.kind === 'loading' || pair.kind === 'error') {
    return <div className="sale-pair-note" data-sale-pair="lifecycle">
      <PairLoadNote pair={pair} onRetry={props.onRetry} />
    </div>;
  }
  if (pair.kind !== 'ready' || !pair.coordinated) return null;
  const sale = pair.sale;
  const action = command === 'REQUEST_REVISION'
    ? 'düzeltmeye gönderilir'
    : 'yeniden düzenlemeye açılır';
  return <section className="sale-pair-note" aria-labelledby={titleId} data-sale-pair="lifecycle">
    <SalePairHeading id={titleId}>Bağlı satış kaydı</SalePairHeading>
    {lifecycleMovesSale(sale, command)
      ? <p>
          Bağlı satış kaydı da birlikte {action}:{' '}
          <SalePairLink id={sale.id} title={sale.title} />
        </p>
      : <p>
          Yalnızca bu ziyaret {action}; bağlı satış kaydı olduğu durumda kalır:{' '}
          <SalePairLink id={sale.id} title={sale.title} />
          {' · '}
          {jobCardStatusLabel(sale.status)}
        </p>}
  </section>;
}

const PAIR_MANAGED_COPY: Partial<Record<LifecycleCommand, string>> = {
  SUBMIT_FOR_APPROVAL:
    'Bu satış kaydının gönderimi bağlı ziyaret kaydıyla birlikte yapılır. Ziyaret kartından gönderin.',
  APPROVE:
    'Bu satış kaydının onayı bağlı ziyaret kaydıyla birlikte verilir. Onay ziyaret kartından verilir.',
  RESUME:
    'Düzeltmeye başlama bağlı ziyaret kaydıyla birlikte yapılır. İşlemi ziyaret kartından yapın.',
};

/**
 * SALE-002 §8.1: the sale card shows its pair state. When the server withholds
 * the command the card's own status would offer (R15), the panel names the
 * exact next action instead of leaving a dead end.
 */
export function SalePairContextPanel(props: {
  job: JobCard & { type: 'SALE' };
  sourceVisit: SaleSource;
  /**
   * SALE-001 concealment: while the client revalidates the restricted origin,
   * the retained FULL source must not be rendered (the pair panel included).
   */
  originPending?: boolean;
}): ReactNode {
  const titleId = useId();
  const { job, sourceVisit, originPending = false } = props;
  if (originPending) return null;
  if (sourceVisit.kind !== 'SALE_FROM_VISIT' || sourceVisit.access !== 'FULL') return null;
  const managed = pairManagedSaleCommand({
    type: job.type,
    status: job.status,
    allowedCommands: job.workflowContext.allowedCommands,
    sourceVisitAccess: 'FULL',
  });
  return <section
    className="sale-pair-note"
    aria-labelledby={titleId}
    data-sale-pair="sale"
  >
    <SalePairHeading id={titleId}>Bağlı ziyaret</SalePairHeading>
    <p>
      <SalePairLink id={sourceVisit.id} title={sourceVisit.title} />
      {' · '}
      {jobCardStatusLabel(sourceVisit.status)}
    </p>
    {managed && PAIR_MANAGED_COPY[managed] && (
      <p className="sale-pair-status">
        {PAIR_MANAGED_COPY[managed]}{' '}
        <a href={paths.job(sourceVisit.id)}>Ziyaret kartını aç</a>
      </p>
    )}
  </section>;
}

/** Renders the server-named next action for a redirected/conflicted command. */
export function SalePairGuidanceNotice(props: {
  guidance: SalePairGuidance;
}): ReactNode {
  const { guidance } = props;
  return <div className="detail-feedback sale-pair-guidance" role="alert" data-sale-pair="guidance">
    <p>{guidance.message}</p>
    {guidance.targetId && guidance.targetLabel && (
      <a className="secondary-button compact-button" href={paths.job(guidance.targetId)}>
        {guidance.targetLabel}
      </a>
    )}
  </div>;
}
