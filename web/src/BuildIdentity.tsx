import { BUILD_IDENTITY } from './build-identity';

/**
 * Shared release-label presentation (login, desktop sidebar, mobile drawer).
 *
 * Visually secondary metadata. The `data-build-sha` attribute is the stable
 * machine contract for production smoke parity (full SHA for releases);
 * the `title` exposes the full SHA as a non-invasive diagnostic.
 */
export function BuildIdentity() {
  const identity = BUILD_IDENTITY;
  return (
    <p
      className="build-identity"
      data-build-sha={identity.buildSha ?? identity.buildShortSha}
      title={identity.buildSha ?? identity.buildLabel}
    >
      {identity.buildLabel}
    </p>
  );
}
