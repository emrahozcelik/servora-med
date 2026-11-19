import { createRoot } from 'react-dom/client';
import { useState } from 'react';

import '../src/styles.css';
import { CustomerSearchSelect } from '../src/jobs/CustomerSearchSelect';
import { ServoraAntProvider } from '../src/ui/antd';
import type { CustomerSummary } from '../src/services/crm-api';

// Synthetic, deterministic fixture for the shared customer selector's remote
// paging, pointer and keyboard selection. The production component, provider
// and CSS are used unchanged; /api/customers is fulfilled by the smoke runner.
const root = document.getElementById('root');
if (root) {
  function Fixture() {
    const [value, setValue] = useState('');
    const [resolved, setResolved] = useState<CustomerSummary | null>(null);
    return (
      <main style={{ padding: 16, maxWidth: 560 }}>
        <div className="field-group">
          <label htmlFor="customer-search">Müşteri</label>
          <CustomerSearchSelect
            id="customer-search"
            value={value}
            onChange={setValue}
            onCustomerResolved={setResolved}
            allowClear
          />
          <span className="field-status" data-fixture-selected>
            {value ? `Seçili: ${value} — ${resolved?.name ?? 'çözümlenmedi'}` : 'Seçim yok'}
          </span>
        </div>
      </main>
    );
  }
  createRoot(root).render(
    <ServoraAntProvider>
      <Fixture />
    </ServoraAntProvider>,
  );
  document.documentElement.dataset.fixtureReady = 'true';
}
