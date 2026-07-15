export type ShutdownDeps = {
  closeApp: () => Promise<void>;
  closeDb: () => Promise<void>;
  timeoutMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  exit?: (code: number) => void;
};

export function createShutdown(deps: ShutdownDeps) {
  let shuttingDown = false;
  const timeoutMs = deps.timeoutMs ?? 25_000;
  const exit = deps.exit ?? ((code: number) => {
    process.exitCode = code;
  });
  const log = deps.log ?? (() => undefined);

  return async function shutdown(signal: string) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log('Shutting down', { signal });

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await deps.closeApp();
          await deps.closeDb();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Shutdown timed out')), timeoutMs);
        }),
      ]);
      exit(0);
    } catch (error) {
      log('Shutdown failed', { err: error });
      try {
        await deps.closeDb();
      } catch {
        // best-effort pool close after timeout/failure
      }
      exit(1);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
