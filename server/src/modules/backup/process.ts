import { execFile } from 'node:child_process';

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: string | number | null,
    readonly stdoutTail: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

const MAX_BUFFER = 1_000_000;
const OUTPUT_TAIL = 500;

export function tail(value: string): string {
  return value.length <= OUTPUT_TAIL ? value : value.slice(-OUTPUT_TAIL);
}

/** Scrub secret-shaped substrings (URLs with credentials, pgpass lines) from
 * diagnostics that may be logged or returned to callers. */
export function scrubDiagnostics(value: string): string {
  return value
    .replaceAll(/\r/g, '')
    .replace(/postgres(ql)?:\/\/[^\s]+/gi, '<redacted-url>')
    .replace(/(password|pgpassword|passfile)\s*[=:]\s*\S+/gi, '<redacted>');
}

export type RunBinaryOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Argv-safe binary execution: execFile never spawns a shell, so no path,
 * identifier, or option is ever interpolated through shell syntax. Output is
 * bounded; failures carry only scrubbed, tail-bounded diagnostics.
 */
export function runBinary(
  binary: string,
  args: readonly string[],
  options: RunBinaryOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        shell: false,
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: MAX_BUFFER,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: string | number }).code ?? null;
          reject(new ProcessError(
            `${binary} failed`,
            typeof code === 'string' || typeof code === 'number' ? code : null,
            scrubDiagnostics(tail(String(stdout ?? ''))),
            scrubDiagnostics(tail(String(stderr ?? ''))),
          ));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Resolve an external tool the way repository scripts/tests do: explicit
 * env override first (e.g. PG_DUMP_BIN), PATH lookup otherwise. */
export function resolveBinary(envValue: string | undefined, fallback: string): string {
  const trimmed = envValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export type ParsedToolVersion = { major: number; minor: number; raw: string };

/** Parse tool version output such as `pg_dump (PostgreSQL) 16.13` into a
 * numeric major/minor pair. */
export function parseToolVersion(raw: string, tool: string): ParsedToolVersion {
  const match = raw.match(/(\d+)\.(\d+)/);
  if (!match) throw new Error(`unable to parse ${tool} version`);
  return { major: Number(match[1]), minor: Number(match[2]), raw: raw.trim() };
}
