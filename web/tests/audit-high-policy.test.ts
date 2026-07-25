import { describe, it, expect } from 'vitest';
import { evaluateAudit, isVulnerabilityAllowed, scanRscIdentifiers } from '../scripts/audit-high-policy-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ALLOWED_GHSA_URL = 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2';
const POSTCSS_GHSA_URL = 'https://github.com/advisories/GHSA-r28c-9q8g-f849';

function makeVuln(overrides: Record<string, unknown> = {}) {
  return {
    name: 'react-router',
    severity: 'high',
    isDirect: false,
    via: [
      {
        source: 1124282,
        name: 'react-router',
        title: 'React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response',
        url: ALLOWED_GHSA_URL,
        severity: 'high',
        cwe: ['CWE-352'],
        cvss: { score: 0, vectorString: null },
        range: '>=7.12.0 <8.3.0',
      },
    ],
    effects: [],
    range: '7.12.0 - 8.2.0',
    nodes: ['node_modules/react-router-dom/node_modules/react-router'],
    fixAvailable: true,
    ...overrides,
  };
}

function makeReport(vulnerabilities: Record<string, unknown>, high = 1, critical = 0) {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high,
        critical,
        total: high + critical,
      },
      dependencies: { prod: 73, dev: 129, optional: 34, peer: 0, peerOptional: 0, total: 201 },
    },
  });
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

// ─── isVulnerabilityAllowed ────────────────────────────────────────────────

describe('isVulnerabilityAllowed', () => {
  it('allows GHSA-qwww-vcr4-c8h2 on react-router', () => {
    const result = isVulnerabilityAllowed(makeVuln());
    expect(result.allowed).toBe(true);
  });

  it('blocks PostCSS GHSA-r28c-9q8g-f849', () => {
    const vuln = {
      name: 'postcss',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1124288,
          name: 'postcss',
          title: 'PostCSS: Path Traversal',
          url: POSTCSS_GHSA_URL,
          severity: 'high',
          cwe: ['CWE-22'],
          cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
          range: '<=8.5.17',
        },
      ],
      effects: [],
      range: '<=8.5.17',
      nodes: ['node_modules/postcss'],
      fixAvailable: true,
    };
    const result = isVulnerabilityAllowed(vuln);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Unapproved advisory');
  });

  it('blocks a different React Router GHSA', () => {
    const vuln = makeVuln({
      via: [
        {
          source: 1112053,
          name: 'react-router',
          title: 'XSS via Open Redirects',
          url: 'https://github.com/advisories/GHSA-2w69-qvjg-hvjx',
          severity: 'high',
          cwe: ['CWE-79'],
          cvss: { score: 8, vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:H/A:N' },
          range: '>=7.0.0 <=7.11.0',
        },
      ],
    });
    const result = isVulnerabilityAllowed(vuln);
    expect(result.allowed).toBe(false);
  });

  it('blocks non-allowed package', () => {
    const vuln = makeVuln({ name: 'some-other-package' });
    const result = isVulnerabilityAllowed(vuln);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Package not in allowed set');
  });

  it('blocks legacy string-based via entries (GHSA-id format)', () => {
    const vuln = makeVuln({ via: ['GHSA-qwww-vcr4-c8h2'] });
    const result = isVulnerabilityAllowed(vuln);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Legacy via string');
  });

  it('allows transitive string via to allowed package', () => {
    const vuln = makeVuln({ via: ['react-router'] });
    const result = isVulnerabilityAllowed(vuln);
    expect(result.allowed).toBe(true);
  });

  it('blocks transitive string via to non-allowed package', () => {
    const vuln = makeVuln({ via: ['some-unknown-pkg'] });
    const result = isVulnerabilityAllowed(vuln);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Transitive via non-allowed package');
  });
});

// ─── evaluateAudit ─────────────────────────────────────────────────────────

describe('evaluateAudit', () => {
  it('scenario 1: no vulnerabilities → PASS', () => {
    const result = evaluateAudit(makeReport({}, 0, 0));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('PASS');
  });

  it('scenario 2: only GHSA-qwww-vcr4-c8h2 on react-router → PASS_WITH_WAIVER', () => {
    const result = evaluateAudit(makeReport({ 'react-router': makeVuln() }, 2, 0));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('PASS_WITH_WAIVER');
  });

  it('scenario 3: react-router-dom transitive → PASS_WITH_WAIVER', () => {
    const rrVuln = makeVuln({ name: 'react-router' });
    // react-router-dom via is a string reference to react-router (npm audit format)
    const rrdVuln = {
      ...makeVuln({ name: 'react-router-dom', effects: [] }),
      via: ['react-router'],
    };
    const result = evaluateAudit(makeReport({ 'react-router': rrVuln, 'react-router-dom': rrdVuln }, 2, 0));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(true);
  });

  it('scenario 4: PostCSS high advisory → FAIL', () => {
    const postcssVuln = {
      name: 'postcss',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1124288,
          name: 'postcss',
          title: 'PostCSS: Path Traversal',
          url: POSTCSS_GHSA_URL,
          severity: 'high',
          cwe: ['CWE-22'],
          cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
          range: '<=8.5.17',
        },
      ],
      effects: [],
      range: '<=8.5.17',
      nodes: ['node_modules/postcss'],
      fixAvailable: true,
    };
    const result = evaluateAudit(makeReport({ postcss: postcssVuln }, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('scenario 5: different React Router GHSA → FAIL', () => {
    const otherVuln = makeVuln({
      via: [
        {
          source: 1112053,
          name: 'react-router',
          title: 'XSS via Open Redirects',
          url: 'https://github.com/advisories/GHSA-2w69-qvjg-hvjx',
          severity: 'high',
          cwe: ['CWE-79'],
          cvss: { score: 8, vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:C/C:H/I:H/A:N' },
          range: '>=7.0.0 <=7.11.0',
        },
      ],
    });
    const result = evaluateAudit(makeReport({ 'react-router': otherVuln }, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('scenario 6: critical advisory → FAIL', () => {
    const critVuln = makeVuln({
      severity: 'critical',
      via: [{ ...makeVuln().via[0], severity: 'critical' }],
    });
    const result = evaluateAudit(makeReport({ 'react-router': critVuln }, 0, 1));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('scenario 7: malformed JSON → FAIL', () => {
    const result = evaluateAudit('{{{ broken json }}');
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('fail-closed');
  });

  it('scenario 8: legacy via string → FAIL', () => {
    const vuln = makeVuln({ via: ['GHSA-qwww-vcr4-c8h2'] });
    const result = evaluateAudit(makeReport({ 'react-router': vuln }, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('scenario 9: allowed GHSA + another high → FAIL', () => {
    const rrVuln = makeVuln();
    const postcssVuln = {
      name: 'postcss',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1124288,
          name: 'postcss',
          title: 'PostCSS: Path Traversal',
          url: POSTCSS_GHSA_URL,
          severity: 'high',
          cwe: ['CWE-22'],
          cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
          range: '<=8.5.17',
        },
      ],
      effects: [],
      range: '<=8.5.17',
      nodes: ['node_modules/postcss'],
      fixAvailable: true,
    };
    const result = evaluateAudit(makeReport({ 'react-router': rrVuln, postcss: postcssVuln }, 2, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('scenario 10: RSC identifier in src → FAIL', () => {
    const tmpDir = createTempDir('audit-test-rsc-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'test.tsx'), 'import { RSCHydratedRouter } from "react-router";\n');
      const result = evaluateAudit(
        makeReport({ 'react-router': makeVuln() }, 1, 0),
        { scanRscInSrc: true, srcRoot: tmpDir },
      );
      expect(result.pass).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('RSC API kullanımı');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── scanRscIdentifiers ────────────────────────────────────────────────────

describe('scanRscIdentifiers', () => {
  it('detects RSCHydratedRouter in a .tsx file', () => {
    const tmpDir = createTempDir('audit-scan-test-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'router.tsx'), 'const r = RSCHydratedRouter;\n');
      const violations = scanRscIdentifiers(tmpDir, fs, path);
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain('RSCHydratedRouter');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty for clean src', () => {
    const tmpDir = createTempDir('audit-clean-test-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'App.tsx'), 'const x = 1;\n');
      const violations = scanRscIdentifiers(tmpDir, fs, path);
      expect(violations.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips node_modules directory', () => {
    const tmpDir = createTempDir('audit-nm-test-');
    try {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'fake-pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'fake-pkg', 'index.ts'), 'RSCHydratedRouter;\n');
      fs.writeFileSync(path.join(tmpDir, 'real.ts'), 'const a = 1;\n');
      const violations = scanRscIdentifiers(tmpDir, fs, path);
      expect(violations.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
