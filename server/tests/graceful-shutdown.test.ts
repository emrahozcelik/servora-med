import { describe, expect, it, vi } from 'vitest';

import { createShutdown } from '../src/shutdown.js';

describe('createShutdown', () => {
  it('closes app and db once and exits 0', async () => {
    const closeApp = vi.fn(async () => undefined);
    const closeDb = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({ closeApp, closeDb, exit, timeoutMs: 1_000 });

    await shutdown('SIGTERM');
    await shutdown('SIGTERM');

    expect(closeApp).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when close times out', async () => {
    const closeApp = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const closeDb = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({
      closeApp,
      closeDb,
      exit,
      timeoutMs: 5,
    });

    await shutdown('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    expect(closeDb).toHaveBeenCalled();
  });

  it('exits 1 when closeApp fails', async () => {
    const closeApp = vi.fn(async () => {
      throw new Error('close failed');
    });
    const closeDb = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({ closeApp, closeDb, exit, timeoutMs: 1_000 });

    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
    expect(closeDb).toHaveBeenCalled();
  });
});
