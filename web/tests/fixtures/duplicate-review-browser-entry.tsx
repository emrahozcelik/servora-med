import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DuplicateComparisonScreen, DuplicateCustomersScreen } from '/src/DuplicateCustomers';
import { DuplicateReviewRegisterScreen } from '/src/DuplicateReviewRegister';
import type { CurrentUser } from '/src/services/api';
import { ResolvedIdentityProvider } from '/src/shell/resolved-identity';
import { matchRouteIdentity } from '/src/shell/route-identity';
import { RouteNavigationProvider } from '/src/shell/route-navigation-provider';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider';
import '/src/styles.css';

const manager: CurrentUser = {
  id: '10000000-0000-4000-8000-0000000000aa',
  organizationId: '10000000-0000-4000-8000-0000000000bb',
  name: 'Synthetic Manager',
  email: 'manager@browser.invalid',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true, duplicateCustomerComparison: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const pair = '/customers/duplicate-review-pairs/10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002';
const params = new URLSearchParams(location.search);
const anchor = params.get('anchor');
const initialPath = params.has('comparison') ? pair : params.has('register')
  ? `/customers/duplicate-reviews${params.get('view') === 'ALL' ? '?view=ALL' : ''}`
  : anchor
  ? `/customers/duplicate-candidates?anchorCustomerId=${encodeURIComponent(anchor)}${params.get('view') === 'ALL' ? '&view=ALL' : ''}`
  : `/customers/duplicate-candidates${params.get('view') === 'ALL' ? '?view=ALL' : ''}`;

function Routed() {
  const current = useLocation();
  return <ResolvedIdentityProvider match={matchRouteIdentity(current.pathname)} role="MANAGER">
    <RouteNavigationProvider user={manager}>
      <Routes>
        <Route path="/customers/duplicate-candidates" element={<DuplicateCustomersScreen user={manager} />} />
        <Route path="/customers/duplicate-reviews" element={<DuplicateReviewRegisterScreen user={manager} />} />
        <Route path="/customers/duplicate-review-pairs/:aId/:bId" element={<DuplicateComparisonScreen user={manager} />} />
      </Routes>
    </RouteNavigationProvider>
  </ResolvedIdentityProvider>;
}

createRoot(document.getElementById('root')!).render(
  <ServoraAntProvider>
    <MemoryRouter initialEntries={[initialPath]}>
      <Routed />
    </MemoryRouter>
  </ServoraAntProvider>,
);
