#!/usr/bin/env node
/**
 * auth-kdf-benchmark.mjs — bounded scrypt KDF benchmark for the #344 V2 decision.
 *
 * Compares three cost models on the SAME host (same-host ratios only):
 *   A — CURRENT PRODUCTION : one scrypt N=16384/r=8/p=1/keylen=64/maxmem=32MiB
 *   B — V2 DERIVATION      : one scrypt N=32768/r=8/p=1/keylen=64/maxmem=64MiB
 *   C — #344 FIXED BUDGET  : sequential A-slot then B-slot (two awaits, one op)
 *
 * Memory note: `maxmem` is an upper bound, NOT actual allocation. Node scrypt
 * working memory is approximately 128*N*r bytes (~16 MiB for N16384/r8,
 * ~32 MiB for N32768/r8). Actual RSS is measured empirically per cell.
 *
 * Safety: synthetic passwords only, no secrets, no database, no network.
 * Bounded workload: fixed warmup + iteration counts, 15 s per-op timeout,
 * cell abort on repeated failures, run abort on dangerously low Linux memory.
 * Never compare absolute milliseconds across machines — ratios only.
 *
 * Node built-ins only. No npm dependencies.
 *
 * Usage:
 *   node ops/benchmarks/auth-kdf-benchmark.mjs --mode=smoke
 *   node ops/benchmarks/auth-kdf-benchmark.mjs --mode=full \
 *     --controls=A,B,C --concurrency=1,2,4,8 --iterations=100 --warmup=10 \
 *     --output=./auth-kdf-results.json
 */

import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import process from 'node:process';
import os from 'node:os';

const SCHEMA = 'auth-kdf-benchmark/v1';
const OP_TIMEOUT_MS = 15_000;
const MIN_LINUX_AVAILABLE_KB = 256 * 1024;
const MAX_CELL_FAILURES = 10;
const PASSWORD_LENGTHS = [12, 20, 32, 64];

const CONTROLS = {
  A: {
    name: 'CURRENT_PRODUCTION',
    slots: [{ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 }],
  },
  B: {
    name: 'V2_DERIVATION',
    slots: [{ N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 }],
  },
  C: {
    name: 'FIXED_LOGIN_BUDGET',
    slots: [
      { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 },
      { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 },
    ],
  },
};

function parseArgs(argv) {
  const options = {
    mode: 'smoke',
    controls: ['A', 'B', 'C'],
    concurrency: [1, 2, 4, 8],
    iterations: 100,
    warmup: 10,
    output: '',
  };
  for (const arg of argv) {
    const [key, rawValue] = arg.split('=');
    const value = rawValue ?? '';
    if (key === '--mode' && (value === 'smoke' || value === 'full')) options.mode = value;
    else if (key === '--controls') {
      options.controls = value.split(',').map((c) => c.trim().toUpperCase())
        .filter((c) => CONTROLS[c]);
    } else if (key === '--concurrency') {
      options.concurrency = value.split(',').map((c) => Number.parseInt(c.trim(), 10))
        .filter((c) => Number.isInteger(c) && c >= 1 && c <= 64);
    } else if (key === '--iterations') options.iterations = Number.parseInt(value, 10);
    else if (key === '--warmup') options.warmup = Number.parseInt(value, 10);
    else if (key === '--output') options.output = value;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.mode === 'smoke') {
    options.controls = ['A', 'B', 'C'];
    options.concurrency = [1];
    options.iterations = 5;
    options.warmup = 2;
  }
  if (options.controls.length === 0) throw new Error('No valid controls selected.');
  if (options.concurrency.length === 0) throw new Error('No valid concurrency levels.');
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error('iterations must be a positive integer.');
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error('warmup must be a non-negative integer.');
  }
  return options;
}

function scryptOnce(password, salt, slot) {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, slot.keylen, {
      N: slot.N, r: slot.r, p: slot.p, maxmem: slot.maxmem,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`OP_TIMEOUT:${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One benchmark operation: all control slots SEQUENTIALLY. Never parallel. */
async function runOperation(control, slotSpans) {
  const password = randomBytes(
    PASSWORD_LENGTHS[Math.floor(Math.random() * PASSWORD_LENGTHS.length)],
  ).toString('base64url');
  for (const slot of control.slots) {
    const salt = randomBytes(16);
    const start = process.hrtime.bigint();
    await withTimeout(scryptOnce(password, salt, slot), OP_TIMEOUT_MS, `N${slot.N}`);
    const end = process.hrtime.bigint();
    if (slotSpans) slotSpans.push({ start, end });
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

function readLinuxMemAvailableKb() {
  try {
    if (process.platform !== 'linux' || !existsSync('/proc/meminfo')) return null;
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function readCgroupLimit(pathCandidates) {
  for (const path of pathCandidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, 'utf8').trim();
      if (raw === 'max') return 'unlimited';
      const value = Number.parseInt(raw, 10);
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      // ignore and try next candidate
    }
  }
  return null;
}

function collectEnvironment() {
  return {
    nodeVersion: process.version,
    arch: process.arch,
    platform: process.platform,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'default',
    linuxMemAvailableKb: readLinuxMemAvailableKb(),
    cgroupCpuLimit: readCgroupLimit([
      '/sys/fs/cgroup/cpu.max',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
    ]),
    cgroupMemoryLimitBytes: readCgroupLimit([
      '/sys/fs/cgroup/memory.max',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ]),
  };
}

async function runCell(controlKey, concurrency, iterations, warmup) {
  const control = CONTROLS[controlKey];
  for (let i = 0; i < warmup; i += 1) {
    await runOperation(control, null);
  }

  const heartbeatDriftMs = [];
  const heartbeatTimer = setInterval(() => {
    const start = Date.now();
    setImmediate(() => {
      heartbeatDriftMs.push(Date.now() - start);
    });
  }, 10);
  const eventLoopHistogram = monitorEventLoopDelay({ resolution: 10 });
  eventLoopHistogram.enable();

  const rssSamples = [];
  const rssSampler = setInterval(() => {
    rssSamples.push(process.memoryUsage().rss);
  }, 100);

  const durationsMs = [];
  let errors = 0;
  let timeouts = 0;
  let aborted = false;
  const rssBaseline = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  const wallStart = process.hrtime.bigint();

  try {
    let remaining = iterations;
    while (remaining > 0 && !aborted) {
      const batchSize = Math.min(concurrency, remaining);
      const batch = [];
      for (let i = 0; i < batchSize; i += 1) {
        const opStart = process.hrtime.bigint();
        batch.push(
          runOperation(control, null).then(
            () => {
              durationsMs.push(Number(process.hrtime.bigint() - opStart) / 1e6);
            },
            (error) => {
              errors += 1;
              if (String(error?.message ?? error).startsWith('OP_TIMEOUT')) timeouts += 1;
              if (errors >= MAX_CELL_FAILURES) aborted = true;
            },
          ),
        );
      }
      await Promise.all(batch);
      remaining -= batchSize;
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(rssSampler);
    eventLoopHistogram.disable();
  }

  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const cpuEnd = process.cpuUsage(cpuStart);
  const rssPost = process.memoryUsage().rss;

  return {
    control: controlKey,
    controlName: control.name,
    slots: control.slots.map((s) => ({ N: s.N, r: s.r, p: s.p, keylen: s.keylen, maxmem: s.maxmem })),
    concurrency,
    requestedOperations: iterations,
    completedOperations: durationsMs.length,
    aborted,
    totalDurationMs: wallMs,
    throughputOpsPerSec: durationsMs.length > 0 ? (durationsMs.length / wallMs) * 1000 : 0,
    latencyMs: summarize(durationsMs),
    cpuUserMs: cpuEnd.user / 1000,
    cpuSystemMs: cpuEnd.system / 1000,
    rssBaselineBytes: rssBaseline,
    rssPeakSampledBytes: rssSamples.length ? Math.max(...rssSamples) : rssPost,
    rssPostBytes: rssPost,
    eventLoopDelayMs: {
      p50: eventLoopHistogram.percentile(50) / 1e6,
      p95: eventLoopHistogram.percentile(95) / 1e6,
      p99: eventLoopHistogram.percentile(99) / 1e6,
      max: eventLoopHistogram.max / 1e6,
    },
    heartbeatDriftMs: summarize(heartbeatDriftMs),
    errors,
    timeouts,
  };
}

function checkLowMemory() {
  const availableKb = readLinuxMemAvailableKb();
  if (availableKb !== null && availableKb < MIN_LINUX_AVAILABLE_KB) {
    throw new Error(
      `LOW_MEMORY_ABORT: only ${availableKb} KiB available (floor ${MIN_LINUX_AVAILABLE_KB} KiB).`,
    );
  }
}

function computeRatios(cells) {
  const byControl = {};
  for (const cell of cells) {
    byControl[cell.control] ??= {};
    byControl[cell.control][cell.concurrency] = cell;
  }
  const ratios = [];
  const concurrencies = [...new Set(cells.map((c) => c.concurrency))].sort((a, b) => a - b);
  for (const concurrency of concurrencies) {
    const a = byControl.A?.[concurrency];
    const b = byControl.B?.[concurrency];
    const c = byControl.C?.[concurrency];
    const ratio = (num, den) => (num != null && den ? num / den : null);
    ratios.push({
      concurrency,
      latencyBOverA: {
        p50: ratio(b?.latencyMs.p50, a?.latencyMs.p50),
        p95: ratio(b?.latencyMs.p95, a?.latencyMs.p95),
        p99: ratio(b?.latencyMs.p99, a?.latencyMs.p99),
      },
      latencyCOverA: {
        p50: ratio(c?.latencyMs.p50, a?.latencyMs.p50),
        p95: ratio(c?.latencyMs.p95, a?.latencyMs.p95),
        p99: ratio(c?.latencyMs.p99, a?.latencyMs.p99),
      },
      latencyCOverB: {
        p50: ratio(c?.latencyMs.p50, b?.latencyMs.p50),
        p95: ratio(c?.latencyMs.p95, b?.latencyMs.p95),
        p99: ratio(c?.latencyMs.p99, b?.latencyMs.p99),
      },
      throughputBOverA: ratio(b?.throughputOpsPerSec, a?.throughputOpsPerSec),
      throughputCOverA: ratio(c?.throughputOpsPerSec, a?.throughputOpsPerSec),
      throughputCOverB: ratio(c?.throughputOpsPerSec, b?.throughputOpsPerSec),
      peakRssDeltaBytes: {
        BMinusA: (b && a) ? b.rssPeakSampledBytes - a.rssPeakSampledBytes : null,
        CMinusA: (c && a) ? c.rssPeakSampledBytes - a.rssPeakSampledBytes : null,
      },
    });
  }
  return ratios;
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function formatMs(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(1)} ms`;
}

function renderMarkdown(result) {
  const lines = [];
  lines.push('# auth-kdf-benchmark summary');
  lines.push('');
  lines.push(`- schema: \`${result.schema}\``);
  lines.push(`- commit: \`${result.commitSha}\``);
  lines.push(`- timestamp: \`${result.timestamp}\``);
  lines.push(`- mode: \`${result.options.mode}\`, iterations: \`${result.options.iterations}\`, warmup: \`${result.options.warmup}\``);
  const env = result.environment;
  lines.push(`- node: \`${env.nodeVersion}\`, arch: \`${env.arch}\`, platform: \`${env.platform}\`, kernel: \`${env.osRelease}\``);
  lines.push(`- cpus: \`${env.cpuCount}\`, total memory: \`${(env.totalMemoryBytes / 1024 ** 3).toFixed(2)} GiB\`, UV_THREADPOOL_SIZE: \`${env.uvThreadpoolSize}\``);
  lines.push(`- cgroup cpu limit: \`${String(env.cgroupCpuLimit)}\`, cgroup memory limit: \`${String(env.cgroupMemoryLimitBytes)}\`, mem available: \`${String(env.linuxMemAvailableKb)} KiB\``);
  lines.push('');
  lines.push('## Cells (same host only — never compare ms across machines)');
  lines.push('');
  lines.push('| control | conc | ops | total | ops/s | p50 | p95 | p99 | max | err | timeout | peak RSS | ELD p99 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const cell of result.cells) {
    lines.push(`| ${cell.control} | ${cell.concurrency} | ${cell.completedOperations}/${cell.requestedOperations}${cell.aborted ? ' ABORTED' : ''} | ${formatMs(cell.totalDurationMs)} | ${formatNumber(cell.throughputOpsPerSec)} | ${formatMs(cell.latencyMs.p50)} | ${formatMs(cell.latencyMs.p95)} | ${formatMs(cell.latencyMs.p99)} | ${formatMs(cell.latencyMs.max)} | ${cell.errors} | ${cell.timeouts} | ${(cell.rssPeakSampledBytes / 1024 ** 2).toFixed(1)} MiB | ${formatMs(cell.eventLoopDelayMs.p99)} |`);
  }
  lines.push('');
  lines.push('## Same-host ratios');
  lines.push('');
  lines.push('| conc | B/A p50 | B/A p95 | C/A p50 | C/A p95 | C/B p50 | tput B/A | tput C/A | RSS B-A | RSS C-A |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const ratio of result.ratios) {
    const mib = (v) => (v === null ? 'n/a' : `${(v / 1024 ** 2).toFixed(1)} MiB`);
    lines.push(`| ${ratio.concurrency} | ${formatNumber(ratio.latencyBOverA.p50)} | ${formatNumber(ratio.latencyBOverA.p95)} | ${formatNumber(ratio.latencyCOverA.p50)} | ${formatNumber(ratio.latencyCOverA.p95)} | ${formatNumber(ratio.latencyCOverB.p50)} | ${formatNumber(ratio.throughputBOverA)} | ${formatNumber(ratio.throughputCOverA)} | ${mib(ratio.peakRssDeltaBytes.BMinusA)} | ${mib(ratio.peakRssDeltaBytes.CMinusA)} |`);
  }
  lines.push('');
  if (result.smokeAssertions) {
    lines.push('## Smoke assertions');
    lines.push('');
    for (const assertion of result.smokeAssertions) {
      lines.push(`- [${assertion.pass ? 'PASS' : 'FAIL'}] ${assertion.name}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function runSmokeAssertions(cells) {
  const assertions = [];
  const check = (name, pass) => assertions.push({ name, pass: Boolean(pass) });
  const find = (control) => cells.find((c) => c.control === control);
  const a = find('A');
  const b = find('B');
  const c = find('C');
  check('N16384 control succeeds with zero errors', a && a.errors === 0 && a.completedOperations > 0);
  check('N32768 control succeeds with zero errors', b && b.errors === 0 && b.completedOperations > 0);
  check('fixed-work control succeeds with zero errors', c && c.errors === 0 && c.completedOperations > 0);
  // Structural proof: C performs exactly two sequential slots (slot2 starts at/after slot1 ends).
  let sequential = false;
  let twoSlots = false;
  try {
    const spans = [];
    await runOperation(CONTROLS.C, spans);
    twoSlots = spans.length === 2;
    sequential = twoSlots && spans[1].start >= spans[0].end;
  } catch {
    sequential = false;
  }
  check('fixed-work performs exactly two slots', twoSlots);
  check('fixed-work slots run sequentially (slot2 starts at/after slot1 ends)', sequential);
  const schemaKeys = ['control', 'latencyMs', 'throughputOpsPerSec', 'eventLoopDelayMs', 'errors', 'timeouts'];
  check('output schema carries all required cell fields', cells.every((cell) => schemaKeys.every((k) => k in cell)));
  check('no timeouts recorded', cells.every((cell) => cell.timeouts === 0));
  return assertions;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commitSha = process.env.BENCHMARK_COMMIT_SHA ?? 'local-uncommitted';
  const environment = collectEnvironment();
  const cells = [];
  let stoppedEarly = null;

  for (const concurrency of options.concurrency) {
    for (const controlKey of options.controls) {
      try {
        checkLowMemory();
      } catch (error) {
        stoppedEarly = String(error?.message ?? error);
        break;
      }
      const cell = await runCell(controlKey, concurrency, options.iterations, options.warmup);
      cells.push(cell);
      if (cell.aborted) {
        stoppedEarly = `cell aborted: control ${controlKey} concurrency ${concurrency} hit the failure ceiling`;
        break;
      }
    }
    if (stoppedEarly) break;
  }

  const result = {
    schema: SCHEMA,
    commitSha,
    timestamp: new Date().toISOString(),
    options: {
      mode: options.mode,
      controls: options.controls,
      concurrency: options.concurrency,
      iterations: options.iterations,
      warmup: options.warmup,
    },
    environment,
    cells,
    ratios: computeRatios(cells),
    stoppedEarly,
    smokeAssertions: options.mode === 'smoke' ? await runSmokeAssertions(cells) : null,
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = renderMarkdown(result);
  if (options.output) {
    writeFileSync(options.output, json);
    const markdownPath = options.output.replace(/\.json$/i, '') + '.md';
    writeFileSync(options.output.endsWith('.json') ? markdownPath : `${options.output}.md`, markdown);
    process.stdout.write(`wrote ${options.output}\n`);
  } else {
    process.stdout.write(json);
  }

  if (result.smokeAssertions) {
    const failed = result.smokeAssertions.filter((a) => !a.pass);
    if (failed.length > 0 || stoppedEarly) {
      process.stderr.write(`SMOKE_FAILED: ${failed.map((f) => f.name).join('; ')}${stoppedEarly ? `; ${stoppedEarly}` : ''}\n`);
      process.exitCode = 1;
    }
  } else if (stoppedEarly) {
    process.stderr.write(`BENCHMARK_STOPPED_EARLY: ${stoppedEarly}\n`);
    process.exitCode = 1;
  }
}

await main();
