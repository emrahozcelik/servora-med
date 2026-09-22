import type { JobViewMode } from './job-search';

/**
 * Session-scoped Jobs view-mode preference (single owner).
 *
 * Remembers the user's EXPLICIT Liste/Pano choice for the current browser
 * session so that list-only memberships (Biten/Geciken) do not destroy it.
 * URL stays the source of truth for the effective mode; this module only
 * supplies the target mode for membership transitions.
 *
 * Deliberately not persisted as a server/user-profile preference.
 */
export const JOB_VIEW_PREFERENCE_KEY = 'servora.jobs.view-preference';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be denied (privacy mode, sandboxed iframe); fall back to default.
    return null;
  }
}

export function readJobViewPreference(storage: ReadableStorage | null = browserStorage()): JobViewMode {
  if (!storage) return 'list';
  try {
    return storage.getItem(JOB_VIEW_PREFERENCE_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function writeJobViewPreference(
  mode: JobViewMode,
  storage: WritableStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(JOB_VIEW_PREFERENCE_KEY, mode);
  } catch {
    // A denied storage write only costs the session memory, never correctness.
  }
}
