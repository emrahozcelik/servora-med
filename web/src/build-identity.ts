/**
 * Canonical frontend build identity (Release Identity slice).
 *
 * A user/operator can identify which Servora-Med frontend build is loaded
 * without source/server access. The browser runtime never shells out to git
 * and needs no network request: the exact deployment SHA is embedded at
 * build time via `VITE_SERVORA_BUILD_SHA`, and the product version is
 * embedded from `package.json` via the Vite `define` contract.
 *
 * Visible display uses the short SHA only; the full 40-character SHA stays
 * available in build metadata (and the `data-build-sha` DOM contract used
 * by production smoke parity).
 */

export const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const BUILD_SHORT_SHA_LENGTH = 7;
export const DEVELOPMENT_BUILD_SHORT_SHA = 'dev';
export const UNKNOWN_BUILD_SHORT_SHA = 'unknown';

export type BuildIdentitySource = {
  appVersion: string;
  rawBuildSha: string;
  development: boolean;
};

export type BuildIdentity = {
  appVersion: string;
  /** Full 40-character SHA for real releases, otherwise null. */
  buildSha: string | null;
  /** 7-character short SHA, `dev` for local development, `unknown` otherwise. */
  buildShortSha: string;
  /** Visible label, e.g. `Servora Med 0.1.0 · Build 6325e44`. Never empty. */
  buildLabel: string;
  isDevelopmentBuild: boolean;
  isValidRelease: boolean;
};

export function createBuildIdentity(source: BuildIdentitySource): BuildIdentity {
  const appVersion = source.appVersion.trim() || '0.0.0';
  const normalized = source.rawBuildSha.trim().toLowerCase();
  if (BUILD_SHA_PATTERN.test(normalized)) {
    const buildShortSha = normalized.slice(0, BUILD_SHORT_SHA_LENGTH);
    return {
      appVersion,
      buildSha: normalized,
      buildShortSha,
      buildLabel: `Servora Med ${appVersion} · Build ${buildShortSha}`,
      isDevelopmentBuild: false,
      isValidRelease: true,
    };
  }
  if (source.development) {
    return {
      appVersion,
      buildSha: null,
      buildShortSha: DEVELOPMENT_BUILD_SHORT_SHA,
      buildLabel: `Servora Med ${appVersion} · Build ${DEVELOPMENT_BUILD_SHORT_SHA}`,
      isDevelopmentBuild: true,
      isValidRelease: false,
    };
  }
  return {
    appVersion,
    buildSha: null,
    buildShortSha: UNKNOWN_BUILD_SHORT_SHA,
    buildLabel: `Servora Med ${appVersion} · Build ${UNKNOWN_BUILD_SHORT_SHA}`,
    isDevelopmentBuild: false,
    isValidRelease: false,
  };
}

declare const __SERVORA_APP_VERSION__: string | undefined;

function readAppVersion(): string {
  return typeof __SERVORA_APP_VERSION__ === 'string' && __SERVORA_APP_VERSION__.trim() !== ''
    ? __SERVORA_APP_VERSION__.trim()
    : '0.0.0';
}

export function resolveBuildIdentity(environment: {
  VITE_SERVORA_BUILD_SHA?: string;
  DEV?: boolean;
} = import.meta.env): BuildIdentity {
  return createBuildIdentity({
    appVersion: readAppVersion(),
    rawBuildSha: environment.VITE_SERVORA_BUILD_SHA ?? '',
    development: environment.DEV === true,
  });
}

export const BUILD_IDENTITY = resolveBuildIdentity();
