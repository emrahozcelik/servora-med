/** @vitest-environment jsdom */
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Contact, Customer } from '../src/services/crm-api';
import { useSetRouteAncestorLabels } from '../src/shell/route-navigation-provider';
import { renderWithRoute, routeTestManager } from './route-test-helpers';

vi.mock('../src/services/crm-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/crm-api')>();
  return { ...actual, getContact: vi.fn(), getCustomer: vi.fn() };
});

const { getContact, getCustomer } = await import('../src/services/crm-api');
const { ContactDetailScreen } = await import('../src/ContactManagement');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const contact: Contact = {
  id: 'contact-1', organizationId: 'org-1', customerId: 'customer-1', name: 'Dr. Ayşe Yılmaz',
  title: 'Doktor', phone: null, email: null, isPrimary: false, isActive: true, version: 1,
};

describe('route ancestor labels (F-01 render loop regression)', () => {
  let container: HTMLDivElement; let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    consoleError.mockRestore();
    vi.mocked(getContact).mockReset(); vi.mocked(getCustomer).mockReset();
  });

  it('keeps the setter identity stable and skips unchanged label writes', async () => {
    const setterIdentities = new Set<unknown>();
    let effectRuns = 0;
    let renders = 0;
    function Probe() {
      const setAncestorLabels = useSetRouteAncestorLabels();
      const rendersRef = useRef(0);
      rendersRef.current += 1; renders = rendersRef.current;
      setterIdentities.add(setAncestorLabels);
      useEffect(() => {
        effectRuns += 1;
        setAncestorLabels({ customerDetail: 'Demo Diş Kliniği' });
      }, [setAncestorLabels]);
      return null;
    }

    await renderWithRoute(root, '/customers/customer-1/contacts/contact-1', <Probe />);

    expect(setterIdentities.size).toBe(1);
    expect(effectRuns).toBe(1);
    // Initial render + one re-render for the first (changed) label write only.
    expect(renders).toBeLessThanOrEqual(2);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('Maximum update depth'), expect.anything());
  });

  it('renders the contact screen without looping and still feeds the customer name to the breadcrumb', async () => {
    vi.mocked(getContact).mockResolvedValue(contact);
    vi.mocked(getCustomer).mockResolvedValue({ id: 'customer-1', name: 'Demo Diş Kliniği' } as Customer);

    await renderWithRoute(
      root,
      '/customers/customer-1/contacts/contact-1',
      <ContactDetailScreen customerId="customer-1" contactId="contact-1" user={routeTestManager} canManage />,
    );
    await act(async () => { await Promise.resolve(); });

    const maxDepthErrors = consoleError.mock.calls.filter((call) =>
      call.some((part) => String(part instanceof Error ? part.message : part).includes('Maximum update depth')));
    expect(maxDepthErrors).toHaveLength(0);
    expect(getContact).toHaveBeenCalledTimes(1);
    expect(getCustomer).toHaveBeenCalledTimes(1);

    const crumbs = Array.from(container.querySelectorAll('.route-breadcrumb li')).map((item) => item.textContent);
    expect(crumbs).toContain('Demo Diş Kliniği');
    expect(container.querySelector('.page-header h1')?.textContent).toBe('Dr. Ayşe Yılmaz');
  });
});
