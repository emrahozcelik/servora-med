import { AppError } from '../../errors/index.js';
import {
  canonicalScheduledEndsAt,
  parseDeliveryPurpose,
  parseInitialDeliveryItems,
  parsePastStartAcknowledgement,
  requiredScheduledAt,
} from './create-input.js';
import type { DeliveryPurpose, PastStartAcknowledgementInput } from './types.js';
import { optionalBoundedString, uuidString, validation } from './validation.js';

/**
 * SALE-002 §5.1: the optional `delivery` object of `POST /:id/approve`. Every
 * member is parsed by the same function the plain Product Delivery create
 * uses (§5.2: no second implementation); this file only fixes the allowlist
 * and the field path (`delivery.<field>`) the approval dialog maps errors to.
 */
export type SaleApprovalDeliveryInput = {
  /** Omitted = the sale's own assignee (resolved under the lock). */
  assignedTo?: string;
  scheduledAt: string;
  /** Always the canonical PRODUCT_DELIVERY end, never client-chosen. */
  scheduledEndsAt: string;
  deliveryPurpose: DeliveryPurpose;
  /** Stored once as the delivery card description; never as `deliveryNote`. */
  note: string | null;
  items: Array<{ productId: string; quantity: number }>;
  pastStartAcknowledgement?: PastStartAcknowledgementInput;
};

const SALE_APPROVAL_DELIVERY_FIELDS = [
  'assignedTo', 'scheduledAt', 'scheduledEndsAt', 'deliveryPurpose', 'note', 'items',
  'pastStartAcknowledgement',
] as const;

export const SALE_APPROVAL_DELIVERY_NOTE_MAX = 4_000;

/** The field every delivery-scoped 409 (offer window, calendar) is reported on. */
export const SALE_APPROVAL_DELIVERY_SCHEDULE_FIELD = 'delivery.scheduledAt';

/** Re-roots the field errors of a reused parser under `delivery.`. */
function underDelivery<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR'
      && error.details !== null && typeof error.details.fieldErrors === 'object'
      && error.details.fieldErrors !== null) {
      const scoped = Object.fromEntries(
        Object.entries(error.details.fieldErrors as Record<string, unknown>)
          .map(([field, message]) => [
            field.startsWith('delivery.') ? field : `delivery.${field}`,
            message,
          ]),
      );
      throw new AppError(error.code, error.statusCode, error.message, { fieldErrors: scoped });
    }
    throw error;
  }
}

/** `400 VALIDATION_ERROR` on `fieldErrors.delivery`: not a sale completion, or malformed. */
export function saleApprovalDeliveryNotAllowed(): AppError {
  return validation('delivery');
}

export function parseSaleApprovalDelivery(value: unknown): SaleApprovalDeliveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw saleApprovalDeliveryNotAllowed();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(
    (key) => !(SALE_APPROVAL_DELIVERY_FIELDS as readonly string[]).includes(key),
  )) {
    throw saleApprovalDeliveryNotAllowed();
  }
  return underDelivery(() => {
    const scheduledAt = requiredScheduledAt(record.scheduledAt);
    const scheduledEndsAt = canonicalScheduledEndsAt(
      'PRODUCT_DELIVERY', record.scheduledEndsAt, scheduledAt,
    );
    const pastStartAcknowledgement = parsePastStartAcknowledgement(record.pastStartAcknowledgement);
    return {
      ...(record.assignedTo === undefined
        ? {}
        : { assignedTo: uuidString(record.assignedTo, 'assignedTo') }),
      scheduledAt,
      scheduledEndsAt,
      deliveryPurpose: record.deliveryPurpose === undefined
        ? 'SALE'
        : parseDeliveryPurpose(record.deliveryPurpose),
      note: optionalBoundedString(record.note, 'note', SALE_APPROVAL_DELIVERY_NOTE_MAX),
      items: parseInitialDeliveryItems(record.items),
      ...(pastStartAcknowledgement ? { pastStartAcknowledgement } : {}),
    };
  });
}
