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
 * available in build metadata (and the `data-build-sha` document contract used
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
  /** Visible label, e.g. `Dünya Dental 0.1.0 · 6325e44`. Never empty. */
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
      buildLabel: `Dünya Dental ${appVersion} · ${buildShortSha}`,
      isDevelopmentBuild: false,
      isValidRelease: true,
    };
  }
  if (source.development) {
    return {
      appVersion,
      buildSha: null,
      buildShortSha: DEVELOPMENT_BUILD_SHORT_SHA,
      buildLabel: `Dünya Dental ${appVersion} · ${DEVELOPMENT_BUILD_SHORT_SHA}`,
      isDevelopmentBuild: true,
      isValidRelease: false,
    };
  }
  return {
    appVersion,
    buildSha: null,
    buildShortSha: UNKNOWN_BUILD_SHORT_SHA,
    buildLabel: `Dünya Dental ${appVersion} · ${UNKNOWN_BUILD_SHORT_SHA}`,
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

/**
 * Anonymous, non-visual release marker on the document element.
 *
 * The production deploy gate compares the browser-visible release identity
 * against the expected deploy SHA on a signed-out page, where no shell footer
 * exists. The login screen no longer shows user-facing build metadata
 * (UI audit F-16), so the same stable `data-build-sha` / `data-build-label`
 * contract is exposed once on `<html>` instead of in the login form.
 */
export function applyDocumentBuildIdentity(
  documentElement: HTMLElement,
  identity: BuildIdentity = BUILD_IDENTITY,
): void {
  documentElement.dataset.buildSha = identity.buildSha ?? identity.buildShortSha;
  documentElement.dataset.buildLabel = identity.buildLabel;
}
