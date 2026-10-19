import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DuplicateComparisonScreen, DuplicateCustomersScreen } from '/src/DuplicateCustomers';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider';
import '/src/styles.css';

const pair = '/customers/duplicate-review-pairs/10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002';
const path = new URLSearchParams(location.search).has('comparison') ? pair : '/customers/duplicate-candidates';

createRoot(document.getElementById('root')!).render(
  <ServoraAntProvider>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/customers/duplicate-candidates" element={<DuplicateCustomersScreen />} />
        <Route path="/customers/duplicate-review-pairs/:aId/:bId" element={<DuplicateComparisonScreen />} />
      </Routes>
    </MemoryRouter>
  </ServoraAntProvider>,
);
