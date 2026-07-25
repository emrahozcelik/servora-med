import { describe, it, expect } from 'vitest';
import {
  evaluateAudit,
  validateVulnShape,
  isAllowedAdvisoryObject,
  evaluateVulnerabilityChain,
  checkMetadataConsistency,
  runRSCStaticGuard,
} from '../scripts/audit-high-policy-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// ─── Constants ──────────────────────────────────────────────────────────────

const ALLOWED_GHSA = 'GHSA-qwww-vcr4-c8h2';
const ALLOWED_GHSA_URL = 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2';
const POSTCSS_GHSA_URL = 'https://github.com/advisories/GHSA-r28c-9q8g-f849';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAllowedViaObject() {
  return {
    source: 1124282,
    name: 'react-router',
    dependency: 'react-router',
    title:
      'React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response',
    url: ALLOWED_GHSA_URL,
    severity: 'high',
    cwe: ['CWE-352'],
    cvss: { score: 0, vectorString: null },
    range: '>=7.12.0 <8.3.0',
  };
}

function makeVuln(overrides: Record<string, unknown> = {}) {
  return {
    name: 'react-router',
    severity: 'high',
    isDirect: false,
    via: [makeAllowedViaObject()],
    effects: [],
    range: '7.12.0 - 8.2.0',
    nodes: ['node_modules/react-router-dom/node_modules/react-router'],
    fixAvailable: { name: 'react-router-dom', version: '7.11.0', isSemVerMajor: true },
    ...overrides,
  };
}

function makeReport(
  vulnerabilities: Record<string, unknown>,
  high = 1,
  critical = 0,
) {
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
      dependencies: {
        prod: 73,
        dev: 129,
        optional: 34,
        peer: 0,
        peerOptional: 0,
        total: 201,
      },
    },
  });
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

// ─── validateVulnShape ─────────────────────────────────────────────────────

describe('validateVulnShape', () => {
  it('accepts valid vulnerability', () => {
    expect(validateVulnShape(makeVuln())).toBeNull();
  });

  it('rejects null', () => {
    expect(validateVulnShape(null)).toContain('not an object');
  });

  it('rejects missing name', () => {
    expect(validateVulnShape(makeVuln({ name: '' }))).toContain('name');
  });

  it('rejects invalid severity', () => {
    expect(validateVulnShape(makeVuln({ severity: 'extreme' }))).toContain('severity');
  });

  it('rejects non-array via', () => {
    expect(validateVulnShape(makeVuln({ via: 'string' }))).toContain('via not array');
  });

  it('rejects non-array effects', () => {
    expect(validateVulnShape(makeVuln({ effects: 'string' }))).toContain('effects not array');
  });
});

// ─── isAllowedAdvisoryObject ───────────────────────────────────────────────

describe('isAllowedAdvisoryObject', () => {
  it('accepts allowed GHSA advisory object', () => {
    const result = isAllowedAdvisoryObject(makeAllowedViaObject());
    expect(result.allowed).toBe(true);
  });

  it('rejects PostCSS GHSA advisory object', () => {
    const result = isAllowedAdvisoryObject({
      source: 1124288,
      name: 'postcss',
      title: 'PostCSS: Path Traversal',
      url: POSTCSS_GHSA_URL,
      severity: 'high',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('unapproved advisory');
  });

  it('rejects null', () => {
    expect(isAllowedAdvisoryObject(null).allowed).toBe(false);
  });

  it('rejects object without url', () => {
    expect(isAllowedAdvisoryObject({ name: 'react-router' }).allowed).toBe(false);
  });

  it('rejects non-allowed package name in advisory', () => {
    const result = isAllowedAdvisoryObject({
      url: ALLOWED_GHSA_URL,
      name: 'some-other-pkg',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('package not allowed');
  });
});

// ─── evaluateVulnerabilityChain ────────────────────────────────────────────

describe('evaluateVulnerabilityChain', () => {
  it('allows react-router with direct allowed advisory', () => {
    const vulnerabilities = {
      'react-router': makeVuln(),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(true);
  });

  it('allows react-router-dom string via to allowed react-router', () => {
    const vulnerabilities = {
      'react-router': makeVuln(),
      'react-router-dom': makeVuln({ name: 'react-router-dom', via: ['react-router'], effects: [] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router-dom',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(true);
  });

  it('fails on missing referenced vulnerability', () => {
    const vulnerabilities = {
      'react-router-dom': makeVuln({ name: 'react-router-dom', via: ['react-router'], effects: [] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router-dom',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('missing');
  });

  it('fails on self-cycle', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: ['react-router'] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cycle');
  });

  it('fails on cross-cycle react-router-dom <-> react-router', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: ['react-router-dom'] }),
      'react-router-dom': makeVuln({ name: 'react-router-dom', via: ['react-router'], effects: [] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router-dom',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cycle');
  });

  it('fails on string via allowed package but no terminal advisory', () => {
    // package-a is in allowed set, via references package-b which has no advisory
    const vulnerabilities = {
      'react-router': makeVuln({ severity: 'low' }), // not high/critical → no terminal advisory
      'react-router-dom': makeVuln({ name: 'react-router-dom', via: ['react-router'], effects: [] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router-dom',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    // react-router has severity 'low', so it doesn't have a terminal advisory
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no terminal advisory found');
  });

  it('fails on string via allowed package but different GHSA', () => {
    const vulnerabilities = {
      'react-router': makeVuln({
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
      }),
      'react-router-dom': makeVuln({ name: 'react-router-dom', via: ['react-router'], effects: [] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router-dom',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('unapproved advisory');
  });

  it('fails on critical severity', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ severity: 'critical' }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('critical');
  });

  it('fails on empty via array', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: [] }),
    };
    const result = evaluateVulnerabilityChain({
      packageName: 'react-router',
      vulnerabilities,
      visiting: new Set(),
      resolved: new Map(),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('via empty');
  });
});

// ─── checkMetadataConsistency ─────────────────────────────────────────────

describe('checkMetadataConsistency', () => {
  it('passes on consistent metadata', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
      },
      vulnerabilities: {
        'react-router': makeVuln(),
        'react-router-dom': makeVuln({ name: 'react-router-dom', via: ['react-router'], effects: [] }),
      },
    };
    expect(checkMetadataConsistency(report)).toBeNull();
  });

  it('fails when metadata high=0 but high entries exist', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      },
      vulnerabilities: {
        'react-router': makeVuln(),
      },
    };
    expect(checkMetadataConsistency(report)).toContain('high=0');
  });

  it('fails when metadata critical=0 but critical entries exist', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      },
      vulnerabilities: {
        'react-router': makeVuln({ severity: 'critical' }),
      },
    };
    expect(checkMetadataConsistency(report)).toContain('critical=0');
  });

  it('fails when metadata high>0 but no high entries', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
      },
      vulnerabilities: {},
    };
    expect(checkMetadataConsistency(report)).toContain('high=2');
  });

  it('fails when metadata values are non-numeric', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 'two', critical: 0, total: 2 },
      },
      vulnerabilities: {},
    };
    expect(checkMetadataConsistency(report)).toContain('invalid');
  });

  it('fails when metadata values are negative', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: -1, critical: 0, total: -1 },
      },
      vulnerabilities: {},
    };
    expect(checkMetadataConsistency(report)).toContain('invalid');
  });

  it('fails when metadata values are NaN', () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: NaN, critical: 0, total: NaN },
      },
      vulnerabilities: {},
    };
    expect(checkMetadataConsistency(report)).toContain('invalid');
  });
});

// ─── runRSCStaticGuard ─────────────────────────────────────────────────────

describe('runRSCStaticGuard', () => {
  it('returns empty for clean src directory', () => {
    const tmpDir = createTempDir('rsc-clean-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'App.tsx'), 'const x = 1;\n');
      const result = runRSCStaticGuard(tmpDir, fs, path);
      expect(result.violations).toEqual([]);
      expect(result.scanErrors).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects RSCHydratedRouter in source', () => {
    const tmpDir = createTempDir('rsc-det-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'router.tsx'),
        'import { RSCHydratedRouter } from "react-router";\n',
      );
      const result = runRSCStaticGuard(tmpDir, fs, path);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]).toContain('RSCHydratedRouter');
      expect(result.scanErrors).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects react-server condition', () => {
    const tmpDir = createTempDir('rsc-cond-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'vite.config.ts'),
        'const condition = "react-server";\n',
      );
      const result = runRSCStaticGuard(tmpDir, fs, path);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]).toContain('react-server');
      expect(result.scanErrors).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips node_modules directory', () => {
    const tmpDir = createTempDir('rsc-nm-');
    try {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'fake-pkg'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'node_modules', 'fake-pkg', 'index.ts'),
        'RSCHydratedRouter;\n',
      );
      fs.writeFileSync(path.join(tmpDir, 'clean.ts'), 'const a = 1;\n');
      const result = runRSCStaticGuard(tmpDir, fs, path);
      expect(result.violations).toEqual([]);
      expect(result.scanErrors).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports scan error for missing src root', () => {
    const result = runRSCStaticGuard('/nonexistent/path/xyz789', fs, path);
    expect(result.scanErrors.length).toBeGreaterThan(0);
    expect(result.scanErrors[0]).toContain('not accessible');
    expect(result.violations).toEqual([]);
  });

  it('reports scan error for unreadable file via injected error', () => {
    // Inject custom fs.readFileSync that throws
    const errorFs = {
      ...fs,
      readdirSync: fs.readdirSync.bind(fs),
      statSync: fs.statSync.bind(fs),
      readFileSync: () => {
        throw new Error('simulated EACCES');
      },
    };

    const tmpDir = createTempDir('rsc-file-err-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'broken.ts'), 'const x = 1;\n');
      const result = runRSCStaticGuard(tmpDir, errorFs, path);
      expect(result.scanErrors.length).toBeGreaterThan(0);
      expect(result.scanErrors[0]).toContain('cannot read file');
      expect(result.violations).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports scan error for unreadable directory via injected error', () => {
    // Inject custom fs.readdirSync that throws
    const errorFs = {
      ...fs,
      statSync: fs.statSync.bind(fs),
      readdirSync: () => {
        throw new Error('simulated EACCES on directory');
      },
      readFileSync: fs.readFileSync.bind(fs),
    };

    const tmpDir = createTempDir('rsc-dir-err-');
    try {
      fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'const x = 1;\n');
      const result = runRSCStaticGuard(tmpDir, errorFs, path);
      expect(result.scanErrors.length).toBeGreaterThan(0);
      expect(result.scanErrors[0]).toContain('cannot read directory');
      expect(result.violations).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports scan error for src root that is a file, not directory', () => {
    const tmpDir = createTempDir('rsc-notdir-');
    try {
      const filePath = path.join(tmpDir, 'afile.txt');
      fs.writeFileSync(filePath, 'not a dir');
      const result = runRSCStaticGuard(filePath, fs, path);
      expect(result.scanErrors.length).toBeGreaterThan(0);
      expect(result.scanErrors[0]).toContain('not a directory');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── evaluateAudit ─────────────────────────────────────────────────────────

describe('evaluateAudit — no vulnerabilities', () => {
  it('clean report → PASS', () => {
    const result = evaluateAudit(makeReport({}, 0, 0));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('PASS');
  });
});

describe('evaluateAudit — recursive chain scenarios', () => {
  it('scenario 1: react-router direct allowed GHSA → PASS_WITH_WAIVER', () => {
    const result = evaluateAudit(makeReport({ 'react-router': makeVuln() }, 1, 0));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('PASS_WITH_WAIVER');
  });

  it('scenario 2: react-router-dom → react-router chain → PASS_WITH_WAIVER', () => {
    const vulnerabilities = {
      'react-router': makeVuln(),
      'react-router-dom': makeVuln({
        name: 'react-router-dom',
        via: ['react-router'],
        effects: [],
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 2, 0));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('scenario 3: string via missing package → FAIL', () => {
    const vulnerabilities = {
      'react-router-dom': makeVuln({
        name: 'react-router-dom',
        via: ['react-router'],
        effects: [],
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('missing');
  });

  it('scenario 4: self-cycle → FAIL', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: ['react-router'] }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('cycle');
  });

  it('scenario 5: cross-cycle → FAIL', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: ['react-router-dom'] }),
      'react-router-dom': makeVuln({
        name: 'react-router-dom',
        via: ['react-router'],
        effects: [],
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 2, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('cycle');
  });

  it('scenario 6: allowed package but no terminal advisory → FAIL', () => {
    // react-router referenced but has low severity → no terminal advisory
    const vulnerabilities = {
      'react-router': makeVuln({ severity: 'low', via: [] }),
      'react-router-dom': makeVuln({
        name: 'react-router-dom',
        via: ['react-router'],
        effects: [],
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('scenario 7: terminal advisory different GHSA → FAIL', () => {
    const vulnerabilities = {
      'react-router': makeVuln({
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
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('unapproved advisory');
  });

  it('scenario 8: PostCSS high advisory → FAIL', () => {
    const vulnerabilities = {
      postcss: makeVuln({
        name: 'postcss',
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
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('unapproved advisory');
  });
});

describe('evaluateAudit — malformed payload', () => {
  it('via empty array → FAIL', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: [] }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('via missing → FAIL', () => {
    const vuln = makeVuln();
    delete vuln.via;
    const result = evaluateAudit(makeReport({ 'react-router': vuln }, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('effects missing → FAIL', () => {
    const vuln = makeVuln();
    delete vuln.effects;
    const result = evaluateAudit(makeReport({ 'react-router': vuln }, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('effects non-array → FAIL', () => {
    const vuln = makeVuln({ effects: 'string-effects' });
    const result = evaluateAudit(makeReport({ 'react-router': vuln }, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('malformed JSON → FAIL', () => {
    const result = evaluateAudit('{{{ broken json }}');
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('fail-closed');
  });

  it('null vulnerabilities → FAIL', () => {
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

describe('evaluateAudit — metadata consistency', () => {
  it('metadata high=0 but high entries exist → FAIL', () => {
    const result = evaluateAudit(makeReport({ 'react-router': makeVuln() }, 0, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });

  it('metadata critical=0 but critical entry exists → FAIL', () => {
    const result = evaluateAudit(
      makeReport({ 'react-router': makeVuln({ severity: 'critical' }) }, 0, 0),
    );
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });

  it('metadata high>0 but no high entries → FAIL', () => {
    const result = evaluateAudit(makeReport({}, 2, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('metadata');
  });
});

describe('evaluateAudit — legacy via string', () => {
  it('legacy GHSA string via → FAIL', () => {
    const vulnerabilities = {
      'react-router': makeVuln({ via: ['GHSA-qwww-vcr4-c8h2'] }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 1, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('legacy');
  });
});

describe('evaluateAudit — critical', () => {
  it('critical advisory → FAIL', () => {
    const critVuln = makeVuln({
      severity: 'critical',
      via: [{ ...makeAllowedViaObject(), severity: 'critical' }],
    });
    const result = evaluateAudit(makeReport({ 'react-router': critVuln }, 0, 1));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe('evaluateAudit — combined findings', () => {
  it('allowed GHSA + PostCSS → FAIL', () => {
    const vulnerabilities = {
      'react-router': makeVuln(),
      postcss: makeVuln({
        name: 'postcss',
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
      }),
    };
    const result = evaluateAudit(makeReport(vulnerabilities, 2, 0));
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe('evaluateAudit — RSC scanner errors', () => {
  it('missing src root → FAIL', () => {
    const result = evaluateAudit(makeReport({ 'react-router': makeVuln() }, 1, 0), {
      srcRoot: '/nonexistent/path/rsc-test-xyz',
    });
    expect(result.pass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('RSC tarama hatasi');
  });

  it('RSC identifier in source → FAIL', () => {
    const tmpDir = createTempDir('audit-rsc-det-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'test.tsx'),
        'import { RSCHydratedRouter } from "react-router";\n',
      );
      const result = evaluateAudit(
        makeReport({ 'react-router': makeVuln() }, 1, 0),
        { srcRoot: tmpDir },
      );
      expect(result.pass).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('RSC API kullanimi');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('evaluateAudit — real npm audit fixture', () => {
  it('current real React Router audit shape → PASS_WITH_WAIVER', () => {
    // This fixture mirrors the exact npm audit --json v2 shape from the
    // current react-router-dom@7.18.1 → react-router@7.18.1 dependency tree.
    const realWorldFixture = {
      auditReportVersion: 2,
      vulnerabilities: {
        'react-router': {
          name: 'react-router',
          severity: 'high',
          isDirect: false,
          via: [
            {
              source: 1124282,
              name: 'react-router',
              dependency: 'react-router',
              title:
                'React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response',
              url: ALLOWED_GHSA_URL,
              severity: 'high',
              cwe: ['CWE-352'],
              cvss: { score: 0, vectorString: null },
              range: '>=7.12.0 <8.3.0',
            },
          ],
          effects: ['react-router-dom'],
          range: '7.12.0 - 8.2.0',
          nodes: ['node_modules/react-router-dom/node_modules/react-router'],
          fixAvailable: {
            name: 'react-router-dom',
            version: '7.11.0',
            isSemVerMajor: true,
          },
        },
        'react-router-dom': {
          name: 'react-router-dom',
          severity: 'high',
          isDirect: true,
          via: ['react-router'],
          effects: [],
          range: '>=7.12.0-pre.0',
          nodes: ['node_modules/react-router-dom'],
          fixAvailable: {
            name: 'react-router-dom',
            version: '7.11.0',
            isSemVerMajor: true,
          },
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
        dependencies: {
          prod: 73,
          dev: 129,
          optional: 34,
          peer: 0,
          peerOptional: 0,
          total: 201,
        },
      },
    };
    const result = evaluateAudit(JSON.stringify(realWorldFixture));
    expect(result.pass).toBe(true);
    expect(result.waiverApplied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('PASS_WITH_WAIVER');
  });
});

// ─── Clean BrowserRouter source should PASS RSC guard ──────────────────────

describe('evaluateAudit — clean BrowserRouter source', () => {
  it('clean source + allowed GHSA → PASS_WITH_WAIVER', () => {
    const tmpDir = createTempDir('audit-clean-rsc-');
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'App.tsx'),
        `import { BrowserRouter } from "react-router-dom";\nconst App = () => <BrowserRouter><div>Hello</div></BrowserRouter>;\n`,
      );
      const result = evaluateAudit(
        makeReport({ 'react-router': makeVuln() }, 1, 0),
        { srcRoot: tmpDir },
      );
      expect(result.pass).toBe(true);
      expect(result.waiverApplied).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
