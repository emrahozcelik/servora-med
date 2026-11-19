// Production base styles first: module evaluation order decides the cascade,
// and the real app loads styles.css before the lazy messaging chunk.
import '../src/styles.css';

import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { MessagingPage } from '../src/messaging/MessagingPage';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { MobileTopBar } from '../src/shell/MobileTopBar';
import { ResolvedIdentityProvider } from '../src/shell/resolved-identity';
import { matchRouteIdentity } from '../src/shell/route-identity';

// Synthetic /messages presentation fixture for the real React page, services
// and production CSS. Every /api/messaging request is answered locally by the
// smoke runner; no production API, auth or mutation is exercised here.
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });

const params = new URLSearchParams(location.search);
const role = (params.get('role') ?? 'MANAGER') as CurrentUser['role'];
const user: CurrentUser = {
  id: 'fixture-manager',
  organizationId: 'fixture-org',
  name: 'Deniz Yönetici',
  email: 'deniz@example.test',
  role,
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: '', email: null, helpUrl: null },
};

const identityMatch = matchRouteIdentity('/messages');
const selectedConversation = params.get('selected');
document.documentElement.dataset.fixtureSelected = selectedConversation ?? '';

/**
 * Page-column frame. Mobile uses the real mobile shell class so the shell's
 * responsive page rhythm applies. Desktop keeps the shell-content box but
 * not the shell grid (the persistent sidebar is not rendered here), so the
 * fixture frame reproduces only the sidebar footprint and top-bar offset.
 */
function ShellFrame({ children }: { children: React.ReactNode }) {
  const desktop = window.innerWidth >= 1024;
  return (
    <div className={desktop ? 'fixture-desktop-shell' : 'authenticated-shell authenticated-shell--mobile'}>
      {!desktop && <MobileTopBar title="Mesajlar" />}
      <div className="shell-content">
        <div className="shell-content-frame" data-fixture-desktop={desktop ? 'true' : 'false'}>
          {children}
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <ServoraAntProvider>
    <RealtimeProvider>
      <MemoryRouter initialEntries={['/messages']}>
        <ResolvedIdentityProvider match={identityMatch} role={user.role}>
          <ShellFrame>
            <MessagingPage user={user} />
          </ShellFrame>
        </ResolvedIdentityProvider>
      </MemoryRouter>
    </RealtimeProvider>
  </ServoraAntProvider>,
);
