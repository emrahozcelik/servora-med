// @ts-check

/**
 * Owner-approved, self-expiring exception for the single picomatch ReDoS advisory.
 * This is NOT a generic package-name, advisory, or severity allowlist.
 * Expiry includes all of 2 December 2026 in Europe/Istanbul.
 */
export const PICOMATCH_ADVISORY = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
export const PICOMATCH_EXCEPTION_EXPIRES_AT = '2026-12-03T00:00:00+03:00';
export const PICOMATCH_EXCEPTION_STARTS_AT = '2026-11-18T00:00:00+03:00';

const CHAIN = new Set([
  'picomatch',
  'fdir',
  'tinyglobby',
  'vite',
  'vitest',
  '@vitest/mocker',
  '@vitejs/plugin-react',
]);

function deny(reason) {
  return { allowed: false, reason };
}

/**
 * Every high-severity entry must be a development-only member of a dependency
 * chain rooted in exactly one picomatch advisory. All direct advisories on any
 * member of that chain are denied except the exact GHSA above.
 *
 * This check is additive: the caller MUST also run an unexcepted production
 * npm audit to guard against incorrect or stale lockfile dev markings.
 *
 * @param {Record<string, any>} vulnerabilities
 * @param {unknown} lockfile
 * @param {Date} now
 */
export function checkPicomatchException(vulnerabilities, lockfile, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return deny('clock invalid — fail-closed');
  }
  if (now < new Date(PICOMATCH_EXCEPTION_STARTS_AT)) {
    return deny('clock precedes approval window — fail-closed');
  }
  if (now >= new Date(PICOMATCH_EXCEPTION_EXPIRES_AT)) {
    return deny('security exception expired on 2 December 2026');
  }
  if (!lockfile || typeof lockfile !== 'object'
      || lockfile.lockfileVersion !== 3
      || !lockfile.packages || typeof lockfile.packages !== 'object'
      || Array.isArray(lockfile.packages)) {
    return deny('missing or invalid lockfile v3');
  }
  const high = Object.entries(vulnerabilities).filter(([, entry]) => entry.severity === 'high');
  if (high.length === 0 || !Object.hasOwn(vulnerabilities, 'picomatch')
      || vulnerabilities.picomatch.severity !== 'high') {
    return deny('picomatch must be the high-severity root');
  }
  if (Object.values(vulnerabilities).some(entry => entry.severity === 'critical')) {
    return deny('critical vulnerability present');
  }

  const highNames = new Set(high.map(([name]) => name));
  for (const name of highNames) {
    if (!CHAIN.has(name)) return deny('unapproved high-severity package: ' + name);
    const entry = vulnerabilities[name];
    const installed = lockfile.packages['node_modules/' + name];
    if (!installed || installed.dev !== true || installed.devOptional === true
        || installed.optional === true) {
      return deny(name + ' is not proven dev-only in the lockfile');
    }
    if (!Array.isArray(entry.via) || entry.via.length === 0) {
      return deny(name + ' has no verifiable advisory ancestry');
    }
  }
  const root = vulnerabilities.picomatch;
  const rootVia = root.via;
  if (rootVia.length !== 1 || !rootVia[0] || typeof rootVia[0] !== 'object'
      || Array.isArray(rootVia[0])
      || rootVia[0].name !== 'picomatch'
      || rootVia[0].severity !== 'high'
      || rootVia[0].url !== PICOMATCH_ADVISORY) {
    return deny('picomatch has a different or additional direct advisory');
  }
  const rootVersion = lockfile.packages['node_modules/picomatch'].version;
  if (!/^4\.0\.[0-7]$/.test(rootVersion ?? '')) {
    return deny('picomatch version outside reviewed affected 4.0.x range');
  }

  const completed = new Set();
  const active = new Set();
  function followsOnlyPicomatch(name) {
    if (completed.has(name)) return true;
    if (active.has(name)) return false;
    active.add(name);
    const entry = vulnerabilities[name];
    if (!entry) return false;
    if (name !== 'picomatch') {
      for (const via of entry.via) {
        if (typeof via !== 'string' || !CHAIN.has(via)
            || !highNames.has(via) || !followsOnlyPicomatch(via)) {
          return false;
        }
      }
    }
    active.delete(name);
    completed.add(name);
    return true;
  }
  for (const name of highNames) {
    if (!followsOnlyPicomatch(name)) {
      return deny(name + ' contains a different, missing, or cyclic high advisory path');
    }
  }
  return { allowed: true, reason: 'only ' + PICOMATCH_ADVISORY
    + ' affects dev-only picomatch descendants; expires 2 December 2026' };
}
