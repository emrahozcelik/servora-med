/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAvailableSlotSearch } from '../src/jobs/useAvailableSlotSearch';
import { localDateTimeToIso } from '../src/jobs/scheduling';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobs = vi.hoisted(() => ({ findAvailableSlots: vi.fn() }));
vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(),
  findAvailableSlots: jobs.findAvailableSlots,
}));

function Probe({
  type = 'SALES_MEETING',
  start = '2026-08-16T10:00',
  end,
}: {
  type?: 'SALES_MEETING' | 'PRODUCT_DELIVERY';
  start?: string;
  end?: string;
}) {
  const result = useAvailableSlotSearch({
    type,
    customerId: 'customer-1',
    assignedTo: 'staff-1',
    scheduledStartLocal: start,
    scheduledEndLocal: end,
    jobCardId: null,
    enabled: true,
  });
  return <output data-state={result.searching ? 'searching' : 'ready'} data-count={result.slots.length} />;
}

describe('useAvailableSlotSearch', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    jobs.findAvailableSlots.mockResolvedValue({
      slots: [{ startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T11:00:00.000Z' }],
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('debounces a complete request and exposes the minimal slots', async () => {
    await act(async () => root.render(<Probe end="2026-08-16T11:00" />));
    expect(jobs.findAvailableSlots).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledWith({
      type: 'SALES_MEETING',
      customerId: 'customer-1',
      assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-08-16T10:00'),
      scheduledEndsAt: localDateTimeToIso('2026-08-16T11:00'),
      jobCardId: null,
    });
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '1' });
  });

  it('uses the 30-minute Product Delivery preview when end is omitted', async () => {
    await act(async () => root.render(
      <Probe type="PRODUCT_DELIVERY" end={undefined} />,
    ));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledWith({
      type: 'PRODUCT_DELIVERY',
      customerId: 'customer-1',
      assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-08-16T10:00'),
      scheduledEndsAt: localDateTimeToIso('2026-08-16T10:30'),
      jobCardId: null,
    });
  });

  it('discards an in-flight response after the form state changes', async () => {
    let resolveFirst: ((value: { slots: [] }) => void) | undefined;
    let resolveSecond: ((value: { slots: [{ startsAt: string; endsAt: string }] }) => void) | undefined;
    jobs.findAvailableSlots
      .mockReturnValueOnce(new Promise<{ slots: [] }>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<{ slots: [{ startsAt: string; endsAt: string }] }>((resolve) => {
        resolveSecond = resolve;
      }));

    await act(async () => root.render(<Probe end="2026-08-16T11:00" />));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Probe start="2026-08-16T11:00" end="2026-08-16T12:00" />));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(2);

    await act(async () => { resolveFirst?.({ slots: [] }); });
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'searching', count: '0' });

    await act(async () => {
      resolveSecond?.({
        slots: [{ startsAt: '2026-08-18T11:00:00.000Z', endsAt: '2026-08-18T12:00:00.000Z' }],
      });
    });
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '1' });
  });
});
