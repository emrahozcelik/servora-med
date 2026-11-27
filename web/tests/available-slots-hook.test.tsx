/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAvailableSlotSearch } from '../src/jobs/useAvailableSlotSearch';
import { isoInstantToLocalDateTime, localDateTimeToIso } from '../src/jobs/scheduling';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobs = vi.hoisted(() => ({ findAvailableSlots: vi.fn() }));
vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(),
  findAvailableSlots: jobs.findAvailableSlots,
}));

function Probe({
  type = 'SALES_MEETING',
  assignedTo = 'staff-1',
  start = '2026-08-16T10:00',
  jobCardId = null,
}: {
  type?: 'SALES_MEETING' | 'PRODUCT_DELIVERY';
  assignedTo?: string;
  start?: string;
  jobCardId?: string | null;
}) {
  const result = useAvailableSlotSearch({
    type,
    customerId: 'customer-1',
    assignedTo,
    scheduledStartLocal: start,
    jobCardId,
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
    await act(async () => root.render(<Probe />));
    expect(jobs.findAvailableSlots).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledWith({
      type: 'SALES_MEETING',
      customerId: 'customer-1',
      assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-08-16T10:00'),
      jobCardId: null,
    });
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '1' });
  });

  it('omits the client-computed end so the server owns new-job duration', async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledWith({
      type: 'SALES_MEETING',
      customerId: 'customer-1',
      assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-08-16T10:00'),
      jobCardId: null,
    });
  });

  it('lets the server derive Product Delivery duration when end is omitted', async () => {
    await act(async () => root.render(<Probe type="PRODUCT_DELIVERY" />));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledWith({
      type: 'PRODUCT_DELIVERY',
      customerId: 'customer-1',
      assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-08-16T10:00'),
      jobCardId: null,
    });
  });

  it('omits a stale persisted end when an existing job start moves', async () => {
    await act(async () => root.render(<Probe start="2026-08-16T13:00" jobCardId="job-1" />));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledWith({
      type: 'SALES_MEETING',
      customerId: 'customer-1',
      assignedTo: 'staff-1',
      scheduledAt: localDateTimeToIso('2026-08-16T13:00'),
      jobCardId: 'job-1',
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

    await act(async () => root.render(<Probe />));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Probe start="2026-08-16T11:00" />));
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

  it('keeps returned slots and skips re-querying when scheduledStartLocal moves to a returned slot within the same scope', async () => {
    const slotA = { startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T11:00:00.000Z' };
    const slotB = { startsAt: '2026-08-18T14:00:00.000Z', endsAt: '2026-08-18T15:00:00.000Z' };
    jobs.findAvailableSlots.mockResolvedValue({ slots: [slotA, slotB] });

    await act(async () => root.render(<Probe />));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '2' });

    // Selecting slotA updates scheduledStartLocal without wiping slots or firing a search.
    await act(async () => root.render(<Probe start={isoInstantToLocalDateTime(slotA.startsAt)} />));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '2' });

    // Switching to slotB within the same scope also preserves slots without re-querying.
    await act(async () => root.render(<Probe start={isoInstantToLocalDateTime(slotB.startsAt)} />));
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '2' });

    // Changing scope (assignedTo) re-queries even while scheduledStartLocal matches slotB.
    await act(async () => root.render(
      <Probe assignedTo="staff-2" start={isoInstantToLocalDateTime(slotB.startsAt)} />,
    ));
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'searching', count: '0' });
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(2);
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'ready', count: '2' });

    // Manually editing scheduledStartLocal to a non-slot time clears and re-searches normally.
    await act(async () => root.render(<Probe assignedTo="staff-2" start="2026-08-19T09:30" />));
    expect(container.querySelector('output')?.dataset).toMatchObject({ state: 'searching', count: '0' });
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { await Promise.resolve(); });

    expect(jobs.findAvailableSlots).toHaveBeenCalledTimes(3);
  });
});
