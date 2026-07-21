import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter } from 'react-router-dom';

import { NotificationCenter } from '../src/notifications/NotificationCenter';

const notification = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'job.revision_requested',
  title: 'Düzeltme istendi — çok uzun bir operasyon başlığı',
  body: 'Bu uzun bildirim metni 400% reflow altında satıra sarılmalı; hiçbir hassas iş kaydı veya müşteri verisi taşırmamalıdır.',
  entity: { type: 'job-card', id: '22222222-2222-4222-8222-222222222222' },
  createdAt: '2026-07-21T10:00:00.000Z',
  readAt: null,
};

window.fetch = async (input) => {
  const path = String(input);
  if (path.includes('/unread-count')) return new Response(JSON.stringify({ unreadCount: 123 }), { status: 200 });
  if (path.includes('/api/notifications?')) {
    return new Response(JSON.stringify({ items: [notification, { ...notification, id: '33333333-3333-4333-8333-333333333333', readAt: '2026-07-21T11:00:00.000Z' }], nextCursor: 'next-page' }), { status: 200 });
  }
  return new Response(JSON.stringify({ ...notification, readAt: '2026-07-21T11:00:00.000Z' }), { status: 200 });
};

const root = document.getElementById('responsive-notification-center-root');
if (root) {
  flushSync(() => createRoot(root).render(
    <MemoryRouter><div data-smoke-notification-center="true">
      <NotificationCenter identityKey="org-1:staff-1" mobile={window.innerWidth < 1024} />
    </div></MemoryRouter>,
  ));
  root.querySelector<HTMLButtonElement>('[aria-label="Bildirimler"]')?.click();
}
