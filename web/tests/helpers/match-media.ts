import { vi } from 'vitest';

const DESKTOP_QUERY = '(min-width: 64rem)';

/**
 * Stubs `window.matchMedia` for the shared shell breakpoint. `narrow: true`
 * makes `useNarrowShell()` report the mobile/tablet shell; other media queries
 * stay false. The stub must be installed before the component mounts.
 */
export function stubMatchMedia({ narrow = false }: { narrow?: boolean } = {}): void {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: query.includes(DESKTOP_QUERY) ? !narrow : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}
