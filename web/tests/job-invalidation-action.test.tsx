/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobInvalidationAction } from '../src/jobs/JobInvalidationAction';
import type { JobCard } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const job = {
  id: 'job-1', status: 'NEW', version: 7,
} as JobCard;

describe('JobInvalidationAction', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('keeps reason capture inline and opens exactly one confirmation dialog', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <JobInvalidationAction
          job={job}
          mutationState={{ kind: 'idle' }}
          onSubmit={onSubmit}
          onRecheck={() => {}}
          onRetry={() => {}}
        />,
      );
    });

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-job-invalidation-trigger]')?.click();
    });
    expect(host.querySelector('select[name="reasonCode"]')).not.toBeNull();
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(0);

    await act(async () => {
      host.querySelector<HTMLSelectElement>('select[name="reasonCode"]')!.value = 'DUPLICATE';
      host.querySelector<HTMLSelectElement>('select[name="reasonCode"]')!.dispatchEvent(new Event('change', { bubbles: true }));
      host.querySelector<HTMLButtonElement>('[data-job-invalidation-continue]')?.click();
    });
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(host.querySelectorAll('[role="dialog"] [role="dialog"]')).toHaveLength(0);

    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find((button) => button.textContent?.trim() === 'Geçersiz olarak işaretle')?.click();
    });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      jobCardId: 'job-1', expectedVersion: 7, sourceStatus: 'NEW', reasonCode: 'DUPLICATE',
      note: null,
    }));
  });

  it('requires a note for Diğer and never exposes a raw reason enum', async () => {
    await act(async () => {
      root.render(
        <JobInvalidationAction
          job={job}
          mutationState={{ kind: 'idle' }}
          onSubmit={() => {}}
          onRecheck={() => {}}
          onRetry={() => {}}
        />,
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-job-invalidation-trigger]')?.click();
    });
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[name="reasonCode"]')!;
      select.value = 'OTHER';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      host.querySelector<HTMLButtonElement>('[data-job-invalidation-continue]')?.click();
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain('Diğer nedeni için açıklama zorunludur.');
    expect(host.textContent).not.toContain('TRAINING_OR_TEST_RECORD');
  });

  it('keeps the single confirmation visible and disabled while submitting', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <JobInvalidationAction
          job={job}
          mutationState={{ kind: 'idle' }}
          onSubmit={onSubmit}
          onRecheck={() => {}}
          onRetry={() => {}}
        />,
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-job-invalidation-trigger]')?.click();
    });
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select[name="reasonCode"]')!;
      select.value = 'DUPLICATE';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      host.querySelector<HTMLButtonElement>('[data-job-invalidation-continue]')?.click();
    });
    const confirmButton = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.textContent?.trim() === 'Geçersiz olarak işaretle')!;
    await act(async () => {
      confirmButton.click();
      confirmButton.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        <JobInvalidationAction
          job={job}
          mutationState={{ kind: 'submitting', attempt: onSubmit.mock.calls[0][0] }}
          onSubmit={onSubmit}
          onRecheck={() => {}}
          onRetry={() => {}}
        />,
      );
    });
    expect(host.querySelector('[role="dialog"][aria-busy="true"]')).not.toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).every((button) => button.disabled)).toBe(true);
  });

  it('puts reconciliation behind a status check before allowing an explicit same-ID retry', async () => {
    const onRecheck = vi.fn();
    const attempt = {
      jobCardId: 'job-1', expectedVersion: 7, sourceStatus: 'NEW' as const,
      reasonCode: 'DUPLICATE' as const, note: null, clientActionId: 'action-1',
    };
    await act(async () => {
      root.render(
        <JobInvalidationAction
          job={job}
          mutationState={{
            kind: 'reconciling', attempt, checking: false,
            message: 'İşlem sonucu henüz kesinleşmedi.',
          }}
          onSubmit={() => {}}
          onRecheck={onRecheck}
          onRetry={() => {}}
        />,
      );
    });
    const controls = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-job-invalidation-recovery] button'));
    expect(controls[0]?.textContent).toContain('Durumu yeniden kontrol et');
    expect(host.querySelector('[data-job-invalidation-retry]')).toBeNull();
    await act(async () => controls[0]?.click());
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
