import { describe, expect, it } from 'vitest';

import {
  boundedTrimmedString,
  codePointLength,
  optionalLifecycleNote,
  requireActionId,
  requireLifecycleReason,
} from '../src/modules/job-cards/validation.js';
import {
  parseJobCardBoardQuery,
  parseJobCardListQuery,
} from '../src/modules/job-cards/workspace-query.js';
import {
  JOB_CARD_ACTIVITY_EVENTS,
  type LifecycleCommand,
} from '../src/modules/job-cards/types.js';

const ASSIGNEE_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 });

describe('JobCard workspace list query', () => {
  it.each([
    [{}, { status: 'active', q: null, type: null, priority: null, limit: 25, offset: 0 }],
    [{ q: '  Klinik  ' }, { q: 'Klinik' }],
    [
      { type: 'PRODUCT_DELIVERY', priority: 'urgent' },
      { type: 'PRODUCT_DELIVERY', priority: 'urgent' },
    ],
  ])('parses list query %j', (raw, expected) => {
    expect(parseJobCardListQuery(raw)).toMatchObject(expected);
  });

  it('parses every allowed list key', () => {
    expect(parseJobCardListQuery({
      q: 'Klinik',
      status: 'WAITING_APPROVAL',
      type: 'PRODUCT_DELIVERY',
      assignedTo: ASSIGNEE_ID,
      customerId: CUSTOMER_ID,
      priority: 'high',
      dueBefore: '2026-07-31',
      dueAfter: '2026-07-01',
      limit: '100',
      offset: '12',
    })).toEqual({
      q: 'Klinik',
      status: 'WAITING_APPROVAL',
      type: 'PRODUCT_DELIVERY',
      assignedTo: ASSIGNEE_ID,
      customerId: CUSTOMER_ID,
      priority: 'high',
      dueBefore: '2026-07-31',
      dueAfter: '2026-07-01',
      limit: 100,
      offset: 12,
    });
  });

  it.each([
    'active', 'closed', 'all', 'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
    'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
  ])('accepts exact status %s', (status) => {
    expect(parseJobCardListQuery({ status }).status).toBe(status);
  });

  it.each(['new', 'ACTIVE', 'GENERAL_TASK', '', 'unknown', 'PLANNED'])('rejects unsupported status %s', (status) => {
    expect(() => parseJobCardListQuery({ status })).toThrowError(validationError);
  });

  it.each(['PRODUCT_DELIVERY', 'GENERAL_TASK', 'SALES_MEETING'] as const)(
    'accepts canonical type %s',
    (type) => {
      expect(parseJobCardListQuery({ type }).type).toBe(type);
      expect(parseJobCardBoardQuery({ type }).type).toBe(type);
    },
  );

  it.each(['', 'UNKNOWN', 'product_delivery'])('rejects invalid type %j', (type) => {
    expect(() => parseJobCardListQuery({ type })).toThrowError(validationError);
    expect(() => parseJobCardBoardQuery({ type })).toThrowError(validationError);
  });

  it.each(['low', 'normal', 'high', 'urgent'])('accepts priority %s', (priority) => {
    expect(parseJobCardListQuery({ priority }).priority).toBe(priority);
  });

  it('rejects unsupported priorities', () => {
    expect(() => parseJobCardListQuery({ priority: 'medium' })).toThrowError(validationError);
  });

  it('validates UUID filters', () => {
    expect(parseJobCardListQuery({ assignedTo: ASSIGNEE_ID, customerId: CUSTOMER_ID }))
      .toMatchObject({ assignedTo: ASSIGNEE_ID, customerId: CUSTOMER_ID });
    for (const [field, value] of [
      ['assignedTo', 'not-a-uuid'],
      ['customerId', '22222222-2222-4222-8222'],
    ] as const) {
      expect(() => parseJobCardListQuery({ [field]: value })).toThrowError(validationError);
    }
  });

  it.each(['   ', '\t\n', '\r', '\f', '\v', '\u00A0', '\u2028', '\u2029'])
    ('omits whitespace-only q %j', (q) => {
      expect(parseJobCardListQuery({ q }).q).toBeNull();
    });

  it('does not treat arbitrary zero-width format characters as whitespace', () => {
    expect(parseJobCardListQuery({ q: '\u200B' }).q).toBe('\u200B');
  });

  it('enforces q Unicode code-point boundaries', () => {
    expect(parseJobCardListQuery({ q: '😀' }).q).toBe('😀');
    expect(parseJobCardListQuery({ q: '😀'.repeat(200) }).q).toBe('😀'.repeat(200));
    expect(() => parseJobCardListQuery({ q: '😀'.repeat(201) })).toThrowError(validationError);
  });

  it.each(['2024-02-29', '2026-07-13'])('round-trips valid ISO date %s', (dueAfter) => {
    expect(parseJobCardListQuery({ dueAfter }).dueAfter).toBe(dueAfter);
  });

  it.each(['2025-02-29', '2026-02-30', '2026-7-13', '2026-07-13T00:00:00Z'])
    ('rejects invalid ISO date %s', (dueBefore) => {
      expect(() => parseJobCardListQuery({ dueBefore })).toThrowError(validationError);
    });

  it('keeps due bounds inclusive and rejects reversed bounds', () => {
    expect(parseJobCardListQuery({ dueAfter: '2026-07-13', dueBefore: '2026-07-13' }))
      .toMatchObject({ dueAfter: '2026-07-13', dueBefore: '2026-07-13' });
    expect(() => parseJobCardListQuery({
      dueAfter: '2026-07-14', dueBefore: '2026-07-13',
    })).toThrowError(validationError);
  });

  it.each([['1', 1], ['100', 100]])('accepts limit %s', (limit, expected) => {
    expect(parseJobCardListQuery({ limit }).limit).toBe(expected);
  });

  it.each(['0', '101', '-1', '1.5'])('rejects limit %s', (limit) => {
    expect(() => parseJobCardListQuery({ limit })).toThrowError(validationError);
  });

  it.each([['0', 0], ['42', 42]])('accepts offset %s', (offset, expected) => {
    expect(parseJobCardListQuery({ offset }).offset).toBe(expected);
  });

  it.each(['-1', '1.5'])('rejects offset %s', (offset) => {
    expect(() => parseJobCardListQuery({ offset })).toThrowError(validationError);
  });

  it('rejects unknown and repeated scalar keys', () => {
    expect(() => parseJobCardListQuery({ unexpected: 'value' })).toThrowError(validationError);
    for (const field of [
      'q', 'status', 'type', 'assignedTo', 'customerId', 'priority',
      'dueBefore', 'dueAfter', 'limit', 'offset',
    ]) {
      expect(() => parseJobCardListQuery({ [field]: ['one', 'two'] }))
        .toThrowError(validationError);
    }
  });

  it.each([null, [], 'q=test', 12])('rejects non-record query %j', (raw) => {
    expect(() => parseJobCardListQuery(raw)).toThrowError(validationError);
  });
});

describe('JobCard board query', () => {
  it('parses its exact allowlist and defaults', () => {
    expect(parseJobCardBoardQuery({
      q: ' Klinik ',
      type: 'PRODUCT_DELIVERY',
      assignedTo: ASSIGNEE_ID,
      customerId: CUSTOMER_ID,
      priority: 'normal',
      dueBefore: '2026-07-31',
      dueAfter: '2026-07-01',
      limit: '1',
    })).toEqual({
      q: 'Klinik',
      type: 'PRODUCT_DELIVERY',
      assignedTo: ASSIGNEE_ID,
      customerId: CUSTOMER_ID,
      priority: 'normal',
      dueBefore: '2026-07-31',
      dueAfter: '2026-07-01',
      limit: 1,
    });
    expect(parseJobCardBoardQuery({})).toMatchObject({ limit: 25, q: null });
  });

  it.each([{ status: 'active' }, { offset: '0' }, { limit: '101' }])
    ('rejects board-only invalid query %j', (raw) => {
      expect(() => parseJobCardBoardQuery(raw)).toThrowError(validationError);
    });
});

describe('shared JobCard validation', () => {
  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(codePointLength('😀')).toBe(1);
  });

  it('rejects repeated scalar board filters', () => {
    expect(() => parseJobCardBoardQuery({ type: ['PRODUCT_DELIVERY', 'GENERAL_TASK'] }))
      .toThrowError(validationError);
  });

  it.each([' ', '\t\n', '\r', '\f', '\v', '\u00A0', '\u2028', '\u2029'])
    ('uses JavaScript trim whitespace semantics for %j', (value) => {
      expect(() => boundedTrimmedString(value, 'field', 1, 10)).toThrowError(validationError);
    });

  it('preserves arbitrary zero-width format characters', () => {
    expect(boundedTrimmedString('\u200B', 'field', 1, 10)).toBe('\u200B');
  });

  it('validates action IDs at 1 and 255 code points', () => {
    expect(requireActionId(' action ')).toBe('action');
    expect(requireActionId('😀'.repeat(255))).toBe('😀'.repeat(255));
    expect(() => requireActionId('😀'.repeat(256))).toThrowError(validationError);
  });

  it('normalizes optional lifecycle notes and bounds reasons', () => {
    expect(optionalLifecycleNote(undefined)).toBeNull();
    expect(optionalLifecycleNote(` ${'😀'.repeat(2_000)} `)).toBe('😀'.repeat(2_000));
    expect(optionalLifecycleNote('\u00A0\u2028')).toBeNull();
    expect(optionalLifecycleNote('\u200B')).toBe('\u200B');
    expect(() => optionalLifecycleNote('😀'.repeat(2_001))).toThrowError(validationError);
    expect(requireLifecycleReason(' reason ', 'revisionReason')).toBe('reason');
    expect(() => requireLifecycleReason(' ', 'revisionReason')).toThrowError(validationError);
  });
});

describe('canonical JobCard types', () => {
  it('retains the exact activity vocabulary and lifecycle commands', () => {
    expect(JOB_CARD_ACTIVITY_EVENTS).toEqual([
      'JOB_CREATED', 'JOB_ASSIGNED', 'JOB_PLANNED', 'JOB_ACCEPTED', 'JOB_STARTED',
      'JOB_SUBMITTED_FOR_APPROVAL', 'JOB_APPROVED', 'JOB_REVISION_REQUESTED',
      'JOB_RESUMED', 'JOB_CANCELLED', 'JOB_FIELDS_UPDATED', 'DELIVERY_ITEM_ADDED',
      'DELIVERY_ITEM_UPDATED', 'DELIVERY_ITEM_REMOVED', 'NOTE_ADDED',
      'MEETING_DETAILS_UPDATED', 'JOB_APPROVAL_WITHDRAWN',
    ]);
    const commands: LifecycleCommand[] = [
      'ACCEPT_ASSIGNMENT', 'START', 'SUBMIT_FOR_APPROVAL', 'APPROVE', 'REQUEST_REVISION',
      'WITHDRAW_FROM_APPROVAL', 'RESUME', 'CANCEL',
    ];
    expect(commands).toHaveLength(8);
  });
});
