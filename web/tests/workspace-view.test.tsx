import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceView, type WorkspaceState } from '../src/App';
import type { CurrentUser, JobCard } from '../src/services/api';

const staff: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Yılmaz', email: 'staff@example.com', role: 'STAFF', mustChangePassword: false };
const manager: CurrentUser = { ...staff, id: 'manager-1', name: 'Murat Yönetici', role: 'MANAGER' };
const job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS', version: 3,
  title: 'ABC Klinik teslimi', description: null, customerId: 'customer-1', assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'high', dueDate: '2026-07-15' };

function render(user: CurrentUser, state: WorkspaceState) {
  return renderToStaticMarkup(<WorkspaceView user={user} state={state} onRetry={() => {}} />);
}

describe('WorkspaceView', () => {
  it('renders a semantic loading state', () => {
    const html = render(staff, { kind: 'loading' });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('İşleriniz yükleniyor');
  });

  it('renders distinct Staff and Manager empty states', () => {
    expect(render(staff, { kind: 'ready', jobs: [], customerNames: {} })).toContain('Henüz atanmış işiniz yok');
    expect(render(manager, { kind: 'ready', jobs: [], customerNames: {} })).toContain('Onay bekleyen iş yok');
  });

  it('shows operational JobCard data without color-only meaning', () => {
    const html = render(staff, { kind: 'ready', jobs: [job], customerNames: { 'customer-1': 'ABC Dental Klinik' } });
    expect(html).toContain('ABC Klinik teslimi');
    expect(html).toContain('ABC Dental Klinik');
    expect(html).toContain('Devam ediyor');
    expect(html).toContain('Yüksek öncelik');
    expect(html).toContain('15 Tem 2026');
  });

  it('renders forbidden and retryable errors explicitly', () => {
    expect(render(staff, { kind: 'error', code: 'FORBIDDEN', message: 'Yetkiniz yok.', retryable: false })).toContain('Bu alana erişim yetkiniz yok');
    const retry = render(staff, { kind: 'error', code: 'NETWORK_ERROR', message: 'Bağlantı kurulamadı.', retryable: true });
    expect(retry).toContain('role="alert"');
    expect(retry).toContain('Tekrar dene');
  });

  it('filters the Manager view to waiting approval jobs', () => {
    const waiting = { ...job, id: 'job-2', status: 'WAITING_APPROVAL' as const };
    const html = render(manager, { kind: 'ready', jobs: [job, waiting], customerNames: {} });
    expect(html).toContain('job-2');
    expect(html).not.toContain('job-1');
  });
});
