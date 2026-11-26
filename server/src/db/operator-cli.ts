import { randomInt } from 'node:crypto';
import type { Pool } from 'pg';

import { AppError } from '../errors/index.js';
import { validateNewPassword } from '../modules/auth/crypto.js';
import { PostgresOperatorRepository } from '../modules/operator/repository.js';
import {
  operatorTablesExist,
  resetOperatorAccessAfterRestore,
} from '../modules/operator/restore-reset.js';
import { OperatorService } from '../modules/operator/service.js';
import { staticModuleStateReader } from '../modules/installation-modules/state.js';

/**
 * Host CLI for installation operators (MOD-002 contract §4). Passwords are
 * read only from a no-echo TTY prompt or `--password-stdin`; never from argv or
 * env. A generated password is offered only on an interactive TTY and printed
 * once there. Mutating commands write an operator audit event (actor HOST_CLI)
 * in the same transaction as the change.
 */
export type OperatorCliIo = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
};

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const MAX_STDIN_PASSWORD_BYTES = 1_024;

const USAGE = `Usage:
  operator grant --email <email> --name <name> [--password-stdin]
  operator reset-password --email <email> [--password-stdin]
  operator revoke --email <email>
  operator list
  operator reset-after-restore

Passwords are never accepted on the command line or in the environment. Without
--password-stdin an interactive terminal prompts without echo; an empty answer
accepts a generated password, printed once.
`;

class UsageError extends Error {}

type ParsedArgs = {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
};

const VALUE_OPTIONS = new Set(['email', 'name']);
const FLAG_OPTIONS = new Set(['password-stdin']);
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  grant: ['email', 'name', 'password-stdin'],
  'reset-password': ['email', 'password-stdin'],
  revoke: ['email'],
  list: [],
  'reset-after-restore': [],
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !(command in COMMAND_OPTIONS)) throw new UsageError('Unknown or missing command.');
  const allowed = COMMAND_OPTIONS[command]!;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    // Never echo the value: a positional argument may be a mistyped password.
    if (!token.startsWith('--')) throw new UsageError('Unexpected positional argument (value not shown).');
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (!allowed.includes(rawName)) throw new UsageError(`Unknown option: --${rawName}`);
    if (FLAG_OPTIONS.has(rawName)) {
      if (inlineValue !== undefined) throw new UsageError(`--${rawName} does not take a value.`);
      flags.add(rawName);
    } else if (VALUE_OPTIONS.has(rawName)) {
      const value = inlineValue ?? rest[++index];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${rawName} requires a value.`);
      values.set(rawName, value);
    }
  }
  return { command, values, flags };
}

function required(args: ParsedArgs, name: string): string {
  const value = args.values.get(name)?.trim();
  if (!value) throw new UsageError(`--${name} is required.`);
  return value;
}

/** Random password that always satisfies the new-password policy. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const symbols = '!#$%&*+-=?@^_';
  for (;;) {
    let candidate = '';
    for (let index = 0; index < 20; index += 1) candidate += alphabet[randomInt(alphabet.length)];
    candidate += symbols[randomInt(symbols.length)];
    try {
      validateNewPassword(candidate);
      return candidate;
    } catch {
      // Missing a class by chance; draw again.
    }
  }
}

async function readAllStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_STDIN_PASSWORD_BYTES) throw new UsageError('Password input is too long.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

type RawCapableStdin = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
};

/** Sequential no-echo line prompts; bytes after a newline stay buffered for the next prompt. */
function createHiddenPrompter(io: OperatorCliIo) {
  const stdin = io.stdin as RawCapableStdin;
  let pending = '';
  let skipLineFeed = false;
  return (label: string): Promise<string> => new Promise((resolve, reject) => {
    let value = '';
    io.stdout.write(label);

    const finish = (outcome: () => void) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.setRawMode?.(false);
      stdin.pause?.();
      io.stdout.write('\n');
      outcome();
    };
    const consume = (text: string): boolean => {
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]!;
        if (skipLineFeed && char === '\n') { skipLineFeed = false; continue; }
        skipLineFeed = false;
        if (char === '\r' || char === '\n') {
          skipLineFeed = char === '\r';
          pending = text.slice(index + 1);
          finish(() => resolve(value));
          return true;
        }
        if (char === '\u0003') {
          finish(() => reject(new UsageError('Aborted.')));
          return true;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
      return false;
    };
    const onData = (chunk: Buffer | string) => { consume(chunk.toString('utf8')); };
    const onEnd = () => finish(() => reject(new UsageError('Input ended before the password was entered.')));

    stdin.setRawMode?.(true);
    stdin.resume?.();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    if (pending) {
      const buffered = pending;
      pending = '';
      consume(buffered);
    }
  });
}

async function obtainPassword(
  args: ParsedArgs,
  io: OperatorCliIo,
): Promise<{ password: string; generated: boolean }> {
  if (args.flags.has('password-stdin')) {
    const password = await readAllStdin(io.stdin);
    if (!password) throw new UsageError('No password received on stdin.');
    return { password, generated: false };
  }
  if (!io.isTTY) {
    throw new UsageError('No interactive terminal: provide the password with --password-stdin.');
  }
  const ask = createHiddenPrompter(io);
  const password = await ask('New password (leave empty to generate one): ');
  if (!password) return { password: generatePassword(), generated: true };
  if (password !== await ask('Repeat password: ')) throw new UsageError('Passwords do not match.');
  return { password, generated: false };
}

function describeFailure(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  if (error instanceof UsageError) return error.message;
  return 'Operation failed.';
}

async function resetAfterRestore(pool: Pool, io: OperatorCliIo): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await operatorTablesExist(client))) {
      await client.query('ROLLBACK');
      io.stdout.write('Skipped: no operator tables (schema older than migration 074).\n');
      return;
    }
    const result = await resetOperatorAccessAfterRestore(client, new Date());
    await client.query('COMMIT');
    io.stdout.write(
      `Operator access reset: ${result.deactivatedAccounts} account(s) deactivated, ${result.revokedSessions} session(s) revoked.\n`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function runOperatorCli(argv: string[], io: OperatorCliIo, pool: Pool): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof UsageError ? error.message : 'Invalid arguments.'}\n${USAGE}`);
    return EXIT_USAGE;
  }

  // The CLI never reads module state; the reader only satisfies the service shape.
  const service = new OperatorService(
    new PostgresOperatorRepository(pool),
    staticModuleStateReader(false),
  );
  try {
    switch (args.command) {
      case 'grant': {
        const email = required(args, 'email');
        const name = required(args, 'name');
        const { password, generated } = await obtainPassword(args, io);
        const result = await service.grantOperator({ email, name, password });
        io.stdout.write(`${result.reactivated ? 'Reactivated' : 'Granted'} operator ${result.email} (MODULE_MANAGEMENT).\n`);
        if (generated) io.stdout.write(`Generated password (shown once): ${password}\n`);
        break;
      }
      case 'reset-password': {
        const email = required(args, 'email');
        const { password, generated } = await obtainPassword(args, io);
        const result = await service.resetPassword({ email, password });
        io.stdout.write(`Password reset for ${result.email}; ${result.revokedSessions} session(s) revoked.\n`);
        if (generated) io.stdout.write(`Generated password (shown once): ${password}\n`);
        break;
      }
      case 'revoke': {
        const result = await service.revokeOperator({ email: required(args, 'email') });
        io.stdout.write(result.alreadyInactive
          ? `Operator ${result.email} is already inactive.\n`
          : `Revoked operator ${result.email}; ${result.revokedSessions} session(s) revoked.\n`);
        break;
      }
      case 'list': {
        for (const entry of await service.listOperators()) {
          io.stdout.write([
            entry.email,
            entry.name,
            entry.isActive ? 'active' : 'inactive',
            entry.capabilities.join(',') || '-',
            entry.lastLoginAt ? entry.lastLoginAt.toISOString().slice(0, 10) : '-',
          ].join('\t') + '\n');
        }
        break;
      }
      case 'reset-after-restore':
        await resetAfterRestore(pool, io);
        break;
    }
    return EXIT_OK;
  } catch (error) {
    io.stderr.write(`${describeFailure(error)}\n`);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
  }
}
