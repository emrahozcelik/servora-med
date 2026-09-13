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
