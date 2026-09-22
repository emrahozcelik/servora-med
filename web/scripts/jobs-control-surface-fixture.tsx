import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { JobWorkspace } from '../src/jobs/JobWorkspace';
import type { JobCardBoard, JobCardListItem } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { MobileTopBar } from '../src/shell/MobileTopBar';

const params = new URLSearchParams(window.location.search);
const fixtureCase = params.get('case') ?? 'active-list';
const role = params.get('role') === 'staff' ? 'STAFF' : 'MANAGER';

const user: CurrentUser = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: '11111111-1111-4111-8111-111111111111',
  name: role === 'STAFF' ? 'Ayşe Personel' : 'Murat Yönetici',
  email: 'fixture@servora.local',
  role,
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

const item: JobCardListItem = {
  id: 'job-fixture', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 3,
  title: 'ABC Klinik ürün teslimi', engagementKind: null, priority: 'urgent',
  dueDate: '2026-09-24', scheduledAt: null, createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-09-21T09:00:00.000Z', staffCompletedAt: '2026-09-21T08:30:00.000Z',
  customer: { id: 'customer-fixture', name: 'ABC Klinik' },
  contact: { id: 'contact-fixture', name: 'Dr. Deniz' },
  assignee: { id: user.id, name: user.name }, deliveryItemCount: 2,
  allowedCommands: [],
};

const board: JobCardBoard = {
  columns: {
    NEW: { items: [{ ...item, id: 'job-new', status: 'NEW' }], count: 1 },
    ACCEPTED: { items: [{ ...item, id: 'job-accepted', status: 'ACCEPTED' }], count: 1 },
    IN_PROGRESS: { items: [{ ...item, id: 'job-progress', status: 'IN_PROGRESS' }], count: 1 },
    WAITING_APPROVAL: { items: [item], count: 1 },
    REVISION_REQUESTED: {
      items: [{ ...item, id: 'job-revision', status: 'REVISION_REQUESTED' }], count: 1,
    },
  },
  closedCounts: { COMPLETED: 4, CANCELLED: 1 },
};

const entries: Record<string, string> = {
  'active-list': '/jobs',
  'active-board': '/jobs?view=board',
  'approval-board': '/jobs?status=WAITING_APPROVAL&view=board',
  closed: '/jobs?status=closed',
  overdue: '/jobs?overdue=true',
};

function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 64rem)').matches);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 64rem)');
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

function Shell() {
  const desktop = useDesktop();
  const menuRef = useRef<HTMLButtonElement>(null);
  return (
    <div className={`authenticated-shell authenticated-shell--${desktop ? 'desktop' : 'mobile'}`}>
      {desktop ? (
        <>
          <aside className="shell-sidebar">
            <div className="shell-sidebar-brand brand-lockup">Dünya Dental</div>
            <nav className="shell-nav" aria-label="Ana navigasyon">
              <div className="shell-nav-section"><h2>Operasyon</h2><div className="shell-nav-links">
                <a href="/jobs" aria-current="page">İşler</a><a href="/customers">Müşteriler</a>
              </div></div>
            </nav>
          </aside>
          <header className="desktop-shell-topbar">
            <button className="shell-notification-trigger" type="button" aria-label="Bildirimler">B</button>
          </header>
        </>
      ) : (
        <MobileTopBar
          title={role === 'STAFF' ? 'İşlerim' : 'İşler'}
          backTo={null}
          menuExpanded={false}
          menuControlsId="fixture-menu"
          onOpenMenu={() => undefined}
          menuTriggerRef={menuRef}
          notifications={<button className="shell-notification-trigger" type="button" aria-label="Bildirimler">B</button>}
        />
      )}
      <div className="shell-content">
        <JobWorkspace
          user={user}
          load={async () => ({ items: [item], total: 1, limit: 25, offset: 0 })}
          loadBoard={async () => board}
        />
      </div>
      {!desktop && (
        <>
          <div className="sticky-new-job"><button className="primary-button" type="button">Yeni iş</button></div>
          <nav className="mobile-bottom-nav" aria-label="Mobil ana navigasyon">
            <a className="mobile-bottom-nav-item mobile-bottom-nav-item--active" href="/jobs" aria-current="page">İşler</a>
            <a className="mobile-bottom-nav-item" href="/customers">Müşteriler</a>
            <a className="mobile-bottom-nav-item" href="/products">Ürünler</a>
            <button className="mobile-bottom-nav-item mobile-bottom-nav-menu" type="button">Menü</button>
          </nav>
        </>
      )}
    </div>
  );
}

const root = document.getElementById('jobs-control-surface-root');
if (!root) throw new Error('Jobs control-surface fixture mount is missing');

createRoot(root).render(
  <MemoryRouter initialEntries={[entries[fixtureCase] ?? entries['active-list']]}>
    <Shell />
  </MemoryRouter>,
);
