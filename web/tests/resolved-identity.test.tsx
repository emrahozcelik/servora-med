/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  combineResolvedTitle,
  ResolvedIdentityProvider,
  useResolvedIdentity,
  useSetRouteRuntimeLabel,
} from '../src/shell/resolved-identity';
import { getRouteIdentity, matchRouteIdentity } from '../src/shell/route-identity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness({ path, role = 'MANAGER' as const, onResolved }: {
  path: string;
  role?: 'MANAGER' | 'STAFF';
  onResolved?: (title: string | null) => void;
}) {
  return <ResolvedIdentityProvider match={matchRouteIdentity(path)} role={role}>
    <Reader onResolved={onResolved} />
  </ResolvedIdentityProvider>;
}

function Reader({ onResolved }: { onResolved?: (title: string | null) => void }) {
  const resolved = useResolvedIdentity();
  onResolved?.(resolved?.effectiveTitle ?? null);
  return null;
}

function LabelSetter({ label }: { label: string | undefined }) {
  const setLabel = useSetRouteRuntimeLabel();
  return <button type="button" onClick={() => setLabel(label)}>set</button>;
}

describe('resolved identity ownership', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
  });

  async function render(path: string, role: 'MANAGER' | 'STAFF' = 'MANAGER') {
    const seen: Array<string | null> = [];
    await act(async () => root.render(
      <Harness path={path} role={role} onResolved={(title) => seen.push(title)} />,
    ));
    return seen;
  }

  it('combines the fallback in exactly one place', () => {
    expect(combineResolvedTitle('İş detayı', undefined)).toBe('İş detayı');
    expect(combineResolvedTitle('İş detayı', 'Ziyaret planı')).toBe('Ziyaret planı');
  });

  it('resolves the static fallback before any runtime label', async () => {
    const seen = await render('/jobs/job-1');
    expect(seen.at(-1)).toBe('İş detayı');
  });

  it('applies the role-aware display title without touching the registry', async () => {
    const staffSeen = await render('/jobs', 'STAFF');
    expect(staffSeen.at(-1)).toBe('İşlerim');
    const managerSeen = await render('/jobs', 'MANAGER');
    expect(managerSeen.at(-1)).toBe('İşler');
    expect(getRouteIdentity('jobs').title).toBe('İşler');
  });

  it('applies a page-supplied runtime label over the fallback', async () => {
    const seen: Array<string | null> = [];
    await act(async () => root.render(
      <ResolvedIdentityProvider match={matchRouteIdentity('/products/p1')} role="MANAGER">
        <Reader onResolved={(title) => seen.push(title)} />
        <LabelSetter label="Dental İmplant" />
      </ResolvedIdentityProvider>,
    ));
    expect(seen.at(-1)).toBe('Ürün');
    await act(async () => container.querySelector('button')!.click());
    expect(seen.at(-1)).toBe('Dental İmplant');
  });

  it('resets a stale runtime label when identity or params change', async () => {
    const seen: Array<string | null> = [];
    const show = async (path: string, label: string | undefined) => {
      await act(async () => root.render(
        <ResolvedIdentityProvider
          key={`${matchRouteIdentity(path)?.identity.id}:${path}`}
          match={matchRouteIdentity(path)}
          role="MANAGER"
        >
          <Reader onResolved={(title) => seen.push(title)} />
          <LabelSetter label={label} />
        </ResolvedIdentityProvider>,
      ));
      await act(async () => container.querySelector('button')!.click());
    };
    await show('/jobs/a', 'Job A');
    expect(seen.at(-1)).toBe('Job A');
    // Same pattern, different params: previous label must not leak.
    await show('/jobs/b', 'Job B');
    expect(seen).toContain('İş detayı');
    expect(seen.at(-1)).toBe('Job B');
    // Dynamic to static: label must not survive either.
    await show('/jobs', undefined);
    expect(seen.at(-1)).toBe('İşler');
  });

  it('yields null resolved on unknown paths without fabricating identity', async () => {
    const seen = await render('/no-such-route');
    expect(seen.at(-1)).toBeNull();
  });
});
