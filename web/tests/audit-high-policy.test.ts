import { describe, it, expect } from 'vitest';
import { evaluateAudit } from '../scripts/audit-high-policy-lib.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeVuln(overrides: Record<string, unknown> = {}) {
  return {
    name: 'some-pkg',
    severity: 'low',
    via: [],
    effects: [],
    range: '*',
    ...overrides,
  };
}

function makeReport(
  vulnerabilities: Record<string, unknown>,
  counters: { info?: number; low?: number; moderate?: number; high?: number; critical?: number } = {},
) {
  const { info = 0, low = 0, moderate = 0, high = 0, critical = 0 } = counters;
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info,
        low,
        moderate,
        high,
        critical,
        total: info + low + moderate + high + critical,
      },
    },
  });
}

// ─── P3-A — clean ─────────────────────────────────────────────────────────

describe('P3-A — clean report', () => {
  it('valid zero-vulnerability report → PASS / exit 0', () => {
    const result = evaluateAudit(makeReport({}));
    expect(result.pass).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('PASS');
  });
});

// ─── P3-B / P3-C — low / moderate only ────────────────────────────────────

describe('P3-B/C — low and moderate only', () => {
  it('valid LOW entry → PASS', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'low' }) }, { low: 1 }),
    );
    expect(result.pass).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('valid MODERATE entry → PASS', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'moderate' }) }, { moderate: 1 }),
    );
    expect(result.pass).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

// ─── P3-D / P3-E — high / critical ────────────────────────────────────────

describe('P3-D/E — high and critical', () => {
  it('valid HIGH entry → FAIL / exit 1', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'high' }) }, { high: 1 }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('FAIL');
  });

  it('valid CRITICAL entry → FAIL / exit 1', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'critical' }) }, { critical: 1 }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('FAIL');
  });
});

// ─── P3-F — formerly exempted shape ───────────────────────────────────────

describe('P3-F — formerly exempted advisory shape', () => {
  it('react-router HIGH chain that previously passed → FAIL with no exception path', () => {
    // Mirrors the real-world react-router-dom → react-router HIGH shape.
    // Advisory identity is irrelevant now: any HIGH fails.
    const vulnerabilities = {
      'react-router': makeVuln({
        name: 'react-router',
        severity: 'high',
        via: [
          {
            source: 1124282,
            name: 'react-router',
            title: 'formerly exempted advisory',
            url: 'https://example.com/advisories/formerly-exempted',
            severity: 'high',
            cwe: ['CWE-352'],
            cvss: { score: 0, vectorString: null },
            range: '>=7.12.0 <8.3.0',
          },
        ],
        effects: ['react-router-dom'],
        range: '7.12.0 - 8.2.0',
      }),
      'react-router-dom': makeVuln({
        name: 'react-router-dom',
        severity: 'high',
        via: ['react-router'],
        effects: [],
        range: '>=7.12.0-pre.0',
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, { high: 2 }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

// ─── P3-G — malformed JSON ────────────────────────────────────────────────

describe('P3-G — malformed JSON', () => {
  it('unparseable JSON → FAIL CLOSED', () => {
    const result = evaluateAudit('{{{ broken json }}');
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('fail-closed');
  });
});

// ─── P3-H — unsupported report version ────────────────────────────────────

describe('P3-H — unsupported report version', () => {
  it('version 1 → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({ auditReportVersion: 1, vulnerabilities: {}, metadata: {} }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('unsupported auditReportVersion');
  });

  it('version "2" string → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({ auditReportVersion: '2', vulnerabilities: {}, metadata: {} }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('unsupported auditReportVersion');
  });
});

// ─── P3-I — missing vulnerabilities ───────────────────────────────────────

describe('P3-I — missing vulnerabilities', () => {
  it('vulnerabilities key absent → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: { high: 0, critical: 0 } } }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('vulnerabilities null → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: null,
        metadata: { vulnerabilities: { high: 0, critical: 0 } },
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

// ─── P3-J — missing metadata ──────────────────────────────────────────────

describe('P3-J — missing metadata', () => {
  it('metadata absent → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata missing');
  });

  it('metadata null → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: null }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata missing');
  });

  it('metadata.vulnerabilities absent → FAIL', () => {
    const result = evaluateAudit(
      JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata.vulnerabilities missing');
  });
});

// ─── P3-K — invalid metadata counter ──────────────────────────────────────

describe('P3-K — invalid metadata counter', () => {
  function reportWithCounters(counters: Record<string, unknown>) {
    return JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: counters },
    });
  }

  const base = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };

  it('negative counter → FAIL', () => {
    const result = evaluateAudit(reportWithCounters({ ...base, high: -1 }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('non-integer counter → FAIL', () => {
    const result = evaluateAudit(reportWithCounters({ ...base, high: 1.5 }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('string counter → FAIL', () => {
    const result = evaluateAudit(reportWithCounters({ ...base, high: 'two' }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('NaN counter (serializes to null) → FAIL', () => {
    const result = evaluateAudit(reportWithCounters({ ...base, high: NaN }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

// ─── P3-L / P3-M — metadata mismatch ──────────────────────────────────────

describe('P3-L/M — metadata high/critical mismatch', () => {
  it('metadata high=0 but HIGH entry exists → FAIL', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'high' }) }, { high: 0 }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });

  it('metadata high>0 but no HIGH entries → FAIL', () => {
    const result = evaluateAudit(makeReport({}, { high: 2 }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });

  it('metadata critical=0 but CRITICAL entry exists → FAIL', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'critical' }) }, { critical: 0 }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });

  it('metadata critical>0 but no CRITICAL entries → FAIL', () => {
    const result = evaluateAudit(makeReport({}, { critical: 1 }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });
});

// ─── P3-N — unknown severity with zero high/critical ──────────────────────

describe('P3-N — unknown severity with metadata high=0/critical=0', () => {
  it('severity "extreme" → FAIL (no early clean PASS)', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'extreme' }) }, {}),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

// ─── P3-O — malformed low/moderate entry ──────────────────────────────────

describe('P3-O — malformed low/moderate entry', () => {
  it('LOW entry with non-array via → FAIL', () => {
    const result = evaluateAudit(
      makeReport({ 'some-pkg': makeVuln({ name: 'some-pkg', severity: 'low', via: 'not-an-array' }) }, { low: 1 }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('MODERATE entry with missing effects → FAIL', () => {
    const vuln = makeVuln({ name: 'some-pkg', severity: 'moderate' });
    delete (vuln as Record<string, unknown>).effects;
    const result = evaluateAudit(makeReport({ 'some-pkg': vuln }, { moderate: 1 }));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

// ─── P3-P — key/name mismatch ─────────────────────────────────────────────

describe('P3-P — key/name mismatch', () => {
  it('map key differs from entry name → FAIL', () => {
    const result = evaluateAudit(
      makeReport({ 'pkg-a': makeVuln({ name: 'pkg-b', severity: 'low' }) }, { low: 1 }),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('key/name mismatch');
  });
});

// ─── P3-Q — unusable command output ───────────────────────────────────────

describe('P3-Q — unusable command output', () => {
  it('empty string output → FAIL (never PASS)', () => {
    const result = evaluateAudit('');
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('"null" output → FAIL (never PASS)', () => {
    const result = evaluateAudit('null');
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});


// ─── SECURITY-2026-11-18 — one GHSA, only dev, expires automatically ───────

const PICOMATCH_GHSA = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const approvedTime = new Date('2026-11-18T12:00:00Z');

function picomatchReport(extra: Record<string, unknown> = {}) {
  const vulnerabilities = {
    picomatch: makeVuln({
      name: 'picomatch',
      severity: 'high',
      via: [{ name: 'picomatch', severity: 'high', url: PICOMATCH_GHSA }],
      effects: ['fdir', 'vite', 'vitest'],
    }),
    fdir: makeVuln({ name: 'fdir', severity: 'high', via: ['picomatch'] }),
    tinyglobby: makeVuln({ name: 'tinyglobby', severity: 'high', via: ['fdir', 'picomatch'] }),
    vite: makeVuln({ name: 'vite', severity: 'high', via: ['picomatch', 'tinyglobby'] }),
    vitest: makeVuln({ name: 'vitest', severity: 'high', via: ['vite', 'picomatch', '@vitest/mocker'] }),
    '@vitest/mocker': makeVuln({ name: '@vitest/mocker', severity: 'high', via: ['vite'] }),
    ...extra,
  };
  const high = Object.values(vulnerabilities).filter(v => (v as { severity: string }).severity === 'high').length;
  const critical = Object.values(vulnerabilities).filter(v => (v as { severity: string }).severity === 'critical').length;
  return makeReport(vulnerabilities, { high, critical });
}

function approvedLockfile() {
  return {
    lockfileVersion: 3,
    packages: Object.fromEntries([
      'picomatch', 'fdir', 'tinyglobby', 'vite', 'vitest', '@vitest/mocker', '@vitejs/plugin-react',
    ].map(name => ['node_modules/' + name, { version: name === 'picomatch' ? '4.0.7' : '1.0.0', dev: true }])),
  };
}

function evaluateException(report = picomatchReport(), lockfile: unknown = approvedLockfile(), now = approvedTime) {
  return evaluateAudit(report, { picomatchException: true, lockfile, now });
}

describe('SECURITY-2026-11-18 — strict temporary picomatch exception', () => {
  it('allows the exact advisory and only dev-only transitive high chain', () => {
    const result = evaluateException();
    expect(result.pass).toBe(true);
    expect(result.message).toContain('PASS WITH TEMPORARY SECURITY EXCEPTION');
    expect(result.message).toContain('GHSA-fc5q-39xc-vjpf');
    expect(result.message).toContain('2 December 2026');
  });

  it('accepts web plugin-react only as a verified additional high descendant', () => {
    const withPlugin = picomatchReport({
      '@vitejs/plugin-react': makeVuln({ name: '@vitejs/plugin-react', severity: 'high', via: ['vite'] }),
    });
    expect(evaluateException(withPlugin).pass).toBe(true);
  });

  it('does not enable an exception for the generic parser without explicit options', () => {
    expect(evaluateAudit(picomatchReport()).pass).toBe(false);
  });

  it('rejects a second HIGH on an unrelated package', () => {
    const report = picomatchReport({
      react: makeVuln({ name: 'react', severity: 'high', via: [{ name: 'react', severity: 'high', url: PICOMATCH_GHSA }] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects a CRITICAL even when the picomatch chain is otherwise eligible', () => {
    const report = picomatchReport({
      rogue: makeVuln({ name: 'rogue', severity: 'critical', via: [] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects an additional direct advisory on picomatch', () => {
    const report = picomatchReport({
      picomatch: makeVuln({ name: 'picomatch', severity: 'high', via: [
        { name: 'picomatch', severity: 'high', url: PICOMATCH_GHSA },
        { name: 'picomatch', severity: 'high', url: 'https://github.com/advisories/GHSA-other' },
      ] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects wrong advisory URL even with the picomatch package name', () => {
    const report = picomatchReport({
      picomatch: makeVuln({ name: 'picomatch', severity: 'high', via: [
        { name: 'picomatch', severity: 'high', url: 'https://github.com/advisories/GHSA-fake' },
      ] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects a transitive package with an additional direct advisory', () => {
    const report = picomatchReport({
      vite: makeVuln({ name: 'vite', severity: 'high', via: [
        'picomatch', { name: 'vite', severity: 'high', url: 'https://github.com/advisories/GHSA-other' },
      ] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects a chain that does not lead to picomatch', () => {
    const report = picomatchReport({
      vite: makeVuln({ name: 'vite', severity: 'high', via: ['missing'] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects a cyclic advisory chain', () => {
    const report = picomatchReport({
      vite: makeVuln({ name: 'vite', severity: 'high', via: ['tinyglobby'] }),
      tinyglobby: makeVuln({ name: 'tinyglobby', severity: 'high', via: ['vite'] }),
    });
    expect(evaluateException(report).pass).toBe(false);
  });

  it('rejects any affected package marked production in the lockfile', () => {
    const lock = approvedLockfile();
    lock.packages['node_modules/picomatch'].dev = false;
    expect(evaluateException(picomatchReport(), lock).pass).toBe(false);
  });

  it('rejects an affected transitive package marked production', () => {
    const lock = approvedLockfile();
    lock.packages['node_modules/vite'].dev = false;
    expect(evaluateException(picomatchReport(), lock).pass).toBe(false);
  });

  it('rejects missing lockfile, missing package and wrong lockfile format', () => {
    expect(evaluateException(picomatchReport(), null).pass).toBe(false);
    expect(evaluateException(picomatchReport(), { lockfileVersion: 2, packages: {} }).pass).toBe(false);
    const lock = approvedLockfile();
    delete (lock.packages as Record<string, unknown>)['node_modules/fdir'];
    expect(evaluateException(picomatchReport(), lock).pass).toBe(false);
  });

  it('rejects a picomatch version outside the reviewed affected range', () => {
    const lock = approvedLockfile();
    lock.packages['node_modules/picomatch'].version = '4.1.0';
    expect(evaluateException(picomatchReport(), lock).pass).toBe(false);
  });

  it('is valid through 2 December 2026 Istanbul but expires at the following midnight', () => {
    expect(evaluateException(picomatchReport(), approvedLockfile(), new Date('2026-12-02T20:59:59Z')).pass).toBe(true);
    expect(evaluateException(picomatchReport(), approvedLockfile(), new Date('2026-12-02T21:00:00Z')).pass).toBe(false);
  });

  it('fails closed when clock is invalid or before the approval window', () => {
    expect(evaluateException(picomatchReport(), approvedLockfile(), new Date(NaN)).pass).toBe(false);
    expect(evaluateException(picomatchReport(), approvedLockfile(), new Date('2026-11-17T15:00:00Z')).pass).toBe(false);
  });

  it('fails closed for metadata inconsistencies and malformed JSON', () => {
    const bad = JSON.parse(picomatchReport());
    bad.metadata.vulnerabilities.high = 1;
    expect(evaluateException(JSON.stringify(bad)).pass).toBe(false);
    expect(evaluateException('{').pass).toBe(false);
  });

  it('production audit is always evaluated without the exception', () => {
    expect(evaluateAudit(makeReport({})).pass).toBe(true);
    expect(evaluateAudit(picomatchReport()).pass).toBe(false);
  });
});
