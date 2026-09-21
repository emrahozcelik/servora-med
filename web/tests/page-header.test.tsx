/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResolvedIdentityProvider } from '../src/shell/resolved-identity';
import { matchRouteIdentity } from '../src/shell/route-identity';
import { PageHeader } from '../src/ui/PageHeader';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('PageHeader contract', () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
  });

  async function render(path: string, header: React.ReactNode) {
    const match = matchRouteIdentity(path);
    if (!match) throw new Error(`expected identity for ${path}`);
    await act(async () => root.render(
      <ResolvedIdentityProvider match={match} role="MANAGER">{header}</ResolvedIdentityProvider>,
    ));
  }

  it('renders the resolved effective title as the single H1', async () => {
    await render('/settings/security', <PageHeader />);
    const headings = container.querySelectorAll('.page-header h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe('Güvenlik');
    expect(container.querySelector('.page-header-eyebrow')?.textContent).toBe('Hesap');
  });

  it('renders description and page-owned actions as supplied', async () => {
    await render('/jobs', <PageHeader description="Açıklama" actions={<button type="button">Eylem</button>} />);
    expect(container.querySelector('.page-header-description')?.textContent).toBe('Açıklama');
    expect(container.querySelector('.page-header-actions button')?.textContent).toBe('Eylem');
    expect(container.querySelector('.page-header h1')?.textContent).toBe('İşler');
  });

  it('preserves a page eyebrow override without touching the registry title', async () => {
    await render('/jobs', <PageHeader eyebrow="Çalışma alanı" />);
    expect(container.querySelector('.page-header-eyebrow')?.textContent).toBe('Çalışma alanı');
    expect(container.querySelector('.page-header h1')?.textContent).toBe('İşler');
  });

  it('treats empty breadcrumb and return regions as valid in 3A', async () => {
    await render('/products', <PageHeader />);
    expect(container.querySelector('[data-page-header="products"]')).not.toBeNull();
    expect(container.querySelectorAll('.page-header h1')).toHaveLength(1);
  });

  it('computes no title fallback inside PageHeader', async () => {
    await render('/jobs/job-1', <PageHeader />);
    // Generic fallback comes from the resolution layer, not the component.
    expect(container.querySelector('.page-header h1')?.textContent).toBe('İş detayı');
  });
});
