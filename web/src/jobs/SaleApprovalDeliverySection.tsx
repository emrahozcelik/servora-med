import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { ProductSelect } from '../ProductSelect';
import { listStaff, type StaffProfile } from '../services/people-api';
import type { Product } from '../services/products-api';
import { DELIVERY_PURPOSE_LABELS, pastStartAcknowledgementLabels } from './job-labels';
import { WheelDateTimeField } from '../ui/WheelDateTimeField';
import {
  DELIVERY_PURPOSES,
  PAST_START_ACKNOWLEDGEMENT_CODES,
  type DeliveryPurpose,
  type PastStartAcknowledgementCode,
} from './jobs-api';
import {
  SALE_DELIVERY_FIELD_ORDER,
  SALE_DELIVERY_MAX_LINES,
  SALE_DELIVERY_NOTE_MAX_LENGTH,
  firstInvalidField,
  hasSaleDeliveryErrors,
  type SaleDeliveryDraft,
  type SaleDeliveryErrors,
  type SaleDeliveryField,
  type SaleDeliverySource,
} from './sale-approval-delivery';
import { PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH } from './PastStartAcknowledgementDrawer';
import { loadSaleProducts } from './sale-form';
import './sale-approval-delivery.css';

export type SaleApprovalDeliverySectionProps = {
  source: SaleDeliverySource;
  draft: SaleDeliveryDraft;
  errors: SaleDeliveryErrors | null;
  /** The approval request is in flight. */
  pending: boolean;
  /** The approval outcome is unresolved; only the original request may be retried. */
  uncertain: boolean;
  onChange: (patch: Partial<SaleDeliveryDraft>, touched?: SaleDeliveryField) => void;
};

const HELPER_TEXT = 'Onayla birlikte planlanmış bir ürün teslimi oluşturulur; teslim personeli '
  + 'kabul edip gerçekleşen zamanı girdikten sonra onaya gönderir.';

/**
 * SALE-002 §8.2: the single "Teslim işi aç" section. It is mounted by the visit
 * approve dialog (while the coordinated sale is `WAITING_APPROVAL`) and by the
 * independent sale approve dialog; it must not be duplicated. The sale detail
 * projection arrives as `source`, so no second request prefills it.
 */
export function SaleApprovalDeliverySection(props: SaleApprovalDeliverySectionProps): ReactNode {
  const { source, draft, errors, pending, uncertain, onChange } = props;
  const locked = pending || uncertain;
  const id = useId();
  const ids = {
    enabled: `${id}-enabled`,
    help: `${id}-help`,
    assignee: `${id}-assignee`,
    scheduledAt: `${id}-scheduled-at`,
    scheduledHelp: `${id}-scheduled-help`,
    purpose: `${id}-purpose`,
    note: `${id}-note`,
    ackCode: `${id}-ack-code`,
    ackText: `${id}-ack-text`,
    summary: `${id}-summary`,
  };
  const rootRef = useRef<HTMLElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [staffState, setStaffState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [staffReload, setStaffReload] = useState(0);
  const [limitNote, setLimitNote] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Any active STAFF member may take the physical delivery (D4). Same loader
  // the delivery create form uses.
  useEffect(() => {
    let active = true;
    setStaffState('loading');
    listStaff('active').then((profiles) => {
      if (!active) return;
      setStaff(profiles);
      setStaffState('ready');
    }).catch(() => { if (active) setStaffState('error'); });
    return () => { active = false; };
  }, [staffReload]);

  const noEligibleAssignee = staffState === 'ready' && staff.length === 0;
  const assigneeKnown = staff.some((profile) => profile.user.id === draft.assignedTo);
  const impossibleReason = !source.customerActive
    ? 'Müşteri aktif olmadığı için teslim işi açılamaz.'
    : noEligibleAssignee
      ? 'Teslim sorumlusu olabilecek aktif personel bulunmadığı için teslim işi açılamaz.'
      : null;

  // §8.2: off and explained when impossible. A staff list that arrives later
  // can still make the default impossible, so the draft follows it once.
  useEffect(() => {
    if (impossibleReason !== null && draftRef.current.enabled) onChange({ enabled: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impossibleReason]);
  // The sale's own staff may have been deactivated: do not preselect someone
  // the server would refuse; the manager picks an active member instead.
  useEffect(() => {
    if (staffState !== 'ready' || staff.length === 0) return;
    if (draftRef.current.assignedTo && !assigneeKnown) onChange({ assignedTo: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffState, staff]);

  // §8.3: move focus to the first invalid control once the section is
  // interactive again (the failure arrives while the controls were locked).
  const focusedSeq = useRef(0);
  useEffect(() => {
    if (!hasSaleDeliveryErrors(errors) || locked || errors.seq === focusedSeq.current) return;
    focusedSeq.current = errors.seq;
    const root = rootRef.current;
    if (!root) return;
    const first = firstInvalidField(errors);
    let target: HTMLElement | null = null;
    if (first === 'enabled') target = root.querySelector(`[id="${ids.enabled}"]`);
    else if (first === 'items') target = root.querySelector('.product-select input[type="search"]');
    else if (first === 'line') target = root.querySelector('input[aria-invalid="true"][data-delivery-quantity]');
    else if (first === 'assignee') target = root.querySelector(`[id="${ids.assignee}"]`);
    else if (first === 'scheduledAt') target = root.querySelector(`[id="${ids.scheduledAt}"]`);
    else if (first === 'purpose') target = root.querySelector(`[id="${ids.purpose}"]`);
    else if (first === 'note') target = root.querySelector(`[id="${ids.note}"]`);
    else if (first === 'acknowledgement') {
      target = root.querySelector(`[id="${draft.ackCode === '' ? ids.ackCode : ids.ackText}"]`);
    } else target = summaryRef.current;
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errors, locked]);

  const fieldError = (field: SaleDeliveryField) => errors?.fields[field] ?? '';
  const invalid = (field: SaleDeliveryField) => (fieldError(field) ? true : undefined);
  const describedBy = (field: SaleDeliveryField, ...extra: string[]) => {
    const parts = [...extra, fieldError(field) ? `${id}-${field}-error` : ''].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  };
  const messages: string[] = errors
    ? [
        ...(errors.summary ? [errors.summary] : []),
        ...SALE_DELIVERY_FIELD_ORDER.flatMap((field) => errors.fields[field] ?? []),
        ...Object.values(errors.lines),
      ]
    : [];

  function addProduct(product: Product) {
    if (draft.lines.length >= SALE_DELIVERY_MAX_LINES) {
      setLimitNote(`En fazla ${SALE_DELIVERY_MAX_LINES} farklı ürün seçebilirsiniz.`);
      return;
    }
    setLimitNote('');
    if (draft.lines.some((line) => line.product.id === product.id)) return;
    onChange({
      lines: [...draft.lines, {
        product: {
          id: product.id, name: product.name, sku: product.sku, brand: product.brand,
          model: product.model, unit: product.unit,
        },
        quantity: '1',
      }],
    }, 'items');
  }

  const showHelperOnce = <p className="form-help sale-delivery-help" id={ids.help}>{HELPER_TEXT}</p>;

  return <section className="sale-delivery" ref={rootRef} data-sale-delivery="true">
    <fieldset className="sale-delivery-fieldset" disabled={locked}>
      <legend className="sale-delivery-legend">Ürün teslimi</legend>
      <div className="form-checkbox-row sale-delivery-switch">
        <input
          id={ids.enabled}
          type="checkbox"
          checked={draft.enabled && impossibleReason === null}
          disabled={locked || impossibleReason !== null}
          aria-describedby={[ids.help, fieldError('enabled') ? `${id}-enabled-error` : '']
            .filter(Boolean).join(' ')}
          aria-invalid={invalid('enabled')}
          onChange={(event) => onChange({ enabled: event.target.checked }, 'enabled')}
        />
        <label htmlFor={ids.enabled}>Teslim işi aç</label>
      </div>
      {showHelperOnce}
      {source.independent && <p className="form-help sale-delivery-help">
        Bu onayın oluşturacağı tek sonraki iş bu teslim işidir; bağlı bir ziyaret kaydı bulunmuyor.
      </p>}
      {fieldError('enabled') && <p className="field-error" id={`${id}-enabled-error`}>{fieldError('enabled')}</p>}
      {impossibleReason !== null && <p className="sale-delivery-impossible">
        <span aria-hidden="true">⚠ </span>{impossibleReason}
      </p>}
      {pending && <p className="sale-delivery-status" role="status">
        Onay işleniyor; teslim işi alanları kilitli.
      </p>}
      {!pending && messages.length > 0 && <div
        className="sale-delivery-summary"
        id={ids.summary}
        role="alert"
        tabIndex={-1}
        ref={summaryRef}
      >
        <p className="sale-delivery-summary-title">
          <span aria-hidden="true">⚠ </span>Teslim işi bilgilerini düzeltin:
        </p>
        <ul>{messages.map((message, index) => <li key={index}>{message}</li>)}</ul>
      </div>}
      {draft.enabled && impossibleReason === null && <div className="sale-delivery-body">
        <div className="sale-delivery-products">
          <ProductSelect
            load={loadSaleProducts}
            disabled={locked}
            selectedProducts={draft.lines.map((line) => line.product)}
            onAdd={addProduct}
            onRemove={(productId) => {
              setLimitNote('');
              onChange({ lines: draft.lines.filter((line) => line.product.id !== productId) }, 'items');
            }}
            renderQuantity={(product) => {
              const line = draft.lines.find((entry) => entry.product.id === product.id);
              const lineError = errors?.lines[product.id];
              const inputId = `${id}-qty-${product.id}`;
              return <>
                <label htmlFor={inputId}>Miktar<span className="sr-only">: {product.name}</span></label>
                <input
                  className="form-control"
                  id={inputId}
                  data-delivery-quantity="true"
                  type="number"
                  min="1"
                  max="999999999"
                  step="1"
                  inputMode="numeric"
                  value={line?.quantity ?? ''}
                  required
                  aria-invalid={lineError ? true : undefined}
                  aria-describedby={lineError ? `${inputId}-error` : undefined}
                  onChange={(event) => onChange({
                    lines: draft.lines.map((entry) => entry.product.id === product.id
                      ? { ...entry, quantity: event.target.value }
                      : entry),
                  }, 'items')}
                />
                {lineError && <span className="field-error" id={`${inputId}-error`}>{lineError}</span>}
              </>;
            }}
          />
          {draft.lines.length === 0 && <p className="form-help">
            Teslim işi için en az bir ürün ekleyin ya da teslim işini kapatın.
          </p>}
          {limitNote && <p className="field-error" role="status">{limitNote}</p>}
          {fieldError('items') && <p className="field-error" id={`${id}-items-error`}>{fieldError('items')}</p>}
        </div>

        <div className="field-group">
          <label htmlFor={ids.assignee}>Teslim sorumlusu</label>
          <select
            id={ids.assignee}
            value={draft.assignedTo}
            required
            disabled={locked || staffState !== 'ready'}
            aria-invalid={invalid('assignee')}
            aria-describedby={describedBy('assignee')}
            onChange={(event) => onChange({ assignedTo: event.target.value }, 'assignee')}
          >
            <option value="">Seçin</option>
            {staff.map((profile) => <option key={profile.user.id} value={profile.user.id}>
              {profile.user.name}{profile.user.id === source.assignedTo ? ' (satış sorumlusu)' : ''}
            </option>)}
          </select>
          {staffState === 'loading' && <span className="field-status" role="status">Personel listesi yükleniyor…</span>}
          {staffState === 'error' && <span className="field-error" role="alert">
            Personel listesi yüklenemedi.{' '}
            <button type="button" className="inline-action" onClick={() => setStaffReload((value) => value + 1)}>
              Yeniden dene
            </button>
          </span>}
          {fieldError('assignee') && <span className="field-error" id={`${id}-assignee-error`}>{fieldError('assignee')}</span>}
        </div>

        <div className="sale-delivery-pair">
          <div className="field-group">
            <WheelDateTimeField
              mode="datetime"
              id={ids.scheduledAt}
              name="scheduledAt"
              value={draft.scheduledLocal}
              onChange={(value) => onChange({
                scheduledLocal: value,
                // The acknowledgement answered one specific past start.
                ackRequired: false, ackCode: '', ackText: '',
              }, 'scheduledAt')}
              required
              invalid={invalid('scheduledAt')}
              aria-describedby={describedBy('scheduledAt', ids.scheduledHelp)}
              label="Planlanan teslim zamanı"
            />
            <span className="form-help" id={ids.scheduledHelp}>
              Cihazınızın yerel saat dilimi: {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </span>
            {fieldError('scheduledAt') && <span className="field-error" id={`${id}-scheduledAt-error`}>
              {fieldError('scheduledAt')}
            </span>}
          </div>
          <div className="field-group">
            <label htmlFor={ids.purpose}>Teslim amacı</label>
            <select
              id={ids.purpose}
              value={draft.purpose}
              required
              aria-invalid={invalid('purpose')}
              aria-describedby={describedBy('purpose')}
              onChange={(event) => onChange({ purpose: event.target.value as DeliveryPurpose }, 'purpose')}
            >
              {DELIVERY_PURPOSES.map((purpose) => <option key={purpose} value={purpose}>
                {DELIVERY_PURPOSE_LABELS[purpose]}
              </option>)}
            </select>
            {fieldError('purpose') && <span className="field-error" id={`${id}-purpose-error`}>{fieldError('purpose')}</span>}
          </div>
        </div>

        {draft.ackRequired && <div className="sale-delivery-ack">
          <p className="form-help">
            Planlanan başlangıç saati geçti. Teslimi kaydetmek için müşterinin güncel durumunu onaylayın.
          </p>
          <div className="field-group">
            <label htmlFor={ids.ackCode}>Neden</label>
            <select
              id={ids.ackCode}
              required
              value={draft.ackCode}
              aria-invalid={invalid('acknowledgement')}
              aria-describedby={describedBy('acknowledgement')}
              onChange={(event) => onChange({
                ackCode: event.target.value as PastStartAcknowledgementCode | '',
              }, 'acknowledgement')}
            >
              <option value="">Neden seçin</option>
              {PAST_START_ACKNOWLEDGEMENT_CODES.map((code) => <option key={code} value={code}>
                {pastStartAcknowledgementLabels[code]}
              </option>)}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor={ids.ackText}>Onay açıklaması</label>
            <textarea
              id={ids.ackText}
              rows={3}
              required
              maxLength={PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH}
              value={draft.ackText}
              aria-invalid={invalid('acknowledgement')}
              aria-describedby={describedBy('acknowledgement')}
              onChange={(event) => onChange({ ackText: event.target.value }, 'acknowledgement')}
            />
            {fieldError('acknowledgement') && <span className="field-error" id={`${id}-acknowledgement-error`}>
              {fieldError('acknowledgement')}
            </span>}
          </div>
        </div>}

        <div className="field-group">
          <label htmlFor={ids.note}>Teslim notu (isteğe bağlı)</label>
          <textarea
            id={ids.note}
            rows={3}
            maxLength={SALE_DELIVERY_NOTE_MAX_LENGTH}
            value={draft.note}
            aria-invalid={invalid('note')}
            aria-describedby={describedBy('note')}
            onChange={(event) => onChange({ note: event.target.value }, 'note')}
          />
          {fieldError('note') && <span className="field-error" id={`${id}-note-error`}>{fieldError('note')}</span>}
        </div>
      </div>}
    </fieldset>
  </section>;
}
