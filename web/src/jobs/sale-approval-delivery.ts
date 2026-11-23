import { ApiError } from '../services/api';
import { apiFieldError } from './api-field-error';
import { assignmentWindowErrorMessage } from './assignment-window-errors';
import {
  pastStartAcknowledgementPayload,
  type ApproveDeliveryInput,
  type DeliveryPurpose,
  type PastStartAcknowledgementCode,
} from './jobs-api';
import { defaultScheduledLocalValue, localDateTimeToIso } from './scheduling';
import { saleCount } from './sale-form';
import type { SaleDetails } from './sale-api';
import { PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH } from './PastStartAcknowledgementDrawer';

/**
 * SALE-002 S3 (§5.1, §8.2, §8.3): presentation-side state of the optional
 * "Teslim işi aç" section shared by the visit approve dialog and the
 * independent sale approve dialog. The server owns every rule (eligibility,
 * assignment window, idempotency); this module only builds the request body
 * the contract names, pre-checks what is cheap to pre-check, and maps the
 * definitive server answers back to the control that must change.
 */

export const SALE_DELIVERY_MAX_LINES = 25;
export const SALE_DELIVERY_NOTE_MAX_LENGTH = 4000;

export type SaleDeliverySourceItem = SaleDetails['items'][number];

/** The sale the approval completes, as the dialog already knows it (no second request). */
export type SaleDeliverySource = {
  saleId: string;
  title: string;
  assignedTo: string;
  customerName: string | null;
  /** `false` only when the caller positively knows the customer is inactive. */
  customerActive: boolean;
  items: readonly SaleDeliverySourceItem[];
  /**
   * `true` for a standalone sale or a sale whose source visit is terminal:
   * no visit approval exists, so the delivery is the only downstream job.
   */
  independent: boolean;
};

export type SaleDeliveryLine = {
  product: Pick<SaleDeliverySourceItem, 'name' | 'sku' | 'brand' | 'model' | 'unit'> & { id: string };
  /** Raw field text; validated as a whole unit on confirm. */
  quantity: string;
};

export type SaleDeliveryDraft = {
  enabled: boolean;
  lines: SaleDeliveryLine[];
  assignedTo: string;
  /** Device-local `YYYY-MM-DDTHH:mm`. */
  scheduledLocal: string;
  purpose: DeliveryPurpose;
  note: string;
  /** Set only after the server answered PAST_START_ACKNOWLEDGEMENT_REQUIRED. */
  ackRequired: boolean;
  ackCode: PastStartAcknowledgementCode | '';
  ackText: string;
};

export type SaleDeliveryField =
  | 'enabled' | 'items' | 'assignee' | 'scheduledAt' | 'purpose' | 'note' | 'acknowledgement';

/** Control order = focus order of the "first invalid control". */
export const SALE_DELIVERY_FIELD_ORDER: readonly SaleDeliveryField[] = [
  'enabled', 'items', 'assignee', 'scheduledAt', 'purpose', 'note', 'acknowledgement',
];

export type SaleDeliveryErrors = {
  /** Message that belongs to no single control (pair/summary level). */
  summary: string | null;
  fields: Partial<Record<SaleDeliveryField, string>>;
  /** Per-product line errors, keyed by product id. */
  lines: Record<string, string>;
  /** Bumps on every new failure so focus moves again for a repeated error. */
  seq: number;
};

export function hasSaleDeliveryErrors(errors: SaleDeliveryErrors | null): errors is SaleDeliveryErrors {
  return errors !== null
    && (errors.summary !== null
      || Object.keys(errors.fields).length > 0
      || Object.keys(errors.lines).length > 0);
}

/** §8.2: tomorrow at the next half-hour boundary, so no needless SHORT_NOTICE offer. */
export function defaultDeliveryScheduledLocal(now: Date): string {
  return defaultScheduledLocalValue(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/** §8.2 / Q7: on when the sale ships something to an eligible customer. */
export function createSaleDeliveryDraft(source: SaleDeliverySource, now: Date): SaleDeliveryDraft {
  return {
    enabled: source.items.length > 0 && source.customerActive,
    lines: source.items.slice(0, SALE_DELIVERY_MAX_LINES).map((item) => ({
      product: {
        id: item.productId, name: item.name, sku: item.sku, brand: item.brand,
        model: item.model, unit: item.unit,
      },
      quantity: item.quantity,
    })),
    assignedTo: source.assignedTo,
    scheduledLocal: defaultDeliveryScheduledLocal(now),
    purpose: 'SALE',
    note: '',
    ackRequired: false,
    ackCode: '',
    ackText: '',
  };
}

type BuildResult =
  | { ok: true; delivery: ApproveDeliveryInput }
  | { ok: false; errors: SaleDeliveryErrors };

function codePoints(value: string): number {
  return Array.from(value).length;
}

/**
 * §5.2 local pre-check (empty / fractional / duplicate / limits) and the §5.1
 * body. The server stays authoritative for everything else.
 */
export function buildSaleDeliveryRequest(draft: SaleDeliveryDraft, seq: number): BuildResult {
  const fields: SaleDeliveryErrors['fields'] = {};
  const lines: SaleDeliveryErrors['lines'] = {};
  if (draft.lines.length < 1) {
    fields.items = 'Teslim işi için en az bir ürün gerekli.';
  } else if (draft.lines.length > SALE_DELIVERY_MAX_LINES) {
    fields.items = `En fazla ${SALE_DELIVERY_MAX_LINES} farklı ürün teslim edilebilir.`;
  }
  const seen = new Set<string>();
  const items: ApproveDeliveryInput['items'] = [];
  for (const line of draft.lines) {
    if (seen.has(line.product.id)) {
      lines[line.product.id] = `${line.product.name} birden fazla kez eklenmiş.`;
      continue;
    }
    seen.add(line.product.id);
    const quantity = saleCount(line.quantity.trim());
    if (quantity === null) {
      lines[line.product.id] = `${line.product.name} için 1–999999999 arasında tam sayı adet girin.`;
      continue;
    }
    items.push({ productId: line.product.id, quantity });
  }
  if (!draft.assignedTo) fields.assignee = 'Teslim sorumlusu olarak bir personel seçin.';
  let scheduledAt = '';
  try {
    if (!draft.scheduledLocal) throw new Error('empty');
    scheduledAt = localDateTimeToIso(draft.scheduledLocal);
  } catch {
    fields.scheduledAt = 'Geçerli bir planlanan teslim zamanı girin.';
  }
  const note = draft.note.trim();
  if (codePoints(note) > SALE_DELIVERY_NOTE_MAX_LENGTH) {
    fields.note = `Not en fazla ${SALE_DELIVERY_NOTE_MAX_LENGTH.toLocaleString('tr-TR')} karakter olabilir.`;
  }
  let acknowledgement: ReturnType<typeof pastStartAcknowledgementPayload> = {};
  if (draft.ackRequired) {
    const text = draft.ackText.trim();
    if (draft.ackCode === '') {
      fields.acknowledgement = 'Başlangıcın neden geçtiğini açıklayan bir neden seçin.';
    } else if (text.length === 0) {
      fields.acknowledgement = 'Onayı açıklayan metin zorunludur.';
    } else if (codePoints(text) > PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH) {
      fields.acknowledgement = `Açıklama ${PAST_START_ACKNOWLEDGEMENT_TEXT_MAX_LENGTH.toLocaleString('tr-TR')} karakteri geçemez.`;
    } else {
      acknowledgement = pastStartAcknowledgementPayload({ code: draft.ackCode, text });
    }
  }
  if (Object.keys(fields).length > 0 || Object.keys(lines).length > 0) {
    return { ok: false, errors: { summary: null, fields, lines, seq } };
  }
  return {
    ok: true,
    delivery: {
      assignedTo: draft.assignedTo,
      scheduledAt,
      deliveryPurpose: draft.purpose,
      ...(note ? { note } : {}),
      items,
      ...acknowledgement,
    },
  };
}

export type SaleDeliveryServerError = {
  errors: SaleDeliveryErrors;
  /** Draft change that goes with the answer (e.g. switch off, ask for the acknowledgement). */
  patch: Partial<SaleDeliveryDraft>;
};

const DELIVERY_FIELD_KEYS: Record<string, SaleDeliveryField> = {
  items: 'items', productId: 'items', quantity: 'items',
  assignedTo: 'assignee',
  scheduledAt: 'scheduledAt', scheduledEndsAt: 'scheduledAt',
  deliveryPurpose: 'purpose',
  note: 'note',
  pastStartAcknowledgement: 'acknowledgement',
};

/** `items`, `items.0.quantity`, `delivery.items[1].productId` → the control family. */
function fieldFromKey(key: string): SaleDeliveryField | null {
  const parts = key.split(/[.[\]]+/).filter(Boolean);
  const start = parts[0] === 'delivery' ? 1 : 0;
  const head = parts[start];
  if (head === undefined) return null;
  return DELIVERY_FIELD_KEYS[head] ?? null;
}

/**
 * §8.3: a definitive server answer to an approval that carried `delivery`,
 * mapped to its exact control. `null` means "not a delivery answer" (so the
 * caller keeps its ordinary handling). Pair state conflicts are handled by the
 * S2 pair guidance before this runs.
 */
export function mapSaleDeliveryServerError(caught: unknown, seq: number): SaleDeliveryServerError | null {
  if (!(caught instanceof ApiError)) return null;
  const empty = (): SaleDeliveryErrors => ({ summary: null, fields: {}, lines: {}, seq });
  switch (caught.code) {
    case 'ASSIGNMENT_WINDOW_TOO_SHORT': {
      const errors = empty();
      errors.fields.scheduledAt = assignmentWindowErrorMessage(caught, 'Planlanan zaman çok yakın. Daha geç bir zaman seçin.');
      return { errors, patch: {} };
    }
    case 'PAST_START_ACKNOWLEDGEMENT_REQUIRED': {
      const errors = empty();
      errors.fields.scheduledAt = 'Planlanan teslim zamanı geçti. Aşağıdaki onayı doldurup tekrar onaylayın '
        + 'ya da daha ileri bir zaman seçin.';
      return { errors, patch: { ackRequired: true } };
    }
    case 'CUSTOMER_INACTIVE': {
      const errors = empty();
      errors.fields.enabled = 'Müşteri artık aktif değil; teslim işi açılamaz. '
        + 'Teslim işini kapatıp satışı onaylayabilirsiniz.';
      return { errors, patch: { enabled: false } };
    }
    case 'PRODUCT_NOT_FOUND': {
      const errors = empty();
      errors.fields.items = 'Seçilen ürünlerden biri bulunamadı veya artık aktif değil. Ürün listesini düzeltin.';
      return { errors, patch: {} };
    }
    case 'SALE_DELIVERY_EXISTS': {
      const errors = empty();
      errors.fields.enabled = 'Bu satış için teslim işi zaten açılmış; yeni bir teslim işi açılamaz.';
      return { errors, patch: { enabled: false } };
    }
    case 'SALE_PAIR_ASSIGNEE_CONFLICT': {
      const errors = empty();
      errors.summary = 'Bağlı ziyaret ve satış kaydı aynı personelde kalmalıdır. '
        + 'Farklı bir personel için yalnızca teslim sorumlusunu değiştirin.';
      errors.fields.assignee = 'Teslim sorumlusunu seçin; satış sahibi değişmez.';
      return { errors, patch: {} };
    }
    case 'VALIDATION_ERROR': {
      const raw = caught.details?.fieldErrors;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const errors = empty();
      let matched = false;
      for (const key of Object.keys(raw as Record<string, unknown>)) {
        const field = fieldFromKey(key);
        const isDelivery = key === 'delivery' || key.startsWith('delivery.') || key.startsWith('delivery[')
          || key === 'items' || key.startsWith('items.') || key.startsWith('items[');
        if (!isDelivery) continue;
        matched = true;
        const message = apiFieldError(caught, key, caught.message);
        if (field === null) errors.summary = errors.summary ?? message;
        else errors.fields[field] = errors.fields[field] ?? message;
      }
      return matched ? { errors, patch: {} } : null;
    }
    default:
      return null;
  }
}

/** First control that must receive focus after a failure (contract §8.3). */
export function firstInvalidField(errors: SaleDeliveryErrors): SaleDeliveryField | 'line' | 'summary' | null {
  if (errors.fields.enabled) return 'enabled';
  if (errors.fields.items) return 'items';
  if (Object.keys(errors.lines).length > 0) return 'line';
  for (const field of SALE_DELIVERY_FIELD_ORDER) {
    if (errors.fields[field]) return field;
  }
  return errors.summary ? 'summary' : null;
}
